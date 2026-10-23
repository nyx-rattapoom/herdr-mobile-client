import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { lineText, parseAnsi, type Line } from '../live/ansi';
import {
  EMPTY_KEPT,
  GAP_ROW,
  MAX_HELD_ROWS,
  MAX_KEPT_ROWS,
  keepScrolledOff,
  rowKeys,
  shiftUp,
  shownRows,
  type Kept,
} from '../live/scrollback';

const dir = join(__dirname, 'fixtures', 'claude-fullscreen');
const read = (text: string) => {
  const p = parseAnsi(text);
  if (p.length > 1 && p[p.length - 1].length === 0) p.pop();
  return p;
};
const frames = (name: string) =>
  readdirSync(join(dir, name))
    .sort()
    .map((f) => read(readFileSync(join(dir, name, f), 'utf8')));
const replay = (screens: Line[][], from: Kept = EMPTY_KEPT, hold = false) =>
  screens.reduce((k, s) => keepScrolledOff(k, s, hold), from);
const texts = (rows: Line[]) => rows.map((r) => lineText(r).trimEnd());
const screen = (rows: string[]) => rows.map((t): Line => (t ? [{ text: t, style: {} }] : []));

const FOOTER = ['', '────', '❯', '────', '  status'];
const view = (from: number, height = 10, footer = FOOTER) =>
  screen([...Array.from({ length: height }, (_, i) => `line ${from + i}`), ...footer]);

describe('keepScrolledOff on Claude Code', () => {
  it('keeps what scrolled off while it worked, matching the history Herdr reads once idle', () => {
    const working = frames('working');
    const k = replay(working);
    const history = readFileSync(join(dir, 'working-history.txt'), 'utf8').split('\n').map((l) => l.trimEnd());
    const kept = texts(k.rows);
    const gap = kept.indexOf(lineText(GAP_ROW));
    expect(gap).toBe(kept.length - 1);
    const before = kept.slice(0, gap);
    const at = history.indexOf(before[0]);
    expect(before.length).toBeGreaterThan(40);
    expect(before).toEqual(history.slice(at, at + before.length));
    expect(before.filter(Boolean).pop()).toBe('⏺ The fourth command printed twelve lines, "line a" through "line l".');
    expect(texts(working[working.length - 1])[0]).toBe('  11. Blackberry');
  });

  it('keeps what the permission prompt pushed off the screen', () => {
    const popup = frames('popup');
    const k = replay(popup);
    expect(texts(k.rows)).toEqual(Array.from({ length: 14 }, (_, i) => `  item ${96 + i}`));
    const last = texts(popup[popup.length - 1]);
    expect(last[0]).toBe('  item 110');
    expect(last).toContain(' Do you want to proceed?');
  });

  it('keeps nothing while the screen only redraws in place', () => {
    const working = frames('working');
    const k = replay([working[8], working[9]]);
    expect(k.rows).toEqual([]);
  });

  it('is unchanged by merging the same screen again', () => {
    const working = frames('working');
    const k = replay(working.slice(0, 5));
    expect(keepScrolledOff(k, working[4]).rows).toBe(k.rows);
  });
});

