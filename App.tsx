import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, BackHandler } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { actionRequest, actionsFor, confirmText, describeActionError, targetName, type ActionId, type Target } from './src/live/actions';
import type { AgentAlert } from './src/live/agents';
import { AlertDeduper, formatAlert } from './src/live/alerts';
import { LiveSession } from './src/live/LiveSession';
import {
  onNotificationTap,
  postAgentNotification,
  setupNotifications,
  startBackgroundMonitoring,
  stopBackgroundMonitoring,
  type AlertTarget,
} from './src/notify';
import type { PaneNode } from './src/protocol/snapshot';
import { AddServerScreen } from './src/screens/AddServerScreen';
import { HostKeyScreen } from './src/screens/HostKeyScreen';
import { ActionSheet, PromptDialog } from './src/screens/dialogs';
import { InputBar } from './src/screens/InputBar';
import { PaneScreen } from './src/screens/PaneScreen';
import { SessionsScreen, type SessionEntry, type TreeTarget } from './src/screens/SessionsScreen';
import { ServersScreen } from './src/screens/ServersScreen';
import { Busy, colors } from './src/screens/ui';
import { ServerConnection, describeSshError, probeHostKey } from './src/ssh/connection';
import { PinStore, decidePin, type HostKeyPin, type KeyValueStore, type PinDecision } from './src/ssh/pinning';
import { ServerStore, type ServerProfile } from './src/store/servers';

const secureKv: KeyValueStore = {
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItem: (k) => SecureStore.deleteItemAsync(k),
};

type Route =
  | { name: 'servers' }
  | { name: 'add' }
  | { name: 'busy'; label: string }
  | { name: 'hostkey'; server: ServerProfile; decision: Extract<PinDecision, { kind: 'unpinned' | 'mismatch' }> }
  | { name: 'sessions'; server: ServerProfile; entries: SessionEntry[]; herdrFound: boolean }
  | { name: 'pane'; parent: Extract<Route, { name: 'sessions' }>; live: LiveSession; pane: PaneNode };

