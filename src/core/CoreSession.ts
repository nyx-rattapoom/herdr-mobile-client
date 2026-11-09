import { CoreClient, ByteLineBuffer } from './client';
import { CorePane } from './CorePane';
import { emptyCoreState, reduceNotification, type CoreState } from './events';
import { pinnedLabels, seenMarkUnread, seenRaise } from './labels';
import { parseLayout, type CoreLayout } from './layout';
import { parseDocGet, parseSubscribe, safeUint, CoreCommandError, type CoreTerminal } from './types';
import type { ByteTransport } from './transport';

/**
 * Live-session error sources, tracked separately so one source's success never
 * hides another's failure. A 'state' error means an update was dropped, so only
 * an authoritative resnapshot (subscribe or `missed`) clears it; 'label' and
 * 'reattach' clear on the next success of that operation. All clear when a new
 * connect attempt starts.
 */
type TransientError = 'state' | 'label' | 'reattach';

export type CoreSessionStatus = 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed';

export type CoreSessionSnapshot = {
  status: CoreSessionStatus;
  error: string | null;
  hello: import('./types').CoreHello | null;
  state: CoreState;
  layout: CoreLayout | null;
  layoutVersion: number;
  docError: string | null;
};

type Listener = (s: CoreSessionSnapshot) => void;

/**
 * One Herdr Core connection and its live state.
 *
 * Generation tokens guard every async continuation: a reply or event from a
 * previous transport can never mutate current state or deliver input.
 */
export class CoreSession {
  private client: CoreClient | null = null;
  private transport: ByteTransport | null = null;
  private generation = 0;
  private closedByUser = false;
  private state: CoreState = emptyCoreState();
  private layout: CoreLayout | null = null;
  private layoutVersion = 0;
  private docError: string | null = null;
  private docToken = 0;
  private docScheduled = false;
  private status: CoreSessionStatus = 'connecting';
  private error: string | null = null;
  private readonly transientErrors = new Map<TransientError, string>();
  private hello: import('./types').CoreHello | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly panes = new Set<CorePane>();
  private readonly seenWritten = new Map<string, number>();
  private visible: string | null = null;

