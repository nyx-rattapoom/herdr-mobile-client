import type { Line, Style } from './ansi';

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
};
export type Arms = [number, number, number, number];
export type Arc = 'tl' | 'tr' | 'br' | 'bl';

export type GridItem =
  | { kind: 'text'; col: number; cells: number; text: string; style: Style }
  | { kind: 'glyph'; col: number; cells: number; text: string; style: Style }
  | { kind: 'rects'; col: number; cells: number; rects: Rect[]; style: Style }
  | { kind: 'box'; col: number; cells: number; arms: Arms; style: Style }
  | { kind: 'arc'; col: number; cells: number; arc: Arc; style: Style };

export type GridBg = { col: number; cells: number; color: string };
export type GridLine = { cols: number; bg: GridBg[]; items: GridItem[] };

export function cellColors(s: Style, defaultFg: string, defaultBg: string): { fg: string; bg?: string } {
  if (s.inverse) return { fg: s.bg ?? defaultBg, bg: s.fg ?? defaultFg };
  return { fg: s.fg ?? defaultFg, bg: s.bg };
}

const isRunChar = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0x17f);

const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

export function cellWidth(cp: number): number {
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (cp < 0x1100) return 1;
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE[mid][0]) hi = mid - 1;
    else if (cp > WIDE[mid][1]) lo = mid + 1;
    else return 2;
  }
  return 1;
}

const full = (y: number, h: number, opacity?: number): Rect[] => [
  { x: 0, y, w: 1, h, ...(opacity ? { opacity } : {}) },
];
const quad = (tl: boolean, tr: boolean, bl: boolean, br: boolean): Rect[] =>
  [
    tl && { x: 0, y: 0, w: 0.5, h: 0.5 },
    tr && { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    bl && { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    br && { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ].filter(Boolean) as Rect[];

export function blockRects(cp: number): Rect[] | null {
  if (cp < 0x2580 || cp > 0x259f) return null;
  if (cp === 0x2580) return full(0, 0.5);
  if (cp <= 0x2588) return full(1 - (cp - 0x2580) / 8, (cp - 0x2580) / 8);
  if (cp <= 0x258f) return [{ x: 0, y: 0, w: (0x2590 - cp) / 8, h: 1 }];
  if (cp === 0x2590) return [{ x: 0.5, y: 0, w: 0.5, h: 1 }];
  if (cp <= 0x2593) return full(0, 1, (cp - 0x2590) / 4);
  if (cp === 0x2594) return full(0, 1 / 8);
  if (cp === 0x2595) return [{ x: 7 / 8, y: 0, w: 1 / 8, h: 1 }];
  const q: Record<number, [boolean, boolean, boolean, boolean]> = {
    0x2596: [false, false, true, false],
    0x2597: [false, false, false, true],
    0x2598: [true, false, false, false],
    0x2599: [true, false, true, true],
    0x259a: [true, false, false, true],
    0x259b: [true, true, true, false],
    0x259c: [true, true, false, true],
    0x259d: [false, true, false, false],
    0x259e: [false, true, true, false],
    0x259f: [false, true, true, true],
  };
  return quad(...q[cp]);
}

const spansWidth = (cp: number) => (cp >= 0x2580 && cp <= 0x2588) || (cp >= 0x2591 && cp <= 0x2594);

const BOX_250C =
  '0110 0210 0120 0220 0011 0012 0021 0022 1100 1200 2100 2200 1001 1002 2001 2002 ' +
  '1110 1210 2110 1120 2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 ' +
  '0111 0112 0211 0212 0121 0122 0221 0222 1101 1102 1201 1202 2101 2102 2201 2202 ' +
  '1111 1112 1211 1212 2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222';
const BOX_2574 = '0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010';

export function boxArms(cp: number): Arms | null {
  let code: string | undefined;
  if (cp === 0x2500) code = '0101';
  else if (cp === 0x2501) code = '0202';
  else if (cp === 0x2502) code = '1010';
  else if (cp === 0x2503) code = '2020';
  else if (cp >= 0x250c && cp <= 0x254b) code = BOX_250C.split(' ')[cp - 0x250c];
  else if (cp >= 0x2574 && cp <= 0x257f) code = BOX_2574.split(' ')[cp - 0x2574];
  return code ? (code.split('').map(Number) as Arms) : null;
}

const ARCS: Record<number, Arc> = {
  0x256d: 'tl',
  0x256e: 'tr',
  0x256f: 'br',
  0x2570: 'bl',
};

const sameStyle = (a: Style, b: Style) => JSON.stringify(a) === JSON.stringify(b);

export function layoutLine(line: Line, defaultFg = '#fff', defaultBg = '#000'): GridLine {
  const bg: GridBg[] = [];
  const items: GridItem[] = [];
  let col = 0;

  const pushBg = (c: number, cells: number, color: string | undefined) => {
    if (!color || cells === 0) return;
    const last = bg[bg.length - 1];
    if (last && last.color === color && last.col + last.cells === c) last.cells += cells;
    else bg.push({ col: c, cells, color });
  };

  for (const span of line) {
    const { bg: spanBg } = cellColors(span.style, defaultFg, defaultBg);
    const style = span.style;
    for (const ch of span.text) {
      const cp = ch.codePointAt(0)!;
      const last = items[items.length - 1];
      if (ch === '\t') {
        const n = 8 - (col % 8);
        pushBg(col, n, spanBg);
        col += n;
        continue;
      }
      const w = cellWidth(cp);
      if (w === 0) {
        if (last && (last.kind === 'text' || last.kind === 'glyph')) last.text += ch;
        continue;
      }
      pushBg(col, w, spanBg);
      const adjacent = last && last.col + last.cells === col && sameStyle(last.style, style);
      if (ch === ' ' && !(adjacent && last.kind === 'text') && !style.underline && !style.inverse) {
        col += 1;
        continue;
      }
      const rects = blockRects(cp);
      const arms = rects ? null : boxArms(cp);
      const arc = ARCS[cp];
      if (rects) {
        if (
          adjacent &&
          last.kind === 'rects' &&
          spansWidth(cp) &&
          last.rects.length === 1 &&
          sameRow(last.rects[0], rects[0])
        ) {
          last.cells += 1;
          last.rects[0].w += 1;
        } else {
          items.push({ kind: 'rects', col, cells: 1, rects, style });
        }
      } else if (arms) {
        const horizontal = arms[0] === 0 && arms[2] === 0 && arms[1] === arms[3];
        if (adjacent && last.kind === 'box' && horizontal && sameArms(last.arms, arms)) last.cells += 1;
        else items.push({ kind: 'box', col, cells: 1, arms, style });
      } else if (arc) {
        items.push({ kind: 'arc', col, cells: 1, arc, style });
      } else if (isRunChar(cp)) {
        if (adjacent && last.kind === 'text') {
          last.text += ch;
          last.cells += 1;
        } else {
          items.push({ kind: 'text', col, cells: 1, text: ch, style });
        }
      } else {
        items.push({ kind: 'glyph', col, cells: w, text: ch, style });
      }
      col += w;
    }
  }
  return { cols: col, bg, items };
}

const sameRow = (a: Rect, b: Rect) => a.y === b.y && a.h === b.h && a.opacity === b.opacity && a.x === 0 && b.x === 0;
const sameArms = (a: Arms, b: Arms) => a.every((v, i) => v === b[i]);
