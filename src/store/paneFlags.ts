import type { KeyValueStore } from '../ssh/pinning';
import { safeKeyPart } from './viewed';

export type PaneFlag = { pinned?: boolean; muted?: boolean; snoozeUntil?: number };

export function snoozePresets(now: number): { id: string; label: string; until: number }[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { id: 'hour', label: 'For 1 hour', until: now + 60 * 60 * 1000 },
    { id: 'tomorrow', label: 'Until tomorrow 9:00', until: tomorrow.getTime() },
  ];
}

export function nextClockTime(input: string, now: number): number | null {
  const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(input);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function formatUntil(until: number, now: number): string {
  const d = new Date(until);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return new Date(now).toDateString() === d.toDateString()
    ? hm
    : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}

export class PaneFlags {
  private flags: Record<string, PaneFlag> = {};
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private pendingPrune: Set<string> | null = null;
  private version = 0;

  constructor(
    private readonly kv: KeyValueStore,
    scope: string,
    private readonly now: () => number = Date.now,
    private readonly key = `flags.${safeKeyPart(scope)}`,
  ) {}

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getVersion = () => this.version;

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  async load(): Promise<void> {
    try {
      const v = JSON.parse((await this.kv.getItem(this.key)) ?? '{}');
      if (v && typeof v === 'object') this.flags = v;
    } catch {
      this.flags = {};
    }
    this.loaded = true;
    if (this.pendingPrune) await this.prune(this.pendingPrune);
    this.schedule();
    this.emit();
  }

  get(paneId: string): PaneFlag {
    return this.flags[paneId] ?? {};
  }

  isSnoozed(paneId: string): boolean {
    const u = this.flags[paneId]?.snoozeUntil;
    return u !== undefined && u > this.now();
  }

  isSilenced(paneId: string): boolean {
    return Boolean(this.flags[paneId]?.muted) || this.isSnoozed(paneId);
  }

  private async change(paneId: string, patch: PaneFlag) {
    const next = { ...this.get(paneId), ...patch };
    for (const k of Object.keys(next) as (keyof PaneFlag)[])
      if (next[k] === undefined || next[k] === false) delete next[k];
    if (Object.keys(next).length) this.flags = { ...this.flags, [paneId]: next };
    else {
      const { [paneId]: _gone, ...rest } = this.flags;
      void _gone;
      this.flags = rest;
    }
    this.schedule();
    this.emit();
    await this.kv.setItem(this.key, JSON.stringify(this.flags));
  }

  setPinned = (paneId: string, pinned: boolean) => this.change(paneId, { pinned });
  setMuted = (paneId: string, muted: boolean) => this.change(paneId, { muted });
  snooze = (paneId: string, until: number) => this.change(paneId, { snoozeUntil: until });
  unsnooze = (paneId: string) => this.change(paneId, { snoozeUntil: undefined });

  async prune(existing: Set<string>): Promise<void> {
    if (!this.loaded) {
      this.pendingPrune = existing;
      return;
    }
    this.pendingPrune = null;
    const now = this.now();
    const next: Record<string, PaneFlag> = {};
    for (const [paneId, f] of Object.entries(this.flags)) {
      if (!existing.has(paneId)) continue;
      const kept = { ...f };
      if (kept.snoozeUntil !== undefined && kept.snoozeUntil <= now) delete kept.snoozeUntil;
      if (Object.keys(kept).length) next[paneId] = kept;
    }
    if (JSON.stringify(next) === JSON.stringify(this.flags)) return;
    this.flags = next;
    this.emit();
    await this.kv.setItem(this.key, JSON.stringify(this.flags));
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    const ends = Object.values(this.flags)
      .map((f) => f.snoozeUntil)
      .filter((u): u is number => u !== undefined && u > now);
    if (!ends.length) return;
    const wait = Math.min(Math.min(...ends) - now + 50, 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
      this.emit();
    }, wait);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
