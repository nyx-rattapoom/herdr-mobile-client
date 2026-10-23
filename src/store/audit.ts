import type { KeyValueStore } from '../ssh/pinning';

export type AuditEntry = {
  t: number;
  server: string;
  target: string;
  action: string;
};

export const PAGE_SIZE = 10;
export const MAX_PAGES = 20;
export const MAX_ENTRIES = PAGE_SIZE * MAX_PAGES;
const FIELD_MAX = 80;

const META = 'audit.v1';
const pageKey = (id: number) => `audit.v1.p${id}`;

type Meta = { pages: number[]; next: number };

const clip = (s: string) => (s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX - 1)}…` : s);

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async meta(): Promise<Meta> {
    try {
      const m = JSON.parse((await this.kv.getItem(META)) ?? '');
      if (Array.isArray(m?.pages) && typeof m?.next === 'number') return m;
    } catch {
    }
    return { pages: [], next: 0 };
  }

  private async page(id: number): Promise<AuditEntry[]> {
    try {
      const p = JSON.parse((await this.kv.getItem(pageKey(id))) ?? '[]');
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  record(e: Omit<AuditEntry, 't'>): Promise<void> {
    const entry: AuditEntry = { t: this.now(), server: clip(e.server), target: clip(e.target), action: clip(e.action) };
    return this.serial(async () => {
      const m = await this.meta();
      let last = m.pages[m.pages.length - 1];
      let entries = last === undefined ? [] : await this.page(last);
      if (last === undefined || entries.length >= PAGE_SIZE) {
        last = m.next++;
        m.pages.push(last);
        entries = [];
        while (m.pages.length > MAX_PAGES) await this.kv.deleteItem(pageKey(m.pages.shift() as number));
      }
      entries.push(entry);
      await this.kv.setItem(pageKey(last), JSON.stringify(entries));
      await this.kv.setItem(META, JSON.stringify(m));
    });
  }

  async list(): Promise<AuditEntry[]> {
    const m = await this.meta();
    const pages = await Promise.all(m.pages.map((id) => this.page(id)));
    return pages.flat().reverse();
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      const m = await this.meta();
      for (const id of m.pages) await this.kv.deleteItem(pageKey(id));
      await this.kv.deleteItem(META);
    });
  }
}
