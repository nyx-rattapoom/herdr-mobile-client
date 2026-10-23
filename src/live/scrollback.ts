import { lineText, type Line } from './ansi';

export type Kept = {
  rows: Line[];
  screen: Line[] | null;
  above: number;
  pinned: number;
  dropped: number;
  gap: { screen: Line[]; rows: number; dropped: number } | null;
};

export const EMPTY_KEPT: Kept = { rows: [], screen: null, above: 0, pinned: 0, dropped: 0, gap: null };
export const GAP_ROW: Line = [
  { text: '  ⋯ the screen changed between reads; some output may be missing', style: { fg: '#888888' } },
];
export const MAX_KEPT_ROWS = 3000;
export const MAX_HELD_ROWS = MAX_KEPT_ROWS * 2;
const DROP_ROWS = 500;

const MIN_ALIGNMENT_PERCENT = 30;
const SIMILAR_PERCENT = 70;

export function rowKeys(rows: Line[]): string[] {
  const keys = rows.map((r) => lineText(r).trimEnd());
  for (let start = 0; start < keys.length; ) {
    let end = start;
    let track = false;
    let thumb = false;
    while (end < keys.length && keys[end].length === keys[start].length && keys[end].length > 0) {
      const last = keys[end][keys[end].length - 1];
      if (last === '│') track = true;
      else if (last === '┃' || last === '█') thumb = true;
      else break;
      end++;
    }
    if (end - start >= 3 && track && thumb) {
      for (let i = start; i < end; i++) keys[i] = keys[i].slice(0, -1).trimEnd();
    }
    start = Math.max(end, start + 1);
  }
  return keys;
}

function inPlace(a: string[], b: string[]): { same: number; comparable: number } {
  let comparable = 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] && !b[i]) continue;
    comparable++;
    if (a[i] === b[i]) same++;
  }
  return { same, comparable };
}

export function shiftUp(prev: string[], next: string[], end = prev.length): number | null {
  const count = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const prevCount = count(prev);
  const nextCount = count(next);
  let found: number | null = null;
  for (let shift = 1; shift < end; shift++) {
    let comparable = 0;
    let matches = 0;
    let anchored = false;
    for (let i = 0; i + shift < end; i++) {
      const before = prev[i + shift];
      const after = next[i];
      if (!before || !after || before === next[i + shift] || after === prev[i]) continue;
      comparable++;
      if (before !== after) continue;
      matches++;
      if (prevCount.get(before) === 1 && nextCount.get(after) === 1) anchored = true;
    }
    if (!anchored || matches * 100 < comparable * MIN_ALIGNMENT_PERCENT) continue;
    if (found !== null) return null;
    found = shift;
  }
  return found;
}

function scrolledOff(a: string[], b: string[], top: number, up: number): boolean {
  let rows = 0;
  let stayed = 0;
  for (let i = top; i < top + up; i++) {
    if (!a[i]) continue;
    rows++;
    if (a[i] === b[i]) stayed++;
  }
  return stayed * 2 <= rows;
}

function pinnedTop(a: string[], b: string[], up: number): number {
  let top = 0;
  while (top < a.length / 4 && a[top] && a[top] === b[top] && !(up && a[top] === a[top + up])) top++;
  return top;
}

function pinnedBottom(a: string[], b: string[], last: number): number | null {
  let start: number | null = null;
  let changed = 0;
  for (let i = b.length - 1; i > last; i--) {
    if (!a[i] && !b[i]) continue;
    if (a[i] === b[i]) start = i;
    else if (++changed > 2) break;
  }
  return start === null ? null : b.length - start;
}

function append(kept: Kept, add: Line[], next: Line[], change: Partial<Kept>, hold: boolean): Kept {
  let rows = add.length ? [...kept.rows, ...add] : kept.rows;
  let dropped = kept.dropped;
  const max = hold ? MAX_HELD_ROWS : MAX_KEPT_ROWS;
  if (rows.length > max) {
    const n = rows.length - max + DROP_ROWS;
    rows = rows.slice(n);
    dropped += n;
  }
  return { ...kept, gap: null, ...change, rows, screen: next, dropped };
}

function cameBack(gone: string[], now: string[], pinned: number): boolean {
  const texts = gone.slice(0, gone.length - pinned).filter((k) => k);
  const on = new Set(now);
  return texts.length > 0 && texts.filter((k) => on.has(k)).length * 2 > texts.length;
}

export function shownRows(kept: Kept): Line[] {
  return kept.above > 0 ? kept.rows.slice(0, Math.max(0, kept.rows.length - kept.above)) : kept.rows;
}

export function keepScrolledOff(kept: Kept, next: Line[], hold = false): Kept {
  const prev = kept.screen;
  if (!prev || prev.length !== next.length) return { ...kept, screen: next, above: 0, gap: null };
  const a = rowKeys(prev);
  const b = rowKeys(next);
  const gap = kept.gap;
  if (gap && gap.dropped === kept.dropped && cameBack(rowKeys(gap.screen), b, kept.pinned)) {
    const rows = kept.rows.slice(0, kept.rows.length - gap.rows);
    return keepScrolledOff({ ...kept, rows, screen: gap.screen, gap: null }, next, hold);
  }
  const end = kept.pinned > 0 && kept.pinned < a.length ? a.length - kept.pinned : a.length;
  const up = shiftUp(a, b, end);
  const top = pinnedTop(a, b, up ?? 0);
  if (up !== null && scrolledOff(a, b, top, up)) {
    let last = -1;
    for (let i = 0; i + up < a.length; i++) if (b[i] && b[i] === a[i + up] && b[i] !== a[i]) last = i;
    const pinned = pinnedBottom(a, b, last) ?? kept.pinned;
    const returning = Math.min(up, kept.above);
    return append(kept, prev.slice(top + returning, top + up), next, { above: kept.above - returning, pinned }, hold);
  }
  const { same, comparable } = inPlace(a, b);
  if (same * 100 >= comparable * SIMILAR_PERCENT) return { ...kept, screen: next };
  const down = up === null ? shiftUp(b, a, end) : null;
  if (down !== null) return { ...kept, screen: next, above: kept.above + down };
  if (end < a.length && end > top) {
    const before = a.slice(top, end).filter((k) => k);
    const now = new Set(b);
    if (before.length >= 3 && before.filter((k) => now.has(k)).length * 10 <= before.length) {
      const old = new Set(rowKeys(kept.rows));
      const mostlyOld = (keys: string[]) => keys.filter((k) => old.has(k)).length * 2 > keys.length;
      if (!mostlyOld(before) && !mostlyOld(b.slice(top, end).filter((k) => k))) {
        const add = [...prev.slice(top, end), GAP_ROW];
        const k = append(kept, add, next, { above: 0 }, hold);
        return { ...k, gap: { screen: prev, rows: add.length, dropped: k.dropped } };
      }
    }
  }
  return { ...kept, screen: next };
}
