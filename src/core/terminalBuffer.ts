import { applySgr, type Line, type Style } from '../live/ansi';
import { cellWidth } from '../live/grid';
import { Utf8Stream } from './bytes';

/**
 * A bounded, stateful VT buffer for the Core attach stream.
 *
 * The legacy `parseAnsi` reads complete snapshots; live `hc connect` bytes are
 * incremental and cursor-driven, so they need a real screen model. This buffer
 * implements the subset the mobile terminal surface promises (see
 * docs/PROGRESS.md), keeps 10,000 history lines, and never grows without bound.
 */

type Cell = {
  ch: string;
  style: Style;
  /** 1 normal, 2 the first cell of a wide glyph, 0 its continuation. */
  w: 0 | 1 | 2;
};

const blank = (): Cell => ({ ch: ' ', style: {}, w: 1 });
const clone = (c: Cell): Cell => ({ ch: c.ch, style: { ...c.style }, w: c.w });

export const MAX_HISTORY = 10_000;
const MAX_SEQUENCE = 8 * 1024;
const MAX_COLS = 400;
const MAX_ROWS = 300;

export class CoreTerminalBuffer {
  private cells: Cell[][];
  private row = 0;
  private col = 0;
  private style: Style = {};
  private wrapPending = false;
  private autoWrap = true;
  private originMode = false;
  private top = 0;
  private bottom: number;
  private saved: { row: number; col: number; style: Style } | null = null;
  private altScreen = false;
  private savedMain: { cells: Cell[][]; row: number; col: number; style: Style } | null = null;
  /** A ring once full: `historyHead` is the oldest line. */
  private history: Line[] = [];
  private historyHead = 0;
  private tabs = new Set<number>();
  private utf8 = new Utf8Stream();

  // Parser state, kept across writes so split sequences never paint raw bytes.
  private state: 'ground' | 'esc' | 'csi' | 'osc' | 'dcs' | 'charset' = 'ground';
  private seq = '';
  private seqOverflow = false;
  private oscEsc = false;
  private lastCh = ' ';
  private lastWidth: 1 | 2 = 1;

