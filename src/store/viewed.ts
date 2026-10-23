import type { KeyValueStore } from '../ssh/pinning';

export const safeKeyPart = (s: string) => s.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);

export const MAX_VIEWED = 200;

export class ViewedStore {
  private cache = new Map<string, Record<string, number>>();

  constructor(private readonly kv: KeyValueStore) {}

  private key(serverId: string, session: string) {
    return `viewed.${safeKeyPart(serverId)}.${safeKeyPart(session)}`;
  }

  async load(serverId: string, session: string): Promise<Record<string, number>> {
    const k = this.key(serverId, session);
    const hit = this.cache.get(k);
    if (hit) return hit;
    let v: Record<string, number> = {};
    try {
      const parsed = JSON.parse((await this.kv.getItem(k)) ?? '{}');
      if (parsed && typeof parsed === 'object') {
        for (const [p, t] of Object.entries(parsed)) if (typeof t === 'number') v[p] = t;
      }
    } catch {
      v = {};
    }
    this.cache.set(k, v);
    return v;
  }

  async mark(serverId: string, session: string, paneId: string, at: number): Promise<Record<string, number>> {
    const cur = await this.load(serverId, session);
    const entries = Object.entries({ ...cur, [paneId]: at })
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VIEWED);
    const next = Object.fromEntries(entries);
    const k = this.key(serverId, session);
    this.cache.set(k, next);
    await this.kv.setItem(k, JSON.stringify(next));
    return next;
  }
}
