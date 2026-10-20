import { HerdrApiError, type HerdrClient, type HerdrEvent } from '../protocol/client';
import { buildTree, fetchSnapshot, type SessionSnapshot, type WorkspaceNode } from '../protocol/snapshot';
import { checkVersion, parseUnknownVariant, ping, type ServerInfo } from '../protocol/version';
import { agentAlerts, agentsFromSnapshot, type AgentAlert, type AgentMap } from './agents';

/** Lifecycle events that can change the workspace → tab → pane tree. */
export const TREE_EVENTS = [
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'workspace.focused',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
] as const;

/** `unsupported`: the server's Herdr is too old or rejected a request as malformed; no retries. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'unsupported';

export type LiveState = {
  status: LiveStatus;
  error?: string;
  /** Code of the error behind `error`, e.g. `ERR_NO_SESSION` when the SSH session is gone. */
  errorCode?: string;
  /** From `ping` on connect. */
  server?: ServerInfo;
  /** Event types this server rejected and that are no longer subscribed to. */
  droppedEvents?: string[];
  snapshot?: SessionSnapshot;
  tree: WorkspaceNode[];
  agents: AgentMap;
  /**
   * pane_id → when the phone saw that agent's status change (ms since epoch). 0 for statuses
   * already present at the first snapshot, whose start time is unknown.
   */
  since: Map<string, number>;
};

export type LiveOptions = {
  /** Coalesces bursts of events into one snapshot read. */
  debounceMs?: number;
  /** Reconnect backoff: base delay, doubled per attempt up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Errors from `open` with these codes mean the SSH session is gone; stop retrying. */
  fatalCodes?: string[];
  onAlert?: (a: AgentAlert) => void;
  /** Clock for status-change times; tests replace it. */
  now?: () => number;
  /** Every failed request, so the owner can check whether the SSH session behind it still works. */
  onRequestError?: (e: unknown) => void;
  /** Called when the user chooses to connect to a server older than the minimum. */
  onContinueAnyway?: (version?: string) => void;
};

/**
 * Keeps a live view of one Herdr session: subscribes to lifecycle and per-pane agent-status
 * events, and treats events as cache invalidation followed by an authoritative
 * `session.snapshot` read, as Herdr's socket docs prescribe.
 */
export class LiveSession {
  private state: LiveState = { status: 'connecting', tree: [], agents: new Map(), since: new Map() };
  private listeners = new Set<(s: LiveState) => void>();
  private sub: HerdrClient | null = null;
  private subscribedPanes = '';
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private attempt = 0;
  /** Bumped by retryNow(); work started by an earlier attempt can no longer change the state. */
  private gen = 0;
  private stopped = false;
  /** Set by continueAnyway(): skip the version check. */
  private allowOld = false;
  /** Event types the server rejected; not subscribed to again. */
  private dropped = new Set<string>();
  /** The first snapshot is a baseline: agents already blocked when we connect don't alert. */
  private baselined = false;
  private readonly opts: Required<Omit<LiveOptions, 'onAlert' | 'onContinueAnyway' | 'onRequestError'>> &
    Pick<LiveOptions, 'onAlert' | 'onContinueAnyway' | 'onRequestError'>;

  constructor(
    private readonly open: () => Promise<HerdrClient>,
    opts: LiveOptions = {},
  ) {
    this.opts = {
      debounceMs: opts.debounceMs ?? 250,
      retryMs: opts.retryMs ?? 1000,
      maxRetryMs: opts.maxRetryMs ?? 15_000,
      fatalCodes: opts.fatalCodes ?? ['ERR_NO_SESSION'],
      onAlert: opts.onAlert,
      now: opts.now ?? Date.now,
      onContinueAnyway: opts.onContinueAnyway,
      onRequestError: opts.onRequestError,
    };
  }

  getState(): LiveState {
    return this.state;
  }