  constructor(
    private _cols: number,
    private _rows: number,
    private readonly historyLimit = MAX_HISTORY,
  ) {
    this._cols = clamp(_cols, 1, MAX_COLS);
    this._rows = clamp(_rows, 1, MAX_ROWS);
    this.bottom = this._rows - 1;
    this.cells = blankGrid(this._cols, this._rows);
    this.resetTabs();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }
  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }
  get alternateScreen(): boolean {
    return this.altScreen;
  }
  get historyLength(): number {
    return this.history.length;
  }

  write(bytes: Uint8Array): void {
    const text = this.utf8.push(bytes);
    for (const ch of text) this.feed(ch);
  }

  reset(): void {
    this.cells = blankGrid(this._cols, this._rows);
    this.row = 0;
    this.col = 0;
    this.style = {};
    this.wrapPending = false;
    this.autoWrap = true;
    this.originMode = false;
    this.top = 0;
    this.bottom = this._rows - 1;
    this.saved = null;
    this.altScreen = false;
    this.savedMain = null;
    this.clearHistory();
    this.state = 'ground';
    this.seq = '';
    this.seqOverflow = false;
    this.utf8.reset();
    this.resetTabs();
  }

  resize(cols: number, rows: number): void {
    const c = clamp(cols, 1, MAX_COLS);
    const r = clamp(rows, 1, MAX_ROWS);
    if (c === this._cols && r === this._rows) return;
    this.cells = resizeGrid(this.cells, this._cols, this._rows, c, r);
    if (this.savedMain) this.savedMain.cells = resizeGrid(this.savedMain.cells, this._cols, this._rows, c, r);
    this._cols = c;
    this._rows = r;
    this.row = Math.min(this.row, r - 1);
    this.col = Math.min(this.col, c - 1);
    this.top = 0;
    this.bottom = r - 1;
    this.wrapPending = false;
  }

  screenLines(): Line[] {
    return this.cells.map((row) => rowToLine(row));
  }

  /**
   * History (oldest first) followed by the current screen, ready for
   * `layoutLine`/`TermRow`. The first `historyLength` lines never change once
   * pushed, so callers may cache their layout by identity.
   */
  allLines(): Line[] {
    const h = this.history;
    return [...h.slice(this.historyHead), ...h.slice(0, this.historyHead), ...this.screenLines()];
  }

  /** Plain-text snapshot for diagnostics and tests. */
  screenText(): string {
    const lines = this.screenLines().map((l) => l.map((s) => s.text).join('').replace(/\s+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  private resetTabs(): void {
    this.tabs.clear();
    for (let x = 8; x < this._cols; x += 8) this.tabs.add(x);
  }

  private feed(ch: string): void {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x18 || cp === 0x1a) {
      this.state = 'ground';
      this.seq = '';
      return;
    }
    switch (this.state) {
      case 'ground':
        this.ground(ch, cp);
        return;
      case 'esc':
        this.escape(ch, cp);
        return;
      case 'csi':
        this.csiChar(ch, cp);
        return;
      case 'osc':
      case 'dcs':
        this.stringChar(ch, cp);
        return;
      case 'charset':
        this.state = 'ground';
        return;
    }
  }

  private ground(ch: string, cp: number): void {
    if (cp === 0x1b) {
      this.state = 'esc';
      return;
    }
    if (cp === 0x9b) {
      this.state = 'csi';
      this.seq = '';
      this.seqOverflow = false;
      return;
    }
    if (cp < 0x20 || cp === 0x7f) {
      this.control(cp);
      return;
    }
    if (cp >= 0x80 && cp <= 0x9f) {
      if (cp === 0x84 || cp === 0x85) this.lineFeed();
      if (cp === 0x8d) this.row = Math.min(this.bottom, this.row + 1);
      return;
    }
    this.print(ch);
  }

  private control(cp: number): void {
    switch (cp) {
      case 0x07:
        return;
      case 0x08:
        this.col = Math.max(0, this.col - 1);
        this.wrapPending = false;
        return;
      case 0x09:
        this.tabForward(1);
        return;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.lineFeed();
        return;
      case 0x0d:
        this.col = 0;
        this.wrapPending = false;
        return;
      case 0x0e:
      case 0x0f:
        return;
      default:
        return;
    }
  }

  private escape(ch: string, cp: number): void {
    switch (ch) {
      case '[':
        this.state = 'csi';
        this.seq = '';
        this.seqOverflow = false;
        return;
      case ']':
        this.state = 'osc';
        this.seq = '';
        this.seqOverflow = false;
        this.oscEsc = false;
        return;
      case 'P':
      case 'X':
      case '^':
      case '_':
        this.state = 'dcs';
        this.seq = '';
        this.seqOverflow = false;
        this.oscEsc = false;
        return;
      case '7':
        this.save();
        this.state = 'ground';
        return;
      case '8':
        this.restore();
        this.state = 'ground';
        return;
      case 'D':
        this.lineFeed();
        this.state = 'ground';
        return;
      case 'E':
        this.col = 0;
        this.lineFeed();
        this.state = 'ground';
        return;
      case 'M':
        this.reverseIndex();
        this.state = 'ground';
        return;
      case 'c':
        this.reset();
        return;
      case 'H':
        this.tabs.add(this.col);
        this.state = 'ground';
        return;
      case '(':
      case ')':
      case '*':
      case '+':
      case '-':
      case '.':
      case '/':
    case '#':
        this.state = 'charset';
        return;
      default:
        if (cp >= 0x20 && cp <= 0x2f) {
          this.state = 'charset';
          return;
        }
        this.state = 'ground';
        return;
    }
  }

  private csiChar(ch: string, cp: number): void {
    if (cp >= 0x40 && cp <= 0x7e) {
      if (!this.seqOverflow) this.csi(ch);
      this.state = 'ground';
      this.seq = '';
      this.seqOverflow = false;
      return;
    }
    if (cp >= 0x20 && cp <= 0x3f) {
      if (this.seq.length < MAX_SEQUENCE) this.seq += ch;
      else this.seqOverflow = true;
      return;
    }
    // Malformed: drop the sequence rather than paint it.
    this.state = 'ground';
    this.seq = '';
  }

  private stringChar(ch: string, cp: number): void {
    if (this.oscEsc) {
      this.oscEsc = false;
      if (ch === '\\') {
        this.finishString();
        return;
      }
      this.oscEsc = cp === 0x1b;
      return;
    }
    if (cp === 0x1b) {
      this.oscEsc = true;
      return;
    }
    if (cp === 0x07) {
      this.finishString();
      return;
    }
    if (this.seq.length < MAX_SEQUENCE) this.seq += ch;
    else this.seqOverflow = true;
  }

  private finishString(): void {
    this.state = 'ground';
    this.seq = '';
    this.seqOverflow = false;
    this.oscEsc = false;
  }

  private csi(final: string): void {
    const raw = this.seq;
    const priv = raw.startsWith('?');
    const secondary = raw.startsWith('>');
    const body = priv || secondary ? raw.slice(1) : raw;
    const params = parseParams(body);
    const p = (i: number, def = 0): number => (params[i] === undefined ? def : params[i]);
    if (secondary) return;
    if (priv) {
      if (final === 'h' || final === 'l') for (const n of params) this.setPrivateMode(n, final === 'h');
      return;
    }
    switch (final) {
      case 'A':
        this.row = Math.max(this.originMode ? this.top : 0, this.row - Math.max(1, p(0, 1)));
        return;
      case 'B':
      case 'e':
        this.row = Math.min(this.originMode ? this.bottom : this._rows - 1, this.row + Math.max(1, p(0, 1)));
        return;
      case 'C':
      case 'a':
        this.col = Math.min(this._cols - 1, this.col + Math.max(1, p(0, 1)));
        this.wrapPending = false;
        return;
      case 'D':
        this.col = Math.max(0, this.col - Math.max(1, p(0, 1)));
        this.wrapPending = false;
        return;
      case 'E':
        this.col = 0;
        this.row = Math.min(this.bottom, this.row + Math.max(1, p(0, 1)));
        return;
      case 'F':
        this.col = 0;
        this.row = Math.max(this.top, this.row - Math.max(1, p(0, 1)));
        return;
      case 'G':
      case '`':
        this.col = clamp(p(0, 1) - 1, 0, this._cols - 1);
        this.wrapPending = false;
        return;
      case 'd':
        this.row = clamp(p(0, 1) - 1 + (this.originMode ? this.top : 0), 0, this._rows - 1);
        return;
      case 'H':
      case 'f': {
        const base = this.originMode ? this.top : 0;
        this.row = clamp(base + p(0, 1) - 1, base, this.originMode ? this.bottom : this._rows - 1);
        this.col = clamp(p(1, 1) - 1, 0, this._cols - 1);
        this.wrapPending = false;
        return;
      }
      case 'J':
        this.eraseDisplay(p(0, 0));
        return;
      case 'K':
        this.eraseLine(p(0, 0));
        return;
      case 'L':
        this.insertLines(Math.max(1, p(0, 1)));
        return;
      case 'M':
        this.deleteLines(Math.max(1, p(0, 1)));
        return;
      case 'P':
        this.deleteChars(Math.max(1, p(0, 1)));
        return;
      case '@':
        this.insertChars(Math.max(1, p(0, 1)));
        return;
      case 'X':
        this.eraseChars(Math.max(1, p(0, 1)));
        return;
      case 'S':
        this.scrollUp(this.top, this.bottom, Math.max(1, p(0, 1)));
        return;
      case 'T':
        this.scrollDown(this.top, this.bottom, Math.max(1, p(0, 1)));
        return;
      case 'r': {
        const t = clamp(p(0, 1) - 1, 0, this._rows - 1);
        const b = clamp(p(1, this._rows) - 1, 0, this._rows - 1);
        if (t < b) {
          this.top = t;
          this.bottom = b;
          this.row = this.originMode ? t : 0;
          this.col = 0;
        }
        return;
      }
      case 's':
        this.save();
        return;
      case 'u':
        this.restore();
        return;
      case 'm':
        this.style = applySgr(this.style, sgrParams(body));
        return;
      case 'b':
        for (let i = 0; i < Math.max(1, p(0, 1)); i++) this.print(this.lastCh, this.lastWidth);
        return;
      case 'g':
        if (p(0, 0) === 0) this.tabs.delete(this.col);
        else if (p(0, 0) === 3) this.tabs.clear();
        return;
      case 'I':
        this.tabForward(Math.max(1, p(0, 1)));
        return;
      case 'Z':
        this.tabBackward(Math.max(1, p(0, 1)));
        return;
      case 'h':
      case 'l':
        return;
      default:
        return;
    }
  }

  private setPrivateMode(n: number, on: boolean): void {
    switch (n) {
      case 6:
        this.originMode = on;
        this.row = 0;
        this.col = 0;
        return;
      case 7:
        this.autoWrap = on;
        return;
      case 47:
      case 1047:
      case 1049:
        if (on) this.enterAlt();
        else this.leaveAlt();
        return;
      default:
        return;
    }
  }

  private enterAlt(): void {
    if (this.altScreen) return;
    this.savedMain = { cells: this.cells, row: this.row, col: this.col, style: this.style };
    this.cells = blankGrid(this._cols, this._rows);
    this.altScreen = true;
    this.row = 0;
    this.col = 0;
    this.top = 0;
    this.bottom = this._rows - 1;
    this.wrapPending = false;
  }

  private leaveAlt(): void {
    if (!this.altScreen || !this.savedMain) return;
    const m = this.savedMain;
    this.cells = m.cells;
    this.row = Math.min(m.row, this._rows - 1);
    this.col = Math.min(m.col, this._cols - 1);
    this.style = m.style;
    this.altScreen = false;
    this.savedMain = null;
    this.top = 0;
    this.bottom = this._rows - 1;
    this.wrapPending = false;
  }

  private save(): void {
    this.saved = { row: this.row, col: this.col, style: { ...this.style } };
  }

  private restore(): void {
    if (!this.saved) return;
    this.row = clamp(this.saved.row, 0, this._rows - 1);
    this.col = clamp(this.saved.col, 0, this._cols - 1);
    this.style = { ...this.saved.style };
    this.wrapPending = false;
  }

  private print(ch: string, declaredWidth?: 1 | 2): void {
    let width: 1 | 2;
    if (declaredWidth) width = declaredWidth;
    else {
      const cw = cellWidth(ch.codePointAt(0) ?? 0);
      if (cw === 0) {
        this.combine(ch);
        return;
      }
      width = cw === 2 ? 2 : 1;
    }
    if (this.wrapPending) {
      if (this.autoWrap) {
        this.col = 0;
        this.lineFeed();
      }
      this.wrapPending = false;
    }
    let w = width;
    if (w === 2 && this.col >= this._cols - 1) {
      if (this.autoWrap) {
        this.col = 0;
        this.lineFeed();
      } else {
        w = 1;
      }
    }
    const space = Math.min(w, this._cols - this.col);
    for (let i = 0; i < space; i++) this.clearCellAt(this.row, this.col + i);
    const cell = this.cells[this.row][this.col];
    cell.ch = ch;
    cell.style = { ...this.style };
    cell.w = space === 2 ? 2 : 1;
    this.lastCh = ch;
    this.lastWidth = cell.w === 2 ? 2 : 1;
    if (space === 2) {
      const cont = this.cells[this.row][this.col + 1];
      cont.ch = '';
      cont.style = { ...this.style };
      cont.w = 0;
    }
    this.col += space;
    if (this.col >= this._cols) {
      this.col = this._cols - 1;
      this.wrapPending = true;
    }
  }

  private combine(ch: string): void {
    let x = this.wrapPending ? this.col : this.col - 1;
    if (x < 0) return;
    while (x > 0 && this.cells[this.row][x].w === 0) x--;
    if (this.cells[this.row][x].w === 0) return;
    this.cells[this.row][x].ch += ch;
  }

  private clearCellAt(row: number, col: number): void {
    if (row < 0 || row >= this._rows || col < 0 || col >= this._cols) return;
    const c = this.cells[row][col];
    if (c.w === 0 && col > 0) this.cells[row][col - 1] = blank();
    else if (c.w === 2 && col + 1 < this._cols) this.cells[row][col + 1] = blank();
    this.cells[row][col] = blank();
  }

  private lineFeed(): void {
    this.wrapPending = false;
    if (this.row === this.bottom) this.scrollUp(this.top, this.bottom, 1);
    else if (this.row < this._rows - 1) this.row++;
  }

  private reverseIndex(): void {
    if (this.row === this.top) this.scrollDown(this.top, this.bottom, 1);
    else if (this.row > 0) this.row--;
  }

  private scrollUp(top: number, bottom: number, n: number): void {
    for (let i = 0; i < n; i++) {
      if (top === 0 && bottom === this._rows - 1 && !this.altScreen) this.pushHistory(rowToLine(this.cells[top]));
      this.cells.splice(top, 1);
      this.cells.splice(bottom, 0, blankRow(this._cols));
    }
  }

  private scrollDown(top: number, bottom: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.cells.splice(bottom, 1);
      this.cells.splice(top, 0, blankRow(this._cols));
    }
  }

  private pushHistory(line: Line): void {
    if (this.historyLimit <= 0) return;
    if (this.history.length < this.historyLimit) {
      this.history.push(line);
      return;
    }
    this.history[this.historyHead] = line;
    this.historyHead = (this.historyHead + 1) % this.historyLimit;
  }

  private clearHistory(): void {
    this.history = [];
    this.historyHead = 0;
  }

  private eraseLine(mode: number): void {
    const row = this.cells[this.row];
    if (mode === 0) for (let x = this.col; x < this._cols; x++) row[x] = blank();
    else if (mode === 1) for (let x = 0; x <= this.col; x++) row[x] = blank();
    else if (mode === 2) for (let x = 0; x < this._cols; x++) row[x] = blank();
  }

  private eraseDisplay(mode: number): void {
    if (mode === 3) {
      this.clearHistory();
      return;
    }
    if (mode === 2) {
      this.cells = blankGrid(this._cols, this._rows);
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.row + 1; y < this._rows; y++) this.cells[y] = blankRow(this._cols);
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.row; y++) this.cells[y] = blankRow(this._cols);
    }
  }

  private insertLines(n: number): void {
    if (this.row < this.top || this.row > this.bottom) return;
    for (let i = 0; i < n; i++) {
      this.cells.splice(this.bottom, 1);
      this.cells.splice(this.row, 0, blankRow(this._cols));
    }
  }

  private deleteLines(n: number): void {
    if (this.row < this.top || this.row > this.bottom) return;
    for (let i = 0; i < n && this.row <= this.bottom; i++) {
      this.cells.splice(this.row, 1);
      this.cells.splice(this.bottom, 0, blankRow(this._cols));
    }
  }

  private insertChars(n: number): void {
    const row = this.cells[this.row];
    for (let i = 0; i < n; i++) row.splice(this.col, 0, blank());
    row.length = this._cols;
  }

  private deleteChars(n: number): void {
    const row = this.cells[this.row];
    row.splice(this.col, n);
    while (row.length < this._cols) row.push(blank());
  }

  private eraseChars(n: number): void {
    for (let i = 0; i < n && this.col + i < this._cols; i++) this.clearCellAt(this.row, this.col + i);
  }

  private tabForward(n: number): void {
    for (let i = 0; i < n; i++) {
      let x = this.col + 1;
      while (x < this._cols - 1 && !this.tabs.has(x)) x++;
      this.col = Math.min(x, this._cols - 1);
    }
    this.wrapPending = false;
  }

  private tabBackward(n: number): void {
    for (let i = 0; i < n; i++) {
      let x = this.col - 1;
      while (x > 0 && !this.tabs.has(x)) x--;
      this.col = Math.max(0, x);
    }
    this.wrapPending = false;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? Math.floor(n) : lo));
}

