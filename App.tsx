import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Share } from 'react-native';
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
import { HostKeyScreen } from './src/screens/HostKeyScreen';
import { ActionSheet, PromptDialog } from './src/screens/dialogs';
import { InputBar } from './src/screens/InputBar';
import { PaneScreen } from './src/screens/PaneScreen';
import { ServerFormScreen } from './src/screens/ServerFormScreen';
import { SessionsScreen, type SessionEntry, type TreeTarget } from './src/screens/SessionsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SetupCard, type SetupState } from './src/screens/SetupCard';
import { ServersScreen } from './src/screens/ServersScreen';
import { Busy, colors } from './src/screens/ui';
import { ServerConnection, describeSshError, probeHostKey } from './src/ssh/connection';
import { decidePin, type HostKeyPin, type PinDecision } from './src/ssh/pinning';
import type { ServerProfile } from './src/store/servers';
import { useAccount } from './src/useAccount';

type Route =
  | { name: 'servers' }
  | { name: 'add' }
  | { name: 'edit'; server: ServerProfile; hasPassword: boolean }
  | { name: 'settings' }
  | { name: 'busy'; label: string }
  | { name: 'hostkey'; server: ServerProfile; decision: Extract<PinDecision, { kind: 'unpinned' | 'mismatch' }> }
  | { name: 'sessions'; server: ServerProfile; entries: SessionEntry[]; herdrFound: boolean; setup?: SetupState }
  | { name: 'pane'; parent: Extract<Route, { name: 'sessions' }>; live: LiveSession; pane: PaneNode };

