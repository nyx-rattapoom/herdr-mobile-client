import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Linking, Share } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { actionRequest, actionsFor, confirmText, describeActionError, targetName, type ActionId, type Target } from './src/live/actions';
import type { AgentAlert } from './src/live/agents';
import { AlertDeduper, formatAlert } from './src/live/alerts';
import { draftKey } from './src/live/drafts';
import { ConnectStepError, type ConnectProgress } from './src/live/connectSteps';
import { LiveSession } from './src/live/LiveSession';
import { PromptQueues } from './src/live/promptQueue';
import { Reconnector, type ReconnectState } from './src/live/resume';
import { AGENTS_URL, monitorText } from './src/live/summary';
import {
  onNotificationTap,
  postAgentNotification,
  setupNotifications,
  startBackgroundMonitoring,
  stopBackgroundMonitoring,
  type AlertTarget,
} from './src/notify';
import { resolveSelection, selectionForPane, type Selection } from './src/live/workspace';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { HostKeyScreen } from './src/screens/HostKeyScreen';
import { ActionSheet, PromptDialog, type SheetItem } from './src/screens/dialogs';
import { Composer } from './src/screens/Composer';
import { ServerFormScreen } from './src/screens/ServerFormScreen';
import { SessionsScreen, type SessionEntry, type TreeTarget } from './src/screens/SessionsScreen';
import { WorkspaceScreen } from './src/screens/WorkspaceScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SetupCard, type SetupState } from './src/screens/SetupCard';
import { ServersScreen } from './src/screens/ServersScreen';
import { Busy, MODAL_SWAP_MS, colors } from './src/screens/ui';
import type { DiscoveryResult } from './src/protocol/sessions';
import { ServerConnection, describeSshError, isRetryableSshError, probeHostKey } from './src/ssh/connection';
import { decidePin, type ForgottenPin, type HostKeyPin, type PinDecision } from './src/ssh/pinning';
import { endpointInUse, type ServerProfile } from './src/store/servers';
import { AuditLog, type AuditEntry } from './src/store/audit';
import { PaneFlags, formatUntil, nextClockTime, snoozePresets } from './src/store/paneFlags';
import { ViewedStore } from './src/store/viewed';
import { plainKv, useAccount } from './src/useAccount';

const viewedStore = new ViewedStore(plainKv);
const audit = new AuditLog(plainKv);
/** Each live session's prompt queue. */
const queues = new WeakMap<LiveSession, PromptQueues>();
/** Each live session's local pin/mute/snooze marks. */
const paneFlags = new WeakMap<LiveSession, PaneFlags>();

/** Local pin/mute/snooze items for a pane's action sheet. */
function flagItems(live: LiveSession, target: Target): SheetItem[] {
  const f = paneFlags.get(live);
  if (!f || target.kind !== 'pane') return [];
  const id = target.node.pane_id;
  const cur = f.get(id);
  return [
    cur.pinned ? { id: 'local.unpin', label: 'Unpin from the agents list' } : { id: 'local.pin', label: 'Pin to the top of the agents list' },
    cur.muted ? { id: 'local.unmute', label: 'Unmute notifications' } : { id: 'local.mute', label: 'Mute notifications' },
    f.isSnoozed(id)
      ? { id: 'local.unsnooze', label: `Un-snooze (snoozed until ${formatUntil(cur.snoozeUntil ?? 0, Date.now())})` }
      : { id: 'local.snooze', label: 'Snooze…' },
  ];
}

/** Destructive actions recorded in the audit log, with how they read there. */
const AUDITED: Partial<Record<ActionId, string>> = {
  'pane.close': 'close pane',
  'tab.close': 'close tab',
  'workspace.close': 'close workspace',
};

type Route =
  | { name: 'servers' }
  | { name: 'add' }
  | { name: 'edit'; server: ServerProfile; hasPassword: boolean }
  | { name: 'settings' }
  | { name: 'busy'; label: string }
  | { name: 'connecting'; progress: ConnectProgress }
  | {
      name: 'hostkey';
      server: ServerProfile;
      decision: Extract<PinDecision, { kind: 'unpinned' | 'mismatch' }>;
      previous: ForgottenPin | null;
    }
  | { name: 'sessions'; server: ServerProfile; entries: SessionEntry[]; herdrFound: boolean; setup?: SetupState }
  | { name: 'workspace'; parent: SessionsRoute; live: LiveSession; session: string; sel: Selection };