function parseParams(body: string): number[] {
  if (!body) return [];
  return body.split(';').map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  });
}

function sgrParams(body: string): number[] {
  if (!body) return [];
  return body.split(/[;:]/).map((v) => {
    if (v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
}

function blankRow(cols: number): Cell[] {
  return Array.from({ length: cols }, blank);
}

function blankGrid(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, () => blankRow(cols));
}

function resizeGrid(cells: Cell[][], oldCols: number, oldRows: number, cols: number, rows: number): Cell[][] {
  const next = blankGrid(cols, rows);
  const copyRows = Math.min(rows, oldRows);
  for (let y = 0; y < copyRows; y++) {
    const copyCols = Math.min(cols, oldCols);
    for (let x = 0; x < copyCols; x++) next[y][x] = clone(cells[y][x]);
    // A wide glyph cut by the new right edge cannot keep half a cell.
    if (copyCols > 0 && (next[y][copyCols - 1].w === 2 || next[y][copyCols - 1].w === 0)) {
      next[y][copyCols - 1] = blank();
    }
  }
  return next;
}

const visible = (c: Cell): boolean => !(c.ch === ' ' && c.w === 1 && !c.style.bg && !c.style.inverse && !c.style.underline);

function rowToLine(row: Cell[]): Line {
  const line: Line = [];
  let last = -1;
  for (let x = 0; x < row.length; x++) {
    const c = row[x];
    if (c.w === 0) continue;
    if (visible(c)) last = x;
  }
  if (last < 0) return [];
  let text = '';
  let style: Style | null = null;
  const flush = () => {
    if (!text) return;
    line.push({ text, style: style ?? {} });
    text = '';
  };
  for (let x = 0; x <= last; x++) {
    const c = row[x];
    if (c.w === 0) continue;
    if (style === null) style = { ...c.style };
    else if (!sameStyle(style, c.style)) {
      flush();
      style = { ...c.style };
    }
    text += c.ch;
  }
  flush();
  return line;
}

const sameStyle = (a: Style, b: Style) => JSON.stringify(a) === JSON.stringify(b);