describe('keepScrolledOff', () => {
  it('keeps rows that left the top above a pinned footer', () => {
    const k = replay([view(1), view(4), view(6)]);
    expect(texts(k.rows)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    expect(k.pinned).toBe(FOOTER.length - 1);
  });

  it('keeps a big scroll that overlaps by fewer rows than the footer has', () => {
    const footer = ['', '────', '❯', '────', '  model', '  usage', '  mode'];
    const k = replay([view(1, 10, footer), view(3, 10, footer), view(11, 10, footer)]);
    expect(texts(k.rows)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${1 + i}`));
  });

  it('keeps rows below a pinned header', () => {
    const header = (from: number) => screen(['# session', ...texts(view(from))]);
    const k = replay([header(1), header(3)]);
    expect(texts(k.rows)).toEqual(['line 1', 'line 2']);
  });

  it("doesn't keep rows again after the agent was scrolled back and forward", () => {
    const k = replay([view(1), view(5), view(3), view(5), view(8)]);
    expect(texts(k.rows)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
    expect(k.above).toBe(0);
  });

  it('keeps the last screen and marks a gap when more than a screenful went by', () => {
    const k = replay([view(1), view(3), view(40)]);
    expect(texts(k.rows)).toEqual([
      'line 1',
      'line 2',
      ...Array.from({ length: 10 }, (_, i) => `line ${3 + i}`),
      '',
      lineText(GAP_ROW),
    ]);
  });

  it("doesn't keep a far-back screen again when the agent returns from it", () => {
    const k = replay([view(1), view(3), view(13), view(23)]);
    const before = texts(k.rows);
    expect(texts(replay([view(1), view(23)], k).rows)).toEqual(before);
  });

  it('takes back a screen kept at a gap when an overlay over it closes', () => {
    const overlay = screen([...Array.from({ length: 10 }, (_, i) => `pick ${i}`), ...FOOTER]);
    const k = replay([view(1), view(3), overlay, view(3), view(6)]);
    expect(texts(k.rows)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
  });

  it("doesn't show rows twice while they are scrolled back onto the screen", () => {
    const k = replay([view(1), view(4), view(2)]);
    expect(texts(shownRows(k))).toEqual(['line 1']);
    expect(texts(shownRows(keepScrolledOff(k, view(7))))).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
  });

  it('keeps a repeated top row in order rather than taking it for a header', () => {
    const rows = ['X', 'a1', 'a2', 'X', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'c1', 'c2', 'c3'];
    const k = replay([screen([...rows.slice(0, 10), ...FOOTER]), screen([...rows.slice(3, 13), ...FOOTER])]);
    expect(texts(k.rows)).toEqual(['X', 'a1', 'a2']);
  });

  it('keeps a one-row scroll above a tall dialog', () => {
    const dialog = ['', '────', ...Array.from({ length: 16 }, (_, i) => `option ${i}`)];
    const k = replay([view(1, 6, dialog), view(2, 6, dialog), view(3, 6, dialog), view(4, 6, dialog)]);
    expect(texts(k.rows)).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it("marks no gap before it knows where the agent's footer is", () => {
    const k = replay([view(1), view(40)]);
    expect(k.rows).toEqual([]);
  });

  it("doesn't take a prompt moving into the transcript for a scroll", () => {
    const before = screen(['', 'banner', '', '', '', '', '', '────', '❯ hello', '────', 'status', 'mode']);
    const after = screen(['', 'banner', '', '❯ hello', '', '', '', '────', '❯', '────', 'status', 'mode']);
    expect(replay([before, after]).rows).toEqual([]);
  });

  it('starts over when the screen size changes', () => {
    const k = replay([view(1), view(3), view(1, 12)]);
    expect(texts(k.rows)).toEqual(['line 1', 'line 2']);
    expect(texts(keepScrolledOff(k, view(2, 12)).rows)).toEqual(['line 1', 'line 2', 'line 1']);
  });

  it("doesn't drop rows under someone reading back until they return to the end", () => {
    let k = replay([view(1)]);
    let from = 1;
    while (k.rows.length <= MAX_KEPT_ROWS) k = keepScrolledOff(k, view((from += 8)), true);
    expect(k.dropped).toBe(0);
    const back = keepScrolledOff(k, view(from + 8));
    expect(back.rows.length).toBe(k.rows.length + 8 - back.dropped);
    expect(back.dropped).toBeGreaterThan(0);
    expect(back.rows.length).toBeLessThanOrEqual(MAX_KEPT_ROWS);
    expect(back.gap).toBeNull();
  });

  it('drops while held only past the larger cap', () => {
    let k = replay([view(1)]);
    for (let from = 9; from <= MAX_HELD_ROWS + 9; from += 8) k = keepScrolledOff(k, view(from), true);
    expect(k.dropped).toBeGreaterThan(0);
    expect(k.rows.length).toBeLessThanOrEqual(MAX_HELD_ROWS);
  });

  it('drops the oldest rows at the cap and counts them', () => {
    let k = replay([view(1)]);
    for (let from = 9; from <= MAX_KEPT_ROWS + 9; from += 8) k = keepScrolledOff(k, view(from));
    expect(k.rows.length).toBeLessThanOrEqual(MAX_KEPT_ROWS);
    expect(k.dropped).toBeGreaterThan(0);
    expect(texts(k.rows)[0]).toBe(`line ${k.dropped + 1}`);
  });
});

describe('shiftUp', () => {
  it('needs one unambiguous shift', () => {
    expect(shiftUp(['a', 'b', 'c', 'd'], ['c', 'd', 'e', 'f'])).toBe(2);
    expect(shiftUp(['x', 'y', 'x', 'y'], ['x', 'y', 'z', 'w'])).toBeNull();
  });
});

describe('rowKeys', () => {
  it('ignores a scrollbar down the right edge', () => {
    const rows = screen(['one   │', 'two   ┃', 'three │', 'four  │']);
    expect(rowKeys(rows)).toEqual(['one', 'two', 'three', 'four']);
    expect(rowKeys(screen(['a │', 'b']))).toEqual(['a │', 'b']);
  });
});