  constructor(private readonly openTransport: () => Promise<ByteTransport>) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): CoreSessionSnapshot {
    return {
      status: this.status,
      error:
        this.error ??
        this.transientErrors.get('state') ??
        this.transientErrors.get('label') ??
        this.transientErrors.get('reattach') ??
        null,
      hello: this.hello,
      state: this.state,
      layout: this.layout,
      layoutVersion: this.layoutVersion,
      docError: this.docError,
    };
  }

  /** The current client, only for viewer/input calls made by a CorePane. */
  currentClient(): CoreClient | null {
    return this.client;
  }

  get currentHello(): import('./types').CoreHello | null {
    return this.hello;
  }

  async start(): Promise<void> {
    const gen = ++this.generation;
    this.closedByUser = false;
    this.status = 'connecting';
    this.resetError();
    this.emit();
    try {
      await this.connect(gen);
    } catch (e) {
      if (gen !== this.generation) return;
      this.status = 'error';
      this.setError(e, null);
      this.emit();
      throw e;
    }
  }

  private async connect(gen: number): Promise<void> {
    const transport = await this.openTransport();
    if (gen !== this.generation || this.closedByUser) {
      transport.close();
      return;
    }
    this.transport = transport;
    const client = new CoreClient(transport);
    this.client = client;
    client.onNotification((method, params) => {
      if (gen === this.generation) this.handleNotification(method, params);
    });
    client.onClose((err) => {
      if (gen !== this.generation || this.closedByUser) return;
      this.status = 'error';
      this.setError(err, null);
      this.emit();
    });
    const hello = await client.handshake();
    if (gen !== this.generation) {
      client.close();
      return;
    }
    this.hello = hello;
    await this.subscribeAndRead(gen, client);
    if (gen !== this.generation || client.closed) return;
    this.status = 'live';
    this.error = null;
    this.emit();
    this.maybeMarkSeen();
    await this.reattachPanes(gen);
  }

  private async subscribeAndRead(gen: number, client: CoreClient): Promise<void> {
    const raw = await client.request('events.subscribe', {}, 20_000);
    if (gen !== this.generation) return;
    const sub = parseSubscribe(raw);
    const terminals = new Map<string, CoreTerminal>();
    for (const t of sub.terminals) terminals.set(t.address, t);
    this.state = { seq: sub.seq, terminals };
    this.clearError('state');
    if (sub.channel !== null) this.registerEvents(gen, client, sub.channel);
    this.emit();
    this.maybeMarkSeen();
    await this.readDoc(gen);
  }

  private registerEvents(gen: number, client: CoreClient, channel: number): void {
    const lines = new ByteLineBuffer();
    client.registerStream(channel, {
      onData: (bytes) => {
        if (gen !== this.generation) return;
        for (const line of lines.push(bytes)) {
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const m = msg as { method?: unknown; params?: unknown };
          if (typeof m.method !== 'string') continue;
          const params = typeof m.params === 'object' && m.params !== null ? (m.params as Record<string, unknown>) : {};
          this.handleNotification(m.method, params);
        }
      },
      onClose: () => {
        if (gen !== this.generation || this.closedByUser || client.closed) return;
        // The terminal streams can survive an event-channel loss, but the
        // snapshot is authoritative: subscribe again and re-read documents.
        void this.resubscribe(gen, client);
      },
    });
  }

  private async resubscribe(gen: number, client: CoreClient): Promise<void> {
    try {
      await this.subscribeAndRead(gen, client);
    } catch (e) {
      if (gen !== this.generation) return;
      this.setError(e, 'state');
      this.emit();
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    let r;
    try {
      r = reduceNotification(this.state, method, params);
    } catch (e) {
      this.setError(e, 'state');
      this.emit();
      return;
    }
    if (r.state !== this.state) {
      this.state = r.state;
      this.reconcilePanes();
      this.emit();
    }
    if (r.missed) {
      this.clearError('state');
      this.docError = null;
      this.scheduleDocRead();
      this.maybeMarkSeen();
    }
    if (r.docs.some((d) => d.name === 'herdr-app' && d.machine === null && d.version !== this.layoutVersion)) this.scheduleDocRead();
    // "Decide on the turn event": status/labels/size/foreground changes must
    // not overrule a mark-unread from another client while this screen stays
    // visible. A later turn is the genuine viewing transition that may raise it.
    if (method === 'event' && params.type === 'turn') this.maybeMarkSeen();
  }

  private scheduleDocRead(): void {
    if (this.docScheduled) return;
    this.docScheduled = true;
    Promise.resolve().then(() => {
      this.docScheduled = false;
      void this.readDoc(this.generation);
    });
  }

  private async readDoc(gen: number): Promise<void> {
    const client = this.client;
    if (!client || gen !== this.generation) return;
    const token = ++this.docToken;
    try {
      const raw = await client.request('doc.get', { name: 'herdr-app' }, 15_000);
      if (gen !== this.generation || token !== this.docToken) return;
      const doc = parseDocGet(raw);
      this.layout = parseLayout(doc.value);
      this.layoutVersion = doc.version;
      this.docError = null;
      this.emit();
    } catch (e) {
      if (gen !== this.generation || token !== this.docToken) return;
      this.docError = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  /** The visible, foreground Core terminal, or null. */
  setVisible(address: string | null): void {
    if (this.visible === address) return;
    if (this.visible) this.seenWritten.delete(this.visible);
    this.visible = address;
    this.maybeMarkSeen();
  }

  private maybeMarkSeen(): void {
    const address = this.visible;
    if (!address || this.status !== 'live') return;
    const t = this.state.terminals.get(address);
    if (!t) return;
    const turn = seenRaise(t, this.seenWritten.get(address) ?? null);
    if (turn === null) return;
    const client = this.client;
    if (!client) return;
    // Write once, then stop even if the write is uncertain: reconcile from
    // events instead of retrying a person-triggered side effect forever.
    this.seenWritten.set(address, turn);
    void this.label(address, { 'herdr.seen': String(turn) }).catch((e) => {
      if (client !== this.client) return;
      this.setError(e, 'label');
      this.emit();
    });
  }

  async setPinned(address: string, pinned: boolean): Promise<void> {
    await this.label(address, pinnedLabels(pinned));
  }

  /** The one lower write; at turn 0 nothing has finished yet. */
  async markUnread(address: string): Promise<void> {
    const t = this.state.terminals.get(address);
    if (!t) return;
    const turn = seenMarkUnread(t);
    if (turn === null) return;
    this.seenWritten.set(address, turn);
    await this.label(address, { 'herdr.seen': String(turn) });
  }

  private async label(address: string, labels: Record<string, string>): Promise<void> {
    const client = this.client;
    if (!client) throw new CoreCommandError('not_connected', 'Herdr Core is not connected');
    await client.request('terminal.label', { terminal: address, labels }, 10_000);
    if (client !== this.client) return;
    this.clearError('label');
  }

  async sendKeys(address: string, keys: string[]): Promise<void> {
    const client = this.client;
    if (!client) throw new CoreCommandError('not_connected', 'Herdr Core is not connected');
    await client.request('terminal.keys', { terminal: address, keys }, 15_000);
  }

  /** Prompt submit. A blocked agent is refused unless the caller opts in. */
  async submit(address: string, text: string, force = false): Promise<{ turn: number }> {
    const client = this.client;
    if (!client) throw new CoreCommandError('not_connected', 'Herdr Core is not connected');
    const t = this.state.terminals.get(address);
    if (!force && t?.status?.state === 'blocked') {
      throw new CoreCommandError('blocked', 'This agent is blocked; answer its prompt first.');
    }
    const raw = await client.request('terminal.send', { terminal: address, text, force }, 30_000);
    const turn = safeUint((raw as { turn?: unknown })?.turn, 'send.turn');
    return { turn };
  }

  supportsAutomaticInput(attach: { automaticInput: boolean } | null): boolean {
    return attach?.automaticInput === true && this.hello?.features.includes('automatic_input') === true;
  }

  /** A viewer for one terminal. Panes are reattached after reconnect. */
  pane(address: string, cols: number, rows: number, observe = true): CorePane {
    const pane = new CorePane(this, address, cols, rows, observe);
    this.panes.add(pane);
    return pane;
  }

  releasePane(pane: CorePane): void {
    pane.detach();
    this.panes.delete(pane);
  }

  private reconcilePanes(): void {
    for (const pane of this.panes) {
      const t = this.state.terminals.get(pane.address);
      if (!t || t.state !== 'live') {
        pane.detach();
        pane.closedReason = t ? 'terminal finished' : 'terminal removed';
      }
    }
  }

  private async reattachPanes(gen: number): Promise<void> {
    for (const pane of this.panes) {
      if (gen !== this.generation) return;
      const t = this.state.terminals.get(pane.address);
      if (!t || t.state !== 'live') continue;
      try {
        await pane.reattach();
      } catch (e) {
        if (gen !== this.generation) return;
        this.setError(e, 'reattach');
        this.emit();
        continue;
      }
      if (gen === this.generation) this.clearError('reattach');
    }
  }

  async reconnect(): Promise<void> {
    if (this.status === 'reconnecting') return;
    this.status = 'reconnecting';
    this.resetError();
    this.emit();
    const gen = ++this.generation;
    this.client?.close();
    this.client = null;
    this.transport = null;
    for (const pane of this.panes) pane.detach();
    try {
      await this.connect(gen);
    } catch (e) {
      if (gen !== this.generation) return;
      this.status = 'error';
      this.setError(e, null);
      this.emit();
    }
  }

  private setError(e: unknown, source: TransientError | null): void {
    const message = e instanceof Error ? e.message : String(e);
    if (source) this.transientErrors.set(source, message);
    else this.error = message;
  }

  private resetError(): void {
    this.error = null;
    this.transientErrors.clear();
  }

  /** Clears one transient source; see `TransientError` for when each may clear. */
  private clearError(source: TransientError): void {
    if (!this.transientErrors.delete(source)) return;
    this.emit();
  }

  close(): void {
    this.closedByUser = true;
    this.generation++;
    for (const pane of this.panes) pane.detach();
    this.panes.clear();
    this.client?.close();
    this.client = null;
    this.transport?.close();
    this.transport = null;
    this.status = 'closed';
    this.emit();
    this.listeners.clear();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}
