import { parseAnsi } from '../live/ansi';
import { blockRects, boxArms, cellColors, cellWidth, layoutLine } from '../live/grid';

const one = (s: string) => layoutLine(parseAnsi(s)[0]);

describe('grid layout', () => {
  it('keeps Latin text in runs and positions other characters in their own cells', () => {
    const g = one('ab … cd');
    expect(g.cols).toBe(7);
    expect(g.items).toEqual([
      { kind: 'text', col: 0, cells: 3, text: 'ab ', style: {} },
      { kind: 'glyph', col: 3, cells: 1, text: '…', style: {} },
      { kind: 'text', col: 5, cells: 2, text: 'cd', style: {} },
    ]);
    expect(one('hello world').items).toEqual([{ kind: 'text', col: 0, cells: 11, text: 'hello world', style: {} }]);
  });

  it('gives wide characters two cells and folds combining marks into the previous one', () => {
    const g = one('漢x e\u0301');
    expect(g.items.map((i) => [i.kind, i.col, i.cells, 'text' in i ? i.text : ''])).toEqual([
      ['glyph', 0, 2, '漢'],
      ['text', 2, 3, 'x e\u0301'],
    ]);
    expect(g.cols).toBe(5);
    expect(cellWidth(0x1f600)).toBe(2);
    expect(cellWidth(0x200d)).toBe(0);
  });

  it('fills backgrounds per cell, merging adjacent cells of one colour', () => {
    const g = one('\x1b[48;2;10;10;10m  ab\x1b[48;2;40;40;40m c\x1b[0m z');
    expect(g.bg).toEqual([
      { col: 0, cells: 4, color: '#0a0a0a' },
      { col: 4, cells: 2, color: '#282828' },
    ]);
    expect(g.cols).toBe(8);
  });

  it('draws block elements as rectangles and merges runs of full-width blocks', () => {
    const g = one('\x1b[38;2;128;128;128m█▀▀█\x1b[0m');
    expect(g.items.map((i) => (i.kind === 'rects' ? [i.col, i.cells, i.rects] : i.kind))).toEqual([
      [0, 1, [{ x: 0, y: 0, w: 1, h: 1 }]],
      [1, 2, [{ x: 0, y: 0, w: 2, h: 0.5 }]],
      [3, 1, [{ x: 0, y: 0, w: 1, h: 1 }]],
    ]);
    expect(blockRects(0x2584)).toEqual([{ x: 0, y: 0.5, w: 1, h: 0.5 }]);
    expect(blockRects(0x258c)).toEqual([{ x: 0, y: 0, w: 0.5, h: 1 }]);
    expect(blockRects(0x2592)).toEqual([{ x: 0, y: 0, w: 1, h: 1, opacity: 0.5 }]);
    expect(blockRects(0x259a)).toHaveLength(2);
    expect(blockRects(0x41)).toBeNull();
  });

  it('draws light/heavy box lines and rounded corners, leaving doubles to the font', () => {
    expect(boxArms(0x2503)).toEqual([2, 0, 2, 0]);
    expect(boxArms(0x2579)).toEqual([2, 0, 0, 0]);
    expect(boxArms(0x250d)).toEqual([0, 2, 1, 0]);
    expect(boxArms(0x253c)).toEqual([1, 1, 1, 1]);
    expect(boxArms(0x2550)).toBeNull();
    const g = one('╭──╮');
    expect(g.items.map((i) => [i.kind, i.col, i.cells])).toEqual([
      ['arc', 0, 1],
      ['box', 1, 2],
      ['arc', 3, 1],
    ]);
  });

  it('applies inverse to the cell colours', () => {
    expect(cellColors({ inverse: true, fg: '#111111' }, '#fff', '#000')).toEqual({ fg: '#000', bg: '#111111' });
    expect(one('\x1b[7m x').bg).toEqual([{ col: 0, cells: 2, color: '#fff' }]);
    expect(one('\x1b[7m x').items[0]).toMatchObject({
      kind: 'text',
      col: 0,
      text: ' x',
    });
  });

  it('expands tabs to the next multiple of eight', () => {
    expect(one('a\tb').items[1]).toMatchObject({ col: 8, text: 'b' });
  });

  it('gives Thai non-spacing marks width zero, spacing ones one cell', () => {
    // Above vowels, below vowels and tone marks combine with the base consonant.
    expect(cellWidth(0x0e35)).toBe(0); // SARA II
    expect(cellWidth(0x0e34)).toBe(0); // SARA I
    expect(cellWidth(0x0e39)).toBe(0); // SARA UU
    expect(cellWidth(0x0e31)).toBe(0); // MAI HAN-AKAT
    expect(cellWidth(0x0e48)).toBe(0); // MAI EK
    expect(cellWidth(0x0e4e)).toBe(0); // YAMAKKAN
    // Consonants and spacing vowels keep one cell.
    expect(cellWidth(0x0e0e)).toBe(1); // DO CHADA
    expect(cellWidth(0x0e33)).toBe(1); // SARA AM
    // The same rule covers neighbouring scripts.
    expect(cellWidth(0x0eb1)).toBe(0); // LAO MAI KAN
    expect(cellWidth(0x0ec8)).toBe(0); // LAO TONE MAI EK
    expect(cellWidth(0x093c)).toBe(0); // DEVANAGARI NUKTA
    expect(cellWidth(0x094d)).toBe(0); // DEVANAGARI VIRAMA
    expect(cellWidth(0x064b)).toBe(0); // ARABIC FATHATAN
    expect(cellWidth(0x05b0)).toBe(0); // HEBREW SHEVA
    // Spacing combining marks still take their own cell.
    expect(cellWidth(0x0903)).toBe(1); // DEVANAGARI SIGN VISARGA (Mc)
    expect(cellWidth(0x17b6)).toBe(1); // KHMER VOWEL SIGN AA (Mc)
  });

  it('keeps Thai marks attached to their base consonant, one cell each', () => {
    // ช่วยดู: ช+่ ว ย ด+ู — four cells, not six.
    const g = one('ช่วยดู');
    expect(g.items.map((i) => [i.kind, i.col, i.cells, 'text' in i ? i.text : ''])).toEqual([
      ['glyph', 0, 1, 'ช\u0E48'],
      ['glyph', 1, 1, 'ว'],
      ['glyph', 2, 1, 'ย'],
      ['glyph', 3, 1, 'ด\u0E39'],
    ]);
    expect(g.cols).toBe(4);
    // ที่ยังเปิดอยู่: above, below and tone marks all fold into their base.
    const g2 = one('ที่ยังเปิดอยู่');
    expect(g2.items.map((i) => [i.col, i.cells, 'text' in i ? i.text : ''])).toEqual([
      [0, 1, 'ท\u0E35\u0E48'],
      [1, 1, 'ย\u0E31'],
      [2, 1, 'ง'],
      [3, 1, 'เ'],
      [4, 1, 'ป\u0E34'],
      [5, 1, 'ด'],
      [6, 1, 'อ'],
      [7, 1, 'ย\u0E39\u0E48'],
    ]);
    expect(g2.cols).toBe(8);
  });

  it('keeps ASCII columns after Thai text identical to a desktop terminal', () => {
    // Desktop wcwidth columns: ช=1 ่=0 ว=1 ย=1 ด=1 ู=0 space=1 → 'abc' at column 5.
    const g = one('ช่วยดู abc');
    expect(g.items.filter((i) => i.kind === 'text')).toEqual([
      { kind: 'text', col: 5, cells: 3, text: 'abc', style: {} },
    ]);
    expect(g.cols).toBe(8);
  });
});
