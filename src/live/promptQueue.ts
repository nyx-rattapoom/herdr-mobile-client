import type { KeyValueStore } from '../ssh/pinning';
import { safeKeyPart } from '../store/viewed';
import type { AgentMap } from './agents';

export type QueueItem = { id: string; text: string };

/** Per pane: waiting to send, sent and waiting for the agent to start, or waiting for it to finish. */
type Phase = 'ready' | 'sent' | 'running';

/** A prompt that never made the agent start working is given up on after this long. */
export const START_TIMEOUT_MS = 20_000;
/** Characters per stored chunk, keeping each secure-store value under 2 KB. */
const CHUNK = 900;
/** Most prompts queued per pane. */
export const MAX_QUEUE = 20;

const FINISHED = new Set(['idle', 'done']);
const EMPTY: readonly QueueItem[] = Object.freeze([]);

/**
 * Prompts waiting for a pane's agent to finish, per server profile + session. While an agent works,
 * prompts are queued on the phone. When it goes idle or done the first one is sent; the next waits
 * until the agent has worked and finished again. Nothing is sent while disconnected or while the
 * agent is blocked: a blocked agent is asking a question, and a queued prompt must never answer it.
 */
export class PromptQueues {
  private queues = new Map<string, QueueItem[]>();
  private phase = new Map<string, { phase: Phase; at: number }>();
  private listeners = new Set<() => void>();
  private sending = new Set<string>();
  private nextId = 0;
  private loaded = false;
  private paused = '';
  private lastState: { live: string; agents: AgentMap } | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** A prune asked for before the stored queues were loaded. */
  private pendingPrune: Set<string> | null = null;