export default function App() {
  const servers = useMemo(() => new ServerStore(secureKv), []);
  const pins = useMemo(() => new PinStore(secureKv), []);
  const [list, setList] = useState<ServerProfile[]>([]);
  const [route, setRoute] = useState<Route>({ name: 'servers' });
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ live: LiveSession; target: Target } | null>(null);
  const [prompt, setPrompt] = useState<{ live: LiveSession; target: Target; action: ActionId; title: string } | null>(null);
  const conn = useRef<ServerConnection | null>(null);
  const lives = useRef<LiveSession[]>([]);
  const routeRef = useRef<Route>(route);
  const deduper = useRef(new AlertDeduper());
  const pendingTap = useRef<AlertTarget | null>(null);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  const reload = useCallback(() => servers.list().then(setList), [servers]);
  useEffect(() => {
    reload();
  }, [reload]);

  // Channel + permission before any alert can fire (Android 13+ asks once).
  useEffect(() => {
    void setupNotifications();
  }, []);

  const home = useCallback(() => {
    lives.current.forEach((l) => l.stop());
    lives.current = [];
    conn.current?.close();
    conn.current = null;
    stopBackgroundMonitoring();
    setRoute({ name: 'servers' });
  }, []);

  /** Posts a notification unless the user is already looking at that pane. */
  const handleAlert = useCallback((server: ServerProfile, session: string, live: LiveSession, a: AgentAlert) => {
    if (!deduper.current.accept(a, `${server.id}|${session}`)) return;
    const r = routeRef.current;
    if (AppState.currentState === 'active' && r.name === 'pane' && r.live === live && r.pane.pane_id === a.paneId) return;
    const ws = live.getState().tree.find((w) => w.workspace_id === a.workspaceId);
    const { title, body } = formatAlert(a, { server: server.label, session, workspaceLabel: ws?.label });
    void postAgentNotification(title, body, { serverId: server.id, session, paneId: a.paneId });
  }, []);

  /** Navigates to the pane named by a tapped notification, if it is loaded. */
  const openTarget = useCallback((t: AlertTarget): boolean => {
    const r = routeRef.current;
    const parent = r.name === 'sessions' ? r : r.name === 'pane' ? r.parent : null;
    if (!parent || parent.server.id !== t.serverId) return false;
    const live = parent.entries.find((e) => e.session.name === t.session)?.live;
    const pane = live?.getState().snapshot?.panes.find((p) => p.pane_id === t.paneId);
    if (!live || !pane) return false;
    setRoute({ name: 'pane', parent, live, pane });
    return true;
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'servers') return false;
      if (route.name === 'pane') setRoute(route.parent);
      else home();
      return true;
    });
    return () => sub.remove();
  }, [route, home]);

  const loadSessions = useCallback(async (server: ServerProfile, c: ServerConnection) => {
    const discovery = await c.discoverSessions();
    lives.current.forEach((l) => l.stop());
    lives.current = [];
    const entries: SessionEntry[] = discovery.sessions.map((session) => {
      if (!session.running) return { session };
      const live: LiveSession = new LiveSession(() => c.openHerdr(session.socketPath), {
        onAlert: (a) => handleAlert(server, session.name, live, a),
      });
      lives.current.push(live);
      void live.start();
      return { session, live };
    });
    const route: Route = { name: 'sessions', server, entries, herdrFound: discovery.herdrFound };
    setRoute(route);
    routeRef.current = route;
    startBackgroundMonitoring(`Watching agents on ${server.label}`);
    // A notification tap that arrived before this server was connected.
    const tap = pendingTap.current;
    if (tap?.serverId === server.id) {
      pendingTap.current = null;
      const target = entries.find((e) => e.session.name === tap.session)?.live;
      if (target) {
        const unsub = target.subscribe(() => {
          if (openTarget(tap)) unsub();
        });
      }
    }
  }, [handleAlert, openTarget]);

  const connectPinned = useCallback(
    async (server: ServerProfile, pin: HostKeyPin) => {
      setRoute({ name: 'busy', label: 'Authenticating…' });
      const password = await servers.password(server.id);
      if (!password) throw new Error('No saved password for this server');
      const c = await ServerConnection.open({ ...server, password }, pin);
      conn.current = c;
      setRoute({ name: 'busy', label: 'Loading Herdr sessions…' });
      await loadSessions(server, c);
    },
    [servers, loadSessions],
  );

  const fail = useCallback((e: unknown) => {
    conn.current?.close();
    conn.current = null;
    setError(describeSshError(e));
    setRoute({ name: 'servers' });
  }, []);

  const open = useCallback(
    async (server: ServerProfile) => {
      setError(null);
      setRoute({ name: 'busy', label: `Checking host key of ${server.host}…` });
      try {
        const presented = await probeHostKey(server.host, server.port);
        const decision = decidePin(await pins.get(server.host, server.port), presented);
        if (decision.kind === 'match') return await connectPinned(server, decision.pin);
        setRoute({ name: 'hostkey', server, decision });
      } catch (e) {
        fail(e);
      }
    },
    [pins, connectPinned, fail],
  );

  useEffect(
    () =>
      onNotificationTap((t) => {
        if (openTarget(t)) return;
        const server = list.find((x) => x.id === t.serverId);
        if (!server) return;
        pendingTap.current = t;
        const r = routeRef.current;
        if (r.name === 'servers') void open(server);
      }),
    [list, open, openTarget],
  );

  const trust = useCallback(
    async (server: ServerProfile, decision: PinDecision) => {
      if (decision.kind !== 'unpinned') return;
      try {
        const pin = await pins.pin(server.host, server.port, decision.presented);
        await connectPinned(server, pin);
      } catch (e) {
        fail(e);
      }
    },
    [pins, connectPinned, fail],
  );

  const manage = useCallback(
    (server: ServerProfile) => {
      Alert.alert(server.label, `${server.username}@${server.host}:${server.port}`, [
        {
          text: 'Forget host key',
          onPress: () => pins.forget(server.host, server.port),
        },
        {
          text: 'Remove server',
          style: 'destructive',
          onPress: async () => {
            await servers.remove(server.id);
            await pins.forget(server.host, server.port);
            reload();
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [pins, servers, reload],
  );

  const runAction = useCallback(async (live: LiveSession, target: Target, action: ActionId, label?: string) => {
    try {
      const req = actionRequest(action, target, { label });
      await live.request(req.method, req.params);
    } catch (e) {
      Alert.alert('Action failed', describeActionError(e));
    }
  }, []);

  const pickAction = useCallback(
    (live: LiveSession, target: Target, id: ActionId) => {
      setSheet(null);
      const def = actionsFor(target).find((a) => a.id === id);
      if (!def) return;
      if (def.asksLabel) {
        setPrompt({ live, target, action: id, title: `${def.label} (optional name)` });
      } else if (def.destructive) {
        Alert.alert(def.label, confirmText(def, target), [
          { text: 'Cancel', style: 'cancel' },
          { text: def.label, style: 'destructive', onPress: () => void runAction(live, target, id) },
        ]);
      } else {
        void runAction(live, target, id);
      }
    },
    [runAction],
  );

  const onTreeAction = useCallback((entries: SessionEntry[], t: TreeTarget) => {
    const live = entries.find((e) => e.session.name === t.session)?.live;
    if (!live) return;
    const target: Target = t.kind === 'session' ? { kind: 'session' } : ({ kind: t.kind, node: t.node } as Target);
    setSheet({ live, target });
  }, []);

  let screen;
  switch (route.name) {
    case 'servers':
      screen = (
        <ServersScreen servers={list} error={error} onAdd={() => setRoute({ name: 'add' })} onOpen={open} onManage={manage} />
      );
      break;
    case 'add':
      screen = (
        <AddServerScreen
          onCancel={home}
          onSave={async (input) => {
            await servers.add(input);
            await reload();
            setRoute({ name: 'servers' });
          }}
        />
      );
      break;
    case 'busy':
      screen = <Busy label={route.label} />;
      break;
    case 'hostkey':
      screen = (
        <HostKeyScreen
          server={route.server}
          decision={route.decision}
          onCancel={home}
          onTrust={() => trust(route.server, route.decision)}
        />
      );
      break;
    case 'sessions':
      screen = (
        <SessionsScreen
          title={route.server.label}
          entries={route.entries}
          herdrFound={route.herdrFound}
          onOpenPane={(session, pane) => {
            const live = route.entries.find((e) => e.session.name === session)?.live;
            if (live) setRoute({ name: 'pane', parent: route, live, pane });
          }}
          onAction={(t) => onTreeAction(route.entries, t)}
          onBack={home}
          onReconnect={() => {
            const server = route.server;
            home();
            void open(server);
          }}
        />
      );
      break;
    case 'pane':
      screen = (
        <PaneScreen
          live={route.live}
          paneId={route.pane.pane_id}
          title={`${route.pane.pane_id} ${route.pane.terminal_title_stripped ?? ''}`.trim()}
          onBack={() => setRoute(route.parent)}
          footer={(pokeNow) => (
            <InputBar
              live={route.live}
              paneId={route.pane.pane_id}
              hasAgent={Boolean(route.live.getState().agents.get(route.pane.pane_id)?.agent ?? route.pane.agent)}
              onSent={pokeNow}
            />
          )}
        />
      );
      break;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="light" />
        {screen}
        {sheet ? (
          <ActionSheet
            title={targetName(sheet.target)}
            items={actionsFor(sheet.target)}
            onPick={(id) => pickAction(sheet.live, sheet.target, id as ActionId)}
            onClose={() => setSheet(null)}
          />
        ) : null}
        {prompt ? (
          <PromptDialog
            title={prompt.title}
            placeholder="leave empty for default"
            onClose={() => setPrompt(null)}
            onSubmit={(label) => {
              setPrompt(null);
              void runAction(prompt.live, prompt.target, prompt.action, label);
            }}
          />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
