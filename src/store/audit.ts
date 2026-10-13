import type { KeyValueStore } from '../ssh/pinning';

/**
 * One recorded action. Only fixed action names, ids and labels: never prompt text, typed input
 * or credentials.
 */
export type AuditEntry = {
  /** ms since epoch. */
  t: number;
  /** Server profile label. */
  server: string;
  /** e.g. `pane w1:p2`, `session default`. */
  target: string;
  /** e.g. `close pane`, `quick answer: Allow once`, `continue on old Herdr 0.7.5`. */
  action: string;
};

/** Entries per stored page; small pages keep each secure-store value well under 2 KB. */
export const PAGE_SIZE = 10;
/** Pages kept; the oldest page is dropped when a new one starts. */
export const MAX_PAGES = 20;
export const MAX_ENTRIES = PAGE_SIZE * MAX_PAGES;
const FIELD_MAX = 80;

const META = 'audit.v1';
const pageKey = (id: number) => `audit.v1.p${id}`;

type Meta = { pages: number[]; next: number };

const clip = (s: string) => (s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX - 1)}…` : s);

/** A local, size-capped log of destructive and approval actions, newest first when listed. */
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
      // Missing or unreadable: start over.
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

  /** Writes are serialised so concurrent records can't overwrite each other's page. */
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