  constructor(
    private readonly kv: KeyValueStore,
    /** server profile id + session name. */
    private readonly scope: string,
    private readonly send: (paneId: string, text: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  private get prefix() {
    return `pq.${safeKeyPart(this.scope)}`;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** The pane's queue. Stable between changes (an empty queue is always the same array). */
  items(paneId: string): readonly QueueItem[] {
    return this.queues.get(paneId) ?? EMPTY;
  }

  /** Why the queue isn't sending right now, if it isn't. */
  pausedReason(paneId: string): string | null {
    if (!this.items(paneId).length || !this.lastState) return null;
    if (this.lastState.live !== 'live') return 'Paused while disconnected.';
    if (this.lastState.agents.get(paneId)?.status === 'blocked') return 'Paused: the agent is waiting for an answer.';
    return null;
  }

  // ---- persistence ------------------------------------------------------------------------

  async load(): Promise<void> {
    try {
      const index = JSON.parse((await this.kv.getItem(this.prefix)) ?? '{}') as Record<string, string[]>;
      for (const [paneId, ids] of Object.entries(index)) {
        const items: QueueItem[] = [];
        for (const id of Array.isArray(ids) ? ids : []) {
          const text = await this.readText(id);
          if (text !== null) items.push({ id, text });
          this.nextId = Math.max(this.nextId, Number(id.split('-').pop()) + 1 || 0);
        }
        if (items.length) this.queues.set(paneId, items);
      }
    } catch {
      // Unreadable index: start empty.
    }
    this.loaded = true;
    if (this.pendingPrune) await this.prune(this.pendingPrune);
    this.emit();
    if (this.lastState) this.drive(this.lastState.live, this.lastState.agents);
  }

  private async readText(id: string): Promise<string | null> {
    const n = Number(await this.kv.getItem(`${this.prefix}.${id}`));
    if (!Number.isInteger(n) || n < 0) return null;
    let text = '';
    for (let i = 0; i < n; i++) text += (await this.kv.getItem(`${this.prefix}.${id}.${i}`)) ?? '';
    return text;
  }

  private async writeText(id: string, text: string) {
    const n = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < n; i++)
      await this.kv.setItem(`${this.prefix}.${id}.${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
    await this.kv.setItem(`${this.prefix}.${id}`, String(n));
  }

  private async deleteText(id: string) {
    const n = Number(await this.kv.getItem(`${this.prefix}.${id}`)) || 0;
    for (let i = 0; i < n; i++) await this.kv.deleteItem(`${this.prefix}.${id}.${i}`);
    await this.kv.deleteItem(`${this.prefix}.${id}`);
  }

  private async saveIndex() {
    const index: Record<string, string[]> = {};
    for (const [paneId, items] of this.queues) if (items.length) index[paneId] = items.map((i) => i.id);
    await this.kv.setItem(this.prefix, JSON.stringify(index));
  }

  private set(paneId: string, items: QueueItem[]) {
    if (items.length) this.queues.set(paneId, items);
    else this.queues.delete(paneId);
    this.emit();
  }

  // ---- editing ----------------------------------------------------------------------------

  async add(paneId: string, text: string): Promise<void> {
    const items = this.items(paneId);
    if (items.length >= MAX_QUEUE) throw new Error(`At most ${MAX_QUEUE} prompts can wait per pane.`);
    const item = { id: `q-${this.nextId++}`, text };
    this.set(paneId, [...items, item]);
    await this.writeText(item.id, text);
    await this.saveIndex();
    this.retrigger();
  }

  async update(paneId: string, id: string, text: string): Promise<void> {
    this.set(
      paneId,
      this.items(paneId).map((i) => (i.id === id ? { ...i, text } : i)),
    );
    await this.deleteText(id);
    await this.writeText(id, text);
  }

  async remove(paneId: string, id: string): Promise<void> {
    this.set(
      paneId,
      this.items(paneId).filter((i) => i.id !== id),
    );
    await this.deleteText(id);
    await this.saveIndex();
  }

  async move(paneId: string, id: string, delta: -1 | 1): Promise<void> {
    const items = [...this.items(paneId)];
    const i = items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    this.set(paneId, items);
    await this.saveIndex();
  }

  /** Sends one item now, whatever the agent is doing, and removes it from the queue. */
  async sendNow(paneId: string, id: string): Promise<void> {
    const item = this.items(paneId).find((i) => i.id === id);
    if (!item) return;
    await this.send(paneId, item.text);
    this.markSent(paneId);
    await this.remove(paneId, id);
  }

  /** Drops queues of panes that no longer exist. */
  async prune(existing: Set<string>): Promise<void> {
    if (!this.loaded) {
      // Pruning an empty, not-yet-loaded queue would save an empty index over the stored one.
      this.pendingPrune = existing;
      return;
    }
    this.pendingPrune = null;
    for (const [paneId, items] of [...this.queues]) {
      if (existing.has(paneId)) continue;
      this.queues.delete(paneId);
      for (const i of items) await this.deleteText(i.id);
    }
    await this.saveIndex();
    this.emit();
  }

  // ---- sending ----------------------------------------------------------------------------

  /** After a send, look again once the start timeout has passed even if nothing else changes. */
  private markSent(paneId: string) {
    this.phase.set(paneId, { phase: 'sent', at: this.now() });
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.retrigger();
    }, START_TIMEOUT_MS + 100);
    this.timers.add(t);
  }

  dispose() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.listeners.clear();
  }

  private retrigger() {
    if (this.lastState) this.drive(this.lastState.live, this.lastState.agents);
  }

  /**
   * Called on every live-state change. Advances each pane's phase from the agent status and
   * sends the next prompt when its agent is free.
   */
  drive(live: string, agents: AgentMap): void {
    this.lastState = { live, agents };
    const paused = this.queues.size ? [...this.queues.keys()].map((p) => this.pausedReason(p) ?? '').join('|') : '';
    if (paused !== this.paused) {
      this.paused = paused;
      this.emit();
    }
    if (!this.loaded || live !== 'live') return;
    for (const [paneId, items] of this.queues) {
      const status = agents.get(paneId)?.status;
      const p = this.phase.get(paneId) ?? { phase: 'ready' as Phase, at: 0 };
      if (p.phase === 'sent' && (status === 'working' || status === 'blocked')) {
        this.phase.set(paneId, { phase: 'running', at: this.now() });
        continue;
      }
      if (p.phase === 'running' && status && FINISHED.has(status))
        this.phase.set(paneId, { phase: 'ready', at: this.now() });
      if (p.phase === 'sent' && this.now() - p.at > START_TIMEOUT_MS)
        this.phase.set(paneId, { phase: 'ready', at: this.now() });
      const cur = this.phase.get(paneId) ?? p;
      if (cur.phase !== 'ready' || !status || !FINISHED.has(status) || !items.length || this.sending.has(paneId))
        continue;
      void this.sendFirst(paneId);
    }
  }

  private async sendFirst(paneId: string) {
    const first = this.items(paneId)[0];
    if (!first) return;
    this.sending.add(paneId);
    try {
      await this.send(paneId, first.text);
      this.markSent(paneId);
      await this.remove(paneId, first.id);
    } catch {
      // Left in the queue; the next state change tries again.
    } finally {
      this.sending.delete(paneId);
    }
  }
}