  subscribe(listener: (s: LiveState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the state once it leaves `connecting`, or with the current state after `timeoutMs`. */
  whenSettled(timeoutMs: number): Promise<LiveState> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsub();
        resolve(this.state);
      };
      const timer = setTimeout(done, timeoutMs);
      const unsub = this.subscribe((s) => {
        if (s.status !== 'connecting') done();
      });
      if (this.state.status !== 'connecting') done();
    });
  }

  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.sub?.close();
    this.sub = null;
  }

  /** Sends a request, then refreshes the tree. */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const result = await this.query<T>(method, params);
    this.scheduleRefresh();
    return result;
  }

  /** Read-only requests that should not trigger a tree refresh (e.g. pane.read polling). */
  async query<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.withConnection((c) => c.request<T>(method, params, timeoutMs));
  }

  /** Connects to a server whose Herdr is older than the minimum; some features may fail. */
  continueAnyway(): void {
    this.allowOld = true;
    this.opts.onContinueAnyway?.(this.state.server?.version);
    this.retryNow();
  }

  /**
   * Forces a reconnect (e.g. after the user taps Retry, or over a new SSH session). The old
   * subscription and any read or connect still in flight belong to the previous attempt: their
   * late failures are ignored instead of knocking the new attempt back to reconnecting.
   */
  retryNow(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.gen++;
    this.clearTimers();
    const old = this.sub;
    this.sub = null;
    this.subscribedPanes = '';
    old?.close();
    this.refreshing = null;
    void this.connect();
  }

  /**
   * Herdr answers one request per connection and then closes it (only subscriptions and waits
   * stay open), so every request gets its own connection. Reusing one races the server's EOF.
   */
  private async withConnection<T>(fn: (c: HerdrClient) => Promise<T>): Promise<T> {
    try {
      const c = await this.open();
      try {
        return await fn(c);
      } finally {
        c.close();
      }
    } catch (e) {
      this.opts.onRequestError?.(e);
      throw e;
    }
  }

  private async connect(): Promise<void> {
    const gen = this.gen;
    try {
      const server = await this.withConnection(ping);
      if (this.stopped || gen !== this.gen) return;
      // The SSH session works again; a stale code would make the owner replace it once more.
      this.update({ server, errorCode: undefined });
      if (!this.allowOld) checkVersion(server);
      await this.resubscribe(this.paneIds(this.state.snapshot));
      if (gen !== this.gen) return;
      await this.refresh();
      if (gen === this.gen) this.attempt = 0;
    } catch (e) {
      if (gen === this.gen) this.handleFailure(e);
    }
  }

  private paneIds(s?: SessionSnapshot): string[] {
    return (s?.panes ?? []).map((p) => p.pane_id).sort();
  }

  /**
   * Opens a new subscription before dropping the old one so no events are missed. A server that
   * rejects an event type it doesn't know lists the ones it does; subscribe again without the others.
   */
  private async resubscribe(panes: string[]): Promise<void> {
    for (let tries = 0; ; tries++) {
      try {
        return await this.subscribeOnce(panes);
      } catch (e) {
        const v = e instanceof HerdrApiError && e.code === 'invalid_request' ? parseUnknownVariant(e.message) : null;
        if (!v || tries >= 2 || !this.wanted(panes).some((s) => s.type === v.unknown)) throw e;
        const known = new Set(v.expected);
        this.wanted(panes).forEach((s) => known.has(s.type) || this.dropped.add(s.type));
        this.update({ droppedEvents: [...this.dropped] });
      }
    }
  }

  private wanted(panes: string[]): { type: string; pane_id?: string }[] {
    return [
      ...TREE_EVENTS.map((type) => ({ type })),
      ...panes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
    ].filter((s) => !this.dropped.has(s.type));
  }

  private async subscribeOnce(panes: string[]): Promise<void> {
    const gen = this.gen;
    const client = await this.open();
    client.onEvent((e) => this.handleEvent(client, e));
    client.onStreamError((err) => {
      client.close();
      if (client === this.sub) this.handleFailure(err);
    });
    client.onClose((reason) => {
      if (client === this.sub && !this.stopped) this.handleFailure(new HerdrApiError('closed', reason));
    });
    try {
      await client.request('events.subscribe', { subscriptions: this.wanted(panes) });
    } catch (e) {
      client.close();
      throw e;
    }
    if (this.stopped || gen !== this.gen) {
      client.close();
      return;
    }
    const old = this.sub;
    this.sub = client;
    this.subscribedPanes = panes.join(',');
    old?.close();
  }

  private handleEvent(client: HerdrClient, e: HerdrEvent): void {
    if (client !== this.sub) return;
    if (e.event === 'pane_agent_status_changed' || e.event === 'pane.agent_status_changed') {
      const d = e.data as { pane_id?: unknown; agent_status?: unknown; agent?: unknown; workspace_id?: unknown };
      if (typeof d.pane_id === 'string' && typeof d.agent_status === 'string') {
        const next = new Map(this.state.agents);
        const prev = next.get(d.pane_id);
        next.set(d.pane_id, {
          ...prev,
          status: d.agent_status,
          agent: typeof d.agent === 'string' ? d.agent : prev?.agent,
          workspaceId: typeof d.workspace_id === 'string' ? d.workspace_id : prev?.workspaceId,
        });
        this.setAgents(next);
      }
    }
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const gen = this.gen;
      this.refresh().catch((e) => gen === this.gen && this.handleFailure(e));
    }, this.opts.debounceMs);
  }

  /** Serialised snapshot reads; a request made during a read triggers one more read. */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const gen = this.gen;
    const run = (async () => {
      do {
        this.refreshAgain = false;
        const snapshot = await this.withConnection(fetchSnapshot);
        if (this.stopped || gen !== this.gen) return;
        const panes = this.paneIds(snapshot);
        this.update({ status: 'live', error: undefined, errorCode: undefined, snapshot, tree: buildTree(snapshot) });
        this.setAgents(agentsFromSnapshot(snapshot), this.baselined);
        this.baselined = true;
        if (panes.join(',') !== this.subscribedPanes) {
          await this.resubscribe(panes);
          this.refreshAgain = true; // Events between the read and the new subscription.
        }
      } while (this.refreshAgain && !this.stopped && gen === this.gen);
    })();
    this.refreshing = run;
    try {
      await run;
    } finally {
      if (this.refreshing === run) this.refreshing = null;
    }
  }

  private setAgents(next: AgentMap, alert = true): void {
    const alerts = alert ? agentAlerts(this.state.agents, next) : [];
    const since = new Map<string, number>();
    for (const [paneId, a] of next) {
      const prev = this.state.agents.get(paneId);
      const known = this.state.since.get(paneId);
      since.set(paneId, prev?.status === a.status && known !== undefined ? known : alert ? this.opts.now() : 0);
    }
    this.update({ agents: next, since });
    alerts.forEach((a) => this.opts.onAlert?.(a));
  }

  private handleFailure(e: unknown): void {
    if (this.stopped) return;
    const code = (e as { code?: string })?.code ?? '';
    const message = (e as { message?: string })?.message ?? String(e);
    if (this.opts.fatalCodes.includes(code)) {
      this.update({ status: 'offline', error: message, errorCode: code });
      return;
    }
    if (code === 'unsupported_version') {
      this.update({ status: 'unsupported', error: message, errorCode: code });
      return;
    }
    if (code === 'invalid_request') {
      // The same request would be rejected again; retrying only loops.
      this.update({
        status: 'unsupported',
        errorCode: code,
        error: `Herdr on this server rejected a request from the app (${message.replace(/, expected .*$/s, '')}). Updating Herdr may fix this.`,
      });
      return;
    }
    this.update({ status: 'reconnecting', error: message, errorCode: code });
    if (this.retryTimer) return;
    const delay = Math.min(this.opts.retryMs * 2 ** this.attempt, this.opts.maxRetryMs);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.refreshTimer = this.retryTimer = null;
  }

  private update(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }
}
