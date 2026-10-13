export type Style = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};
export type Span = { text: string; style: Style };
export type Line = Span[];

const BASE16 = [
  '#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
  '#666666', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#eaeaea',
];

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** xterm 256-colour palette. */
export function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`;
  }
  const g = 8 + (n - 232) * 10;
  return `#${hex(g)}${hex(g)}${hex(g)}`;
}

function applySgr(style: Style, params: number[]): Style {
  let s = { ...style };
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) s = {};
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) s.bold = s.dim = undefined;
    else if (p === 23) s.italic = undefined;
    else if (p === 24) s.underline = undefined;
    else if (p === 27) s.inverse = undefined;
    else if (p >= 30 && p <= 37) s.fg = BASE16[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BASE16[p - 90 + 8];
    else if (p >= 40 && p <= 47) s.bg = BASE16[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BASE16[p - 100 + 8];
    else if (p === 39) s.fg = undefined;
    else if (p === 49) s.bg = undefined;
    else if (p === 38 || p === 48) {
      let c: string | undefined;
      if (params[i + 1] === 5) {
        c = color256(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2) {
        const [r, g, b] = params.slice(i + 2, i + 5).map((v) => Math.max(0, Math.min(255, v | 0)));
        c = `#${hex(r)}${hex(g)}${hex(b)}`;
        i += 4;
      }
      if (p === 38) s.fg = c;
      else s.bg = c;
    }
  }
  // Drop undefined keys so styles compare cleanly.
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Style;
}

const sameStyle = (a: Style, b: Style) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Parses terminal text with ANSI escapes into styled lines. Only SGR is interpreted; other
 * CSI, OSC and two-byte escapes are removed. CR handling is line-oriented: `\r\n` ends a line
 * and a lone `\r` is dropped.
 */
export function parseAnsi(input: string): Line[] {
  const lines: Line[] = [];
  let line: Line = [];
  let style: Style = {};
  let buf = '';

  const flushText = () => {
    if (!buf) return;
    const last = line[line.length - 1];
    if (last && sameStyle(last.style, style)) last.text += buf;
    else line.push({ text: buf, style });
    buf = '';
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\x1b') {
      const next = input[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < input.length && !(input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e)) j++;
        const final = input[j];
        if (final === 'm') {
          flushText();
          const body = input.slice(i + 2, j);
          const params = body === '' ? [] : body.split(/[;:]/).map((v) => (v === '' ? 0 : Number(v)));
          style = applySgr(style, params.map((n) => (Number.isFinite(n) ? n : 0)));
        }
        i = j;
      } else if (next === ']') {
        // OSC: terminated by BEL or ST (ESC \).
        let j = i + 2;
        while (j < input.length && input[j] !== '\x07' && !(input[j] === '\x1b' && input[j + 1] === '\\')) j++;
        i = input[j] === '\x07' ? j : j + 1;
      } else {
        // nF / Fp escapes: optional intermediates (0x20–0x2f), then one final byte.
        let j = i + 1;
        while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
        i = j;
      }
    } else if (ch === '\n') {
      flushText();
      lines.push(line);
      line = [];
    } else if (ch === '\r' || (ch < ' ' && ch !== '\t')) {
      // Dropped: lone CR, BEL, other C0 controls.
    } else {
      buf += ch;
    }
  }
  flushText();
  lines.push(line);
  return lines;
}

/** Plain text of a parsed line. */
export const lineText = (l: Line) => l.map((s) => s.text).join('');