export default function App() {
  const account = useAccount();
  const { servers, pins, credentialsFor, hasPassword } = account;
  const [list, setList] = useState<ServerProfile[]>([]);
  const [route, setRoute] = useState<Route>({ name: 'servers' });
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ live: LiveSession; target: Target } | null>(null);
  const [manageSheet, setManageSheet] = useState<ServerProfile | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<{ error: string | null; notice: string | null }>({ error: null, notice: null });
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
    const discovery = await c.discoverSessions(server.herdrPath);
    lives.current.forEach((l) => l.stop());
    lives.current = [];
    // Without a working herdr there is nothing to subscribe to: offer install or start instead.
    const running = discovery.herdrFound ? discovery.sessions.filter((x) => x.running) : [];
    const setup: SetupState | undefined = !discovery.herdrBin
      ? { kind: 'install' }
      : running.length === 0
        ? { kind: 'start' }
        : undefined;
    const entries: SessionEntry[] = (discovery.herdrFound ? discovery.sessions : []).map((session) => {
      if (!session.running) return { session };
      const live: LiveSession = new LiveSession(() => c.openHerdr(session.socketPath), {
        // Retrying cannot fix a dead SSH session or an sshd that forbids socket forwarding.
        fatalCodes: ['ERR_NO_SESSION', 'ERR_FORWARDING_PROHIBITED'],
        onAlert: (a) => handleAlert(server, session.name, live, a),
      });
      lives.current.push(live);
      void live.start();
      return { session, live };
    });
    const route: Route = { name: 'sessions', server, entries, herdrFound: discovery.herdrFound, setup };
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
      const creds = await credentialsFor(server);
      const c = await ServerConnection.open({ ...server, ...creds }, pin);
      conn.current = c;
      setRoute({ name: 'busy', label: 'Loading Herdr sessions…' });
      await loadSessions(server, c);
    },
    [credentialsFor, loadSessions],
  );

  /** Runs the official installer (if needed) and starts a server, then reloads the session list. */
  const runSetup = useCallback(
    async (server: ServerProfile, kind: SetupState['kind']) => {
      const c = conn.current;
      if (!c) return;
      const setSetup = (setup: SetupState) =>
        setRoute((r) => (r.name === 'sessions' && r.server.id === server.id ? { ...r, setup } : r));
      setSetup({ kind, busy: true });
      try {
        if (kind === 'install') {
          const res = await c.installHerdr();
          if (!res.ok) return setSetup({ kind, error: res.reason });
        }
        const started = await c.startHerdr(server.herdrPath);
        if (!started.ok) return setSetup({ kind: 'start', error: started.reason });
        await loadSessions(server, c);
      } catch (e) {
        setSetup({ kind, error: describeSshError(e) });
      }
    },
    [loadSessions],
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

  const pickManage = useCallback(
    async (server: ServerProfile, id: string) => {
      setManageSheet(null);
      if (id === 'edit') {
        setRoute({ name: 'edit', server, hasPassword: await hasPassword(server.id) });
      } else if (id === 'forget') {
        Alert.alert('Forget host key', `The next connection to ${server.host}:${server.port} will ask you to verify its fingerprint again.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Forget', style: 'destructive', onPress: () => void pins.forget(server.host, server.port) },
        ]);
      } else if (id === 'remove') {
        Alert.alert('Remove server', `Remove ${server.label} and its saved password and host key?`, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              await servers.remove(server.id);
              await pins.forget(server.host, server.port);
              reload();
            },
          },
        ]);
      }
    },
    [hasPassword, pins, servers, reload],
  );

  const settingsAction = useCallback(async (fn: () => Promise<void>, notice: string | null = null) => {
    setSettingsMsg({ error: null, notice: null });
    try {
      await fn();
      setSettingsMsg({ error: null, notice });
    } catch (e) {
      setSettingsMsg({ error: e instanceof Error ? e.message : String(e), notice: null });
    }
  }, []);

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
        <ServersScreen
          servers={list}
          error={error}
          onAdd={() => setRoute({ name: 'add' })}
          onOpen={open}
          onManage={setManageSheet}
          onSettings={() => {
            setSettingsMsg({ error: null, notice: null });
            setRoute({ name: 'settings' });
          }}
        />
      );
      break;
    case 'add':
    case 'edit':
      screen = (
        <ServerFormScreen
          key={route.name === 'edit' ? route.server.id : 'new'}
          initial={route.name === 'edit' ? route.server : undefined}
          hasSavedPassword={route.name === 'edit' && route.hasPassword}
          devicePublicKey={account.publicKey}
          onShowKey={() => setRoute({ name: 'settings' })}
          onCancel={home}
          onSave={async (input, opts) => {
            if (route.name === 'edit') await servers.update(route.server.id, input, opts);
            else await servers.add(input);
            await reload();
            setRoute({ name: 'servers' });
          }}
        />
      );
      break;
    case 'settings':
      screen = (
        <SettingsScreen
          publicKey={account.publicKey}
          biometric={account.settings.biometric}
          biometricAvailable={account.biometricAvailable}
          error={settingsMsg.error}
          notice={settingsMsg.notice}
          onBack={home}
          onCreateKey={() => void settingsAction(account.createKey, 'Device key created.')}
          onCopyKey={() =>
            void settingsAction(async () => {
              if (account.publicKey) await Clipboard.setStringAsync(account.publicKey);
            }, 'Public key copied.')
          }
          onShareKey={() =>
            void settingsAction(async () => {
              if (account.publicKey) await Share.share({ message: account.publicKey });
            })
          }
          onRegenerateKey={() =>
            Alert.alert('Regenerate device key', 'Servers that trust the current key will reject this device until you add the new public key.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Regenerate', style: 'destructive', onPress: () => void settingsAction(account.regenerateKey, 'New device key created.') },
            ])
          }
          onToggleBiometric={(on) =>
            void settingsAction(() => account.setBiometric(on), on ? 'Credentials now require biometrics.' : 'Biometric protection turned off.')
          }
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
          banner={
            route.setup ? (
              <SetupCard
                state={route.setup}
                host={route.server.host}
                user={route.server.username}
                onInstall={() => void runSetup(route.server, 'install')}
                onStart={() => void runSetup(route.server, 'start')}
              />
            ) : undefined
          }
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
              agentBlocked={route.live.getState().agents.get(route.pane.pane_id)?.status === 'blocked'}
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
        {manageSheet ? (
          <ActionSheet
            title={`${manageSheet.label} · ${manageSheet.username}@${manageSheet.host}:${manageSheet.port}`}
            items={[
              { id: 'edit', label: 'Edit server' },
              { id: 'forget', label: 'Forget host key' },
              { id: 'remove', label: 'Remove server', destructive: true },
            ]}
            onPick={(id) => void pickManage(manageSheet, id)}
            onClose={() => setManageSheet(null)}
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
