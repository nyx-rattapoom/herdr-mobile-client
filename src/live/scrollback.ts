import { lineText, type Line } from './ansi';

/**
 * Rows that scrolled off the top of a full-screen agent's screen while the app watched it.
 *
 * A full-screen agent (Claude Code with `"tui": "fullscreen"`, OpenCode) draws on the alternate
 * screen, which keeps no scrollback, and Herdr reads its history only by scrolling it while idle.
 * While it works or waits on a question, each poll is just its screen, so the app keeps what it saw
 * leave the top: the transcript shifts up between polls above a pinned prompt or dialog.
 */
export type Kept = {
  rows: Line[];
  /** The last screen merged. */
  screen: Line[] | null;
  /** Rows the agent is scrolled back by (someone scrolled it); they return before any new row. */
  above: number;
  /** Rows pinned at the bottom (prompt box, status line), as seen on the last scroll. */
  pinned: number;
  /** Oldest rows dropped at the cap so far, so a reader can keep its place. */
  dropped: number;
  /**
   * The screen kept whole at the last gap and the rows that added. If that screen comes back, it was
   * covered by an overlay (a transcript view, a picker) rather than scrolled away, and is taken back.
   */
  gap: { screen: Line[]; rows: number; dropped: number } | null;
};

export const EMPTY_KEPT: Kept = { rows: [], screen: null, above: 0, pinned: 0, dropped: 0, gap: null };
/** Marks where the screen changed too much between reads to tell what scrolled past. */
export const GAP_ROW: Line = [
  { text: '  ⋯ the screen changed between reads; some output may be missing', style: { fg: '#888888' } },
];
export const MAX_KEPT_ROWS = 3000;
/** Dropped together at the cap, so the list doesn't shift on every poll. */
const DROP_ROWS = 500;

const MIN_ALIGNMENT_PERCENT = 30;
const SIMILAR_PERCENT = 70;

/**
 * Rows compared by their text without trailing spaces. A scrollbar drawn down the right edge
 * (a run of rows ending in a track and a thumb) is left out, as it moves independently.
 */
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

/** Non-empty rows unchanged in place, and how many rows could be compared. */
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

/**
 * How far the content moved up from `prev` to `next` (`next[i]` shows `prev[i + shift]`) in the rows
 * above `end`, or null when no single shift explains it. A shift needs a row that is unique in both
 * screens to anchor it, and enough matching rows; two plausible shifts are ambiguous, not a vote.
 */
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
      // Rows that stayed put (a prompt box, a dialog) didn't move, so they don't vote.
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

/**
 * Whether the rows a shift says left the top really changed. A prompt moving from the input box into
 * the transcript looks like a big shift, but the banner above it stays where it was.
 */
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

/**
 * Rows that stay put at the top (a pinned header) don't scroll; what leaves is below them. A row the
 * shift explains (`a[i] === a[i + up]`) is transcript that repeats, not a header.
 */
function pinnedTop(a: string[], b: string[], up: number): number {
  let top = 0;
  while (top < a.length / 4 && a[top] && a[top] === b[top] && !(up && a[top] === a[top + up])) top++;
  return top;
}

/**
 * Rows pinned at the bottom (prompt box, status line): the lowest rows that stayed put, below the
 * last row that scrolled. A status row or two may change; a third changed row is the transcript
 * (a repeated transcript row can stay put by chance, so the count doesn't reset).
 */
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

function append(kept: Kept, add: Line[], next: Line[], change: Partial<Kept>): Kept {
  let rows = add.length ? [...kept.rows, ...add] : kept.rows;
  let dropped = kept.dropped;
  if (rows.length > MAX_KEPT_ROWS) {
    const n = rows.length - MAX_KEPT_ROWS + DROP_ROWS;
    rows = rows.slice(n);
    dropped += n;
  }
  return { ...kept, gap: null, ...change, rows, screen: next, dropped };
}

/** Most of `gone`'s transcript (above its pinned rows) is on screen again. */
function cameBack(gone: string[], now: string[], pinned: number): boolean {
  const texts = gone.slice(0, gone.length - pinned).filter((k) => k);
  const on = new Set(now);
  return texts.length > 0 && texts.filter((k) => on.has(k)).length * 2 > texts.length;
}

/** Kept rows to show above the screen: rows scrolled back onto it (`above`) are drawn there already. */
export function shownRows(kept: Kept): Line[] {
  return kept.above > 0 ? kept.rows.slice(0, Math.max(0, kept.rows.length - kept.above)) : kept.rows;
}

/** Merges the next screen of a full-screen agent, keeping the rows that left its top. */
export function keepScrolledOff(kept: Kept, next: Line[]): Kept {
  const prev = kept.screen;
  if (!prev || prev.length !== next.length) return { ...kept, screen: next, above: 0, gap: null };
  const a = rowKeys(prev);
  const b = rowKeys(next);
  const gap = kept.gap;
  if (gap && gap.dropped === kept.dropped && cameBack(rowKeys(gap.screen), b, kept.pinned)) {
    const rows = kept.rows.slice(0, kept.rows.length - gap.rows);
    return keepScrolledOff({ ...kept, rows, screen: gap.screen, gap: null }, next);
  }
  // Above the pinned rows, so they don't outweigh a big scroll's few overlapping rows.
  const end = kept.pinned > 0 && kept.pinned < a.length ? a.length - kept.pinned : a.length;
  const up = shiftUp(a, b, end);
  const top = pinnedTop(a, b, up ?? 0);
  // A scroll is looked for first: one row scrolling above a tall dialog leaves most rows in place.
  if (up !== null && scrolledOff(a, b, top, up)) {
    // The last row that scrolled; a row that also stayed put (a border repeating at the shift) is ambiguous.
    let last = -1;
    for (let i = 0; i + up < a.length; i++) if (b[i] && b[i] === a[i + up] && b[i] !== a[i]) last = i;
    const pinned = pinnedBottom(a, b, last) ?? kept.pinned;
    const returning = Math.min(up, kept.above);
    return append(kept, prev.slice(top + returning, top + up), next, { above: kept.above - returning, pinned });
  }
  const { same, comparable } = inPlace(a, b);
  // Most rows unchanged in place: the agent redrew part of its screen without scrolling.
  if (same * 100 >= comparable * SIMILAR_PERCENT) return { ...kept, screen: next };
  const down = up === null ? shiftUp(b, a, end) : null;
  // Scrolled back (content moved down): those rows come back before anything new leaves the top.
  if (down !== null) return { ...kept, screen: next, above: kept.above + down };
  // None of the last transcript is left on screen: more than a screenful went by between reads, so it
  // all scrolled off, along with whatever passed unseen. Not when either screen was kept already: the
  // agent was scrolled far back, or returned from there.
  if (end < a.length && end > top) {
    const before = a.slice(top, end).filter((k) => k);
    const now = new Set(b);
    if (before.length >= 3 && before.filter((k) => now.has(k)).length * 10 <= before.length) {
      const old = new Set(rowKeys(kept.rows));
      const mostlyOld = (keys: string[]) => keys.filter((k) => old.has(k)).length * 2 > keys.length;
      if (!mostlyOld(before) && !mostlyOld(b.slice(top, end).filter((k) => k))) {
        const add = [...prev.slice(top, end), GAP_ROW];
        const k = append(kept, add, next, { above: 0 });
        return { ...k, gap: { screen: prev, rows: add.length, dropped: k.dropped } };
      }
    }
  }
  return { ...kept, screen: next };
}
