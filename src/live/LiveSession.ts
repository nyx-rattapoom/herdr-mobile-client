import { HerdrApiError, type HerdrClient, type HerdrEvent } from '../protocol/client';
import { buildTree, fetchSnapshot, type SessionSnapshot, type WorkspaceNode } from '../protocol/snapshot';
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

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export type LiveState = {
  status: LiveStatus;
  error?: string;
  snapshot?: SessionSnapshot;
  tree: WorkspaceNode[];
  agents: AgentMap;
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
};

/**
 * Keeps a live view of one Herdr session: subscribes to lifecycle and per-pane agent-status
 * events, and treats events as cache invalidation followed by an authoritative
 * `session.snapshot` read, as Herdr's socket docs prescribe.
 */
export class LiveSession {
  private state: LiveState = { status: 'connecting', tree: [], agents: new Map() };
  private listeners = new Set<(s: LiveState) => void>();
  private sub: HerdrClient | null = null;
  private subscribedPanes = '';
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private attempt = 0;
  private stopped = false;
  /** The first snapshot is a baseline: agents already blocked when we connect don't alert. */
  private baselined = false;
  private readonly opts: Required<Omit<LiveOptions, 'onAlert'>> & Pick<LiveOptions, 'onAlert'>;

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
    };
  }

  getState(): LiveState {
    return this.state;
  }

  subscribe(listener: (s: LiveState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
  async query<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.withConnection((c) => c.request<T>(method, params));
  }

  /** Forces a reconnect (e.g. after the user taps Retry). */
  retryNow(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.clearTimers();
    void this.connect();
  }

  /**
   * Herdr answers one request per connection and then closes it (only subscriptions and waits
   * stay open), so every request gets its own connection. Reusing one races the server's EOF.
   */
  private async withConnection<T>(fn: (c: HerdrClient) => Promise<T>): Promise<T> {
    const c = await this.open();
    try {
      return await fn(c);
    } finally {
      c.close();
    }
  }

  private async connect(): Promise<void> {
    try {
      await this.resubscribe(this.paneIds(this.state.snapshot));
      await this.refresh();
      this.attempt = 0;
    } catch (e) {
      this.handleFailure(e);
    }
  }

  private paneIds(s?: SessionSnapshot): string[] {
    return (s?.panes ?? []).map((p) => p.pane_id).sort();
  }

  /** Opens a new subscription before dropping the old one so no events are missed. */
  private async resubscribe(panes: string[]): Promise<void> {
    const client = await this.open();
    client.onEvent((e) => this.handleEvent(client, e));
    client.onStreamError((err) => {
      client.close();
      if (client === this.sub) this.handleFailure(err);
    });
    client.onClose((reason) => {
      if (client === this.sub && !this.stopped) this.handleFailure(new HerdrApiError('closed', reason));
    });
    const subscriptions: Record<string, unknown>[] = [
      ...TREE_EVENTS.map((type) => ({ type })),
      ...panes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
    ];
    await client.request('events.subscribe', { subscriptions });
    if (this.stopped) {
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
      this.refresh().catch((e) => this.handleFailure(e));
    }, this.opts.debounceMs);
  }

  /** Serialised snapshot reads; a request made during a read triggers one more read. */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        const snapshot = await this.withConnection(fetchSnapshot);
        if (this.stopped) return;
        const panes = this.paneIds(snapshot);
        this.update({ status: 'live', error: undefined, snapshot, tree: buildTree(snapshot) });
        this.setAgents(agentsFromSnapshot(snapshot), this.baselined);
        this.baselined = true;
        if (panes.join(',') !== this.subscribedPanes) {
          await this.resubscribe(panes);
          this.refreshAgain = true; // Events between the read and the new subscription.
        }
      } while (this.refreshAgain && !this.stopped);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private setAgents(next: AgentMap, alert = true): void {
    const alerts = alert ? agentAlerts(this.state.agents, next) : [];
    this.update({ agents: next });
    alerts.forEach((a) => this.opts.onAlert?.(a));
  }

  private handleFailure(e: unknown): void {
    if (this.stopped) return;
    const code = (e as { code?: string })?.code ?? '';
    const message = (e as { message?: string })?.message ?? String(e);
    if (this.opts.fatalCodes.includes(code)) {
      this.update({ status: 'offline', error: message });
      return;
    }
    this.update({ status: 'reconnecting', error: message });
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