type SessionsRoute = Extract<Route, { name: 'sessions' }>;

/** With one running session and nothing to set up, the session list is skipped. */
const skipsSessions = (r: SessionsRoute) => !r.setup && r.entries.filter((e) => e.live).length === 1;

/** Thrown when the user cancelled the connection attempt that is still running. */
class Cancelled extends Error {}

/** How long step 6 waits for the first snapshot. */
const SNAPSHOT_TIMEOUT_MS = 20_000;
/** Request failures that may mean the SSH link died without closing (timeouts, channels that won't open). */
const SUSPECT_CODES = ['timeout', 'ERR_TIMEOUT', 'ERR_CHANNEL'];

/** The connection notice shown above a workspace while the SSH session is being replaced. */
function reconnectNotice(r: ReconnectState): string | null {
  switch (r.kind) {
    case 'idle':
      return null;
    case 'reconnecting':
      return r.error === undefined
        ? 'The SSH connection dropped. Reconnecting…'
        : `Reconnecting… The last try failed: ${describeSshError(r.error)} Trying again automatically.`;
    case 'waiting':
      return 'The SSH connection dropped. Unlock to reconnect.';
    case 'failed':
      return `Reconnecting failed: ${describeSshError(r.error)}`;
  }
}

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
  const [snoozing, setSnoozing] = useState<{ live: LiveSession; paneId: string; custom?: boolean } | null>(null);
  const conn = useRef<ServerConnection | null>(null);
  const lives = useRef<LiveSession[]>([]);
  /** Keeps the current server's SSH connection working; replaced per connection. */
  const reconnector = useRef<Reconnector | null>(null);
  const [reconnect, setReconnect] = useState<ReconnectState>({ kind: 'idle' });
  const biometricRef = useRef(account.settings.biometric);
  useEffect(() => {
    biometricRef.current = account.settings.biometric;
  }, [account.settings.biometric]);

  const routeRef = useRef<Route>(route);
  const deduper = useRef(new AlertDeduper());
  const pendingTap = useRef<AlertTarget | null>(null);
  /** Bumped by every new connection attempt and by cancel; stale attempts stop at their next step. */
  const attempt = useRef(0);
  const progress = useRef<ConnectProgress | null>(null);
  const [viewed, setViewed] = useState<Record<string, number>>({});
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  useEffect(() => {
    if (route.name === 'settings') void audit.list().then(setAuditEntries);
  }, [route.name]);
  const viewedKey = route.name === 'workspace' ? [route.parent.server.id, route.session] as const : null;
  const viewedServer = viewedKey?.[0];
  const viewedSession = viewedKey?.[1];
  useEffect(() => {
    if (!viewedServer || viewedSession === undefined) return;
    let live = true;
    void viewedStore.load(viewedServer, viewedSession).then((v) => live && setViewed(v));
    return () => {
      live = false;
    };
  }, [viewedServer, viewedSession]);
  const onViewPane = useCallback(
    (paneId: string) => {
      if (!viewedServer || viewedSession === undefined) return;
      void viewedStore.mark(viewedServer, viewedSession, paneId, Date.now()).then(setViewed);
    },
    [viewedServer, viewedSession],
  );
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
    attempt.current++;
    lives.current.forEach((l) => {
      queues.get(l)?.dispose();
      paneFlags.get(l)?.dispose();
    });
    reconnector.current?.stop();
    reconnector.current = null;
    setReconnect({ kind: 'idle' });
    lives.current.forEach((l) => l.stop());
    lives.current = [];
    conn.current?.close();
    conn.current = null;
    stopBackgroundMonitoring();
    setRoute({ name: 'servers' });
  }, []);

  /** The server profile a live view belongs to, from the current route. */
  const serverOf = (live: LiveSession): ServerProfile | null => {
    const r = routeRef.current;
    const parent = r.name === 'sessions' ? r : r.name === 'workspace' ? r.parent : null;
    return parent?.entries.some((e) => e.live === live) ? parent.server : null;
  };

  /** Posts a notification unless the user is already looking at that pane. */
  const handleAlert = useCallback((server: ServerProfile, session: string, live: LiveSession, a: AgentAlert) => {
    if (!deduper.current.accept(a, `${server.id}|${session}`)) return;
    // Muted or snoozed on this phone.
    if (paneFlags.get(live)?.isSilenced(a.paneId)) return;
    const r = routeRef.current;
    if (
      AppState.currentState === 'active' &&
      r.name === 'workspace' &&
      r.live === live &&
      resolveSelection(live.getState().tree, r.sel).pane?.pane_id === a.paneId
    )
      return;
    const ws = live.getState().tree.find((w) => w.workspace_id === a.workspaceId);
    const { title, body } = formatAlert(a, { server: server.label, session, workspaceLabel: ws?.label });
    void postAgentNotification(title, body, { serverId: server.id, session, paneId: a.paneId });
  }, []);

  /** Navigates to the pane named by a tapped notification, if it is loaded. */
  const openTarget = useCallback((t: AlertTarget): boolean => {
    const r = routeRef.current;
    const parent = r.name === 'sessions' ? r : r.name === 'workspace' ? r.parent : null;
    if (!parent || parent.server.id !== t.serverId) return false;
    const live = parent.entries.find((e) => e.session.name === t.session)?.live;
    const sel = live ? selectionForPane(live.getState().tree, t.paneId) : null;
    if (!live || !sel) return false;
    setRoute({ name: 'workspace', parent, live, session: t.session, sel });
    return true;
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'servers') return false;
      if (route.name === 'workspace' && !skipsSessions(route.parent)) setRoute(route.parent);
      else home();
      return true;
    });
    return () => sub.remove();
  }, [route, home]);

  /** Starts a live view of every running session and returns the sessions route (not yet shown). */
  /** Opens a Herdr socket over whatever SSH connection is current, so a reconnect is picked up. */
  const openSocket = useCallback((socketPath: string) => {
    const c = conn.current;
    if (!c) return Promise.reject(Object.assign(new Error('Not connected to the server.'), { code: 'ERR_NO_SESSION' }));
    return c.openHerdr(socketPath);
  }, []);

  const startSessions = useCallback((server: ServerProfile, discovery: DiscoveryResult) => {
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
      const live: LiveSession = new LiveSession(() => openSocket(session.socketPath), {
        // Retrying cannot fix an sshd that forbids socket forwarding. A dead SSH session is
        // replaced by the reconnector, and the view keeps retrying meanwhile.
        fatalCodes: ['ERR_FORWARDING_PROHIBITED'],
        // A request that hangs or can't open a channel may mean the link died silently.
        onRequestError: (e) => {
          if (SUSPECT_CODES.includes((e as { code?: string })?.code ?? '')) reconnector.current?.kick({ auto: true });
        },
        onAlert: (a) => handleAlert(server, session.name, live, a),
        onContinueAnyway: (version) =>
          void audit.record({
            server: server.label,
            target: `session ${session.name}`,
            action: `continue on old Herdr${version ? ` ${version}` : ''}`,
          }),
      });
      lives.current.push(live);
      const queue = new PromptQueues(plainKv, `${server.id}|${session.name}`, (paneId, text) =>
        live.query('agent.prompt', { target: paneId, text }).then(() => undefined),
      );
      queues.set(live, queue);
      void queue.load();
      const flags = new PaneFlags(plainKv, `${server.id}|${session.name}`);
      paneFlags.set(live, flags);
      void flags.load();
      let paneSet = '';
      live.subscribe((st) => {
        queue.drive(st.status, st.agents);
        // Forget queues of panes that were closed.
        const ids = st.snapshot ? st.snapshot.panes.map((p) => p.pane_id).sort().join(',') : '';
        if (ids && ids !== paneSet) {
          paneSet = ids;
          void queue.prune(new Set(ids.split(',')));
          void flags.prune(new Set(ids.split(',')));
        }
      });
      void live.start();
      return { session, live };
    });
    return { name: 'sessions', server, entries, herdrFound: discovery.herdrFound, setup } satisfies Route;
  }, [handleAlert, openSocket]);

  /** Shows a sessions route and handles a notification tap that arrived before it was connected. */
  const showSessions = useCallback((route: SessionsRoute) => {
    const { server, entries } = route;
    const only = skipsSessions(route) ? entries.find((e) => e.live) : undefined;
    const next: Route = only?.live ? { name: 'workspace', parent: route, live: only.live, session: only.session.name, sel: {} } : route;
    setRoute(next);
    routeRef.current = next;
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
  }, [openTarget]);

  const loadSessions = useCallback(
    async (server: ServerProfile, c: ServerConnection) => showSessions(startSessions(server, await c.discoverSessions(server.herdrPath))),
    [showSessions, startSessions],
  );

  /**
   * Supervises the connection to `server`. When the SSH session dies, a new one is
   * opened in place with the pinned key, retrying with backoff, and every live view retries over
   * it. The screen, selection, last output and scroll positions stay as they were.
   */
  const superviseConnection = useCallback(
    (server: ServerProfile) => {
      reconnector.current?.stop();
      setReconnect({ kind: 'idle' });
      const r: Reconnector = new Reconnector({
        current: () => conn.current,
        reopen: async () => {
          const pin = await pins.get(server.host, server.port);
          if (!pin) throw new Error('The host key is no longer pinned; reconnect from the server list.');
          return ServerConnection.open({ ...server, ...(await credentialsFor(server)) }, pin);
        },
        install: (next) => {
          conn.current = next as ServerConnection;
        },
        lives: () => lives.current,
        isFatal: (e) => !isRetryableSshError(e),
        // Biometric-protected credentials can only be unlocked in the foreground.
        canReopen: () => AppState.currentState === 'active' || !biometricRef.current,
        onState: (st) => reconnector.current === r && setReconnect(st),
      });
      reconnector.current = r;
    },
    [pins, credentialsFor],
  );

  /** Runs one connect step: shows it, and names it in the error if it fails. */
  const step = useCallback(async <T,>(id: number, n: number, fn: () => Promise<T>, note?: (r: T) => string | undefined): Promise<T> => {
    if (id !== attempt.current || !progress.current) throw new Cancelled();
    progress.current = { ...progress.current, step: n };
    setRoute({ name: 'connecting', progress: progress.current });
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      if (e instanceof Cancelled || id !== attempt.current) throw new Cancelled();
      throw new ConnectStepError(n, e, describeSshError(e));
    }
    if (id !== attempt.current) throw new Cancelled();
    const text = note?.(result);
    if (text) progress.current = { ...progress.current, notes: { ...progress.current.notes, [n]: text } };
    return result;
  }, []);

  /** Steps 3–6 of CONNECT_STEPS, after the host key is known to match. */
  const connectPinned = useCallback(
    async (server: ServerProfile, pin: HostKeyPin, id: number) => {
      const c = await step(id, 2, async () => {
        const creds = await credentialsFor(server);
        return ServerConnection.open({ ...server, ...creds }, pin);
      });
      if (id !== attempt.current) {
        c.close();
        throw new Cancelled();
      }
      conn.current = c;
      superviseConnection(server);
      await step(id, 3, () => c.herdrVersion(server.herdrPath), (v) => (v ? `herdr ${v}` : 'not installed'));
      const route = await step(
        id,
        4,
        async () => startSessions(server, await c.discoverSessions(server.herdrPath)),
        (r) => `${r.entries.length} session${r.entries.length === 1 ? '' : 's'}`,
      );
      const first = route.entries.find((e) => e.live)?.live;
      if (first) {
        await step(id, 5, async () => {
          const st = await first.whenSettled(SNAPSHOT_TIMEOUT_MS);
          if (st.status === 'connecting') throw new Error(`no snapshot after ${SNAPSHOT_TIMEOUT_MS / 1000} s`);
          if (st.status === 'offline' || st.status === 'reconnecting') throw new Error(st.error ?? st.status);
        });
      }
      showSessions(route);
    },
    [credentialsFor, startSessions, showSessions, step, superviseConnection],
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
    if (e instanceof Cancelled) return;
    reconnector.current?.stop();
    reconnector.current = null;
    setReconnect({ kind: 'idle' });
    lives.current.forEach((l) => l.stop());
    lives.current = [];
    conn.current?.close();
    conn.current = null;
    setError(describeSshError(e));
    setRoute({ name: 'servers' });
  }, []);

  // Back in the foreground: check the connection now, even after a failure that needed the user.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reconnector.current?.kick();
    });
    return () => sub.remove();
  }, []);

  /** The current server's sessions, while connected. */
  const liveList = route.name === 'workspace' ? route.parent.entries : route.name === 'sessions' ? route.entries : null;

  // The ongoing notification summarises agent statuses on this server while connected.
  const monitorServer = route.name === 'workspace' ? route.parent.server.label : route.name === 'sessions' ? route.server.label : null;
  const link = reconnect.kind === 'idle' ? 'up' : reconnect.kind;
  useEffect(() => {
    if (!monitorServer || !liveList) return;
    let last = '';
    const refresh = () => {
      const text = monitorText(
        monitorServer,
        liveList.flatMap((e) => (e.live ? [e.live.getState().agents] : [])),
        link,
      );
      if (text === last) return;
      last = text;
      startBackgroundMonitoring(text);
    };
    refresh();
    const subs = liveList.flatMap((e) => (e.live ? [e.live.subscribe(refresh)] : []));
    return () => subs.forEach((u) => u());
  }, [monitorServer, liveList, link]);

  // Tapping the ongoing notification opens the agents sheet.
  const [agentsRequest, setAgentsRequest] = useState(0);
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url !== AGENTS_URL) return;
      const r = routeRef.current;
      if (r.name === 'sessions') {
        const first = r.entries.find((e) => e.live);
        if (!first?.live) return;
        setRoute({ name: 'workspace', parent: r, live: first.live, session: first.session.name, sel: {} });
      } else if (r.name !== 'workspace') {
        return;
      }
      setAgentsRequest((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // A live view that lost its SSH session, in the foreground or not, has the connection replaced.
  // A closed subscription is checked too: it arrives as a native event, while the view's own
  // retry (which would report ERR_NO_SESSION) needs a JS timer, and those stop with the screen.
  useEffect(() => {
    const subs = (liveList ?? []).flatMap((e) =>
      e.live
        ? [
            e.live.subscribe((st) => {
              if (st.errorCode === 'ERR_NO_SESSION' || st.errorCode === 'closed') reconnector.current?.kick({ auto: true });
            }),
          ]
        : [],
    );
    return () => subs.forEach((u) => u());
  }, [liveList]);

  const open = useCallback(
    async (server: ServerProfile) => {
      setError(null);
      const id = ++attempt.current;
      progress.current = { step: 0, target: `${server.username}@${server.host}:${server.port}`, startedAt: Date.now(), notes: {} };
      try {
        const presented = await step(id, 0, () => probeHostKey(server.host, server.port), (k) => k.algorithm);
        // A mismatch is not an error here: the host key screen explains it.
        const decision = await step(
          id,
          1,
          async () => decidePin(await pins.get(server.host, server.port), presented),
          (d) => (d.kind === 'match' ? 'pinned' : d.kind === 'unpinned' ? 'new key' : 'changed!'),
        );
        if (decision.kind === 'match') return await connectPinned(server, decision.pin, id);
        setRoute({ name: 'hostkey', server, decision, previous: await pins.previous(server.host, server.port) });
      } catch (e) {
        fail(e);
      }
    },
    [pins, connectPinned, fail, step],
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
        await connectPinned(server, pin, attempt.current);
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
              // Pins belong to host:port; keep them while another profile still uses that endpoint.
              if (!endpointInUse(await servers.list(), server.host, server.port)) await pins.purge(server.host, server.port);
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
      const res = await live.request<{ tab?: { tab_id?: string }; workspace?: { workspace_id?: string } }>(req.method, req.params);
      // Show what was just created; Herdr was asked not to focus it.
      const sel: Selection | null =
        action === 'tab.create' && res?.tab?.tab_id
          ? { workspaceId: target.kind === 'workspace' ? target.node.workspace_id : undefined, tabId: res.tab.tab_id }
          : action === 'workspace.create' && res?.workspace?.workspace_id
            ? { workspaceId: res.workspace.workspace_id }
            : null;
      if (sel) setRoute((r) => (r.name === 'workspace' && r.live === live ? { ...r, sel } : r));
      const what = AUDITED[action];
      const server = serverOf(live);
      if (what && server) void audit.record({ server: server.label, target: targetName(target), action: what });
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
        // After the sheet this came from has closed (see MODAL_SWAP_MS).
        setTimeout(() => setPrompt({ live, target, action: id, title: `${def.label} (optional name)` }), MODAL_SWAP_MS);
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
          secureScreen={account.settings.secureScreen}
          onToggleSecureScreen={(on) => void settingsAction(() => account.setSecureScreen(on))}
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
          audit={auditEntries}
          onClearAudit={() =>
            Alert.alert('Clear activity log', 'Delete every recorded action on this device?', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Clear',
                style: 'destructive',
                onPress: () => void audit.clear().then(() => setAuditEntries([])),
              },
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
    case 'connecting':
      screen = <ConnectScreen progress={route.progress} onCancel={home} />;
      break;
    case 'hostkey':
      screen = (
        <HostKeyScreen
          server={route.server}
          decision={route.decision}
          previous={route.previous}
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
          onOpenSession={(session) => {
            const live = route.entries.find((e) => e.session.name === session)?.live;
            if (live) setRoute({ name: 'workspace', parent: route, live, session, sel: {} });
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
    case 'workspace': {
      const r = route;
      const agentOf = (paneId: string) => r.live.getState().agents.get(paneId);
      screen = (
        <WorkspaceScreen
          live={r.live}
          session={r.session}
          host={`${r.parent.server.username}@${r.parent.server.host}`}
          sel={r.sel}
          onSelect={(sel) => setRoute((cur) => (cur.name === 'workspace' && cur.live === r.live ? { ...cur, sel } : cur))}
          onBack={() => (skipsSessions(r.parent) ? home() : setRoute(r.parent))}
          onReconnect={() => reconnector.current?.kick()}
          notice={reconnectNotice(reconnect)}
          agentsRequest={agentsRequest}
          flags={paneFlags.get(r.live)}
          viewed={viewed}
          onViewPane={onViewPane}
          onAction={(target) => setSheet({ live: r.live, target })}
          onPick={(target, id) => pickAction(r.live, target, id)}
          footer={(paneId, pokeNow, blank, screen) => (
            <Composer
              key={paneId}
              live={r.live}
              paneId={paneId}
              draftKey={draftKey(r.parent.server.id, r.session, paneId)}
              hasAgent={Boolean(agentOf(paneId)?.agent ?? r.live.getState().snapshot?.panes.find((p) => p.pane_id === paneId)?.agent)}
              agentBlocked={agentOf(paneId)?.status === 'blocked'}
              onSent={pokeNow}
              paneBlank={blank}
              screen={screen}
              agentName={agentOf(paneId)?.agent}
              queue={queues.get(r.live)}
              agentStatus={agentOf(paneId)?.status}
              onAnswered={(label) =>
                void audit.record({ server: r.parent.server.label, target: `pane ${paneId}`, action: `quick answer: ${label}` })
              }
            />
          )}
        />
      );
      break;
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="light" />
        {screen}
        {sheet ? (
          <ActionSheet
            title={targetName(sheet.target)}
            items={[...flagItems(sheet.live, sheet.target), ...actionsFor(sheet.target)]}
            onPick={(id) => {
              const f = paneFlags.get(sheet.live);
              const paneId = sheet.target.kind === 'pane' ? sheet.target.node.pane_id : null;
              if (!id.startsWith('local.') || !f || !paneId) return pickAction(sheet.live, sheet.target, id as ActionId);
              setSheet(null);
              if (id === 'local.pin' || id === 'local.unpin') void f.setPinned(paneId, id === 'local.pin');
              else if (id === 'local.mute' || id === 'local.unmute') void f.setMuted(paneId, id === 'local.mute');
              else if (id === 'local.unsnooze') void f.unsnooze(paneId);
              else if (id === 'local.snooze') {
                const live = sheet.live;
                setTimeout(() => setSnoozing({ live, paneId }), MODAL_SWAP_MS);
              }
            }}
            onClose={() => setSheet(null)}
          />
        ) : null}
        {snoozing && !snoozing.custom ? (
          <ActionSheet
            title={`Snooze ${snoozing.paneId}: hide it from the agents list and silence it until…`}
            items={[...snoozePresets(Date.now()).map((p) => ({ id: p.id, label: p.label })), { id: 'custom', label: 'Until a time…' }]}
            onPick={(id) => {
              if (id === 'custom') {
                const next = { ...snoozing, custom: true };
                setSnoozing(null);
                setTimeout(() => setSnoozing(next), MODAL_SWAP_MS);
                return;
              }
              const preset = snoozePresets(Date.now()).find((p) => p.id === id);
              if (preset) void paneFlags.get(snoozing.live)?.snooze(snoozing.paneId, preset.until);
              setSnoozing(null);
            }}
            onClose={() => setSnoozing(null)}
          />
        ) : null}
        {snoozing?.custom ? (
          <PromptDialog
            title={`Snooze ${snoozing.paneId} until (HH:MM, 24-hour)`}
            placeholder="e.g. 18:30"
            okLabel="Snooze"
            onClose={() => setSnoozing(null)}
            onSubmit={(value) => {
              const until = nextClockTime(value, Date.now());
              if (until === null) {
                Alert.alert('Snooze', 'Enter a time like 18:30.');
                return;
              }
              void paneFlags.get(snoozing.live)?.snooze(snoozing.paneId, until);
              setSnoozing(null);
            }}
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
