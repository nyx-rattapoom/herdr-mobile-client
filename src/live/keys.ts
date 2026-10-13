/** A one-shot modifier armed on the key bar. */
export type Modifier = 'ctrl' | 'alt';

/** Herdr key names for punctuation (its key parser names these instead of taking the character). */
const NAMED: Record<string, string> = {
  ' ': 'space',
  '-': 'minus',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '\\': 'backslash',
  "'": 'quote',
  '"': 'double_quote',
  ';': 'semicolon',
  ':': 'colon',
  '%': 'percent',
  '&': 'ampersand',
  '`': 'backtick',
  '+': 'plus',
};

/**
 * The Herdr key name for one typed character with a modifier, e.g. `ctrl+a`, `alt+B`, `ctrl+slash`;
 * null for characters Herdr can't name. Ctrl combinations use the lower-case letter, as terminals do.
 */
export function modifiedChar(mod: Modifier, ch: string): string | null {
  if ([...ch].length !== 1) return null;
  if (/^[A-Za-z0-9]$/.test(ch)) return `${mod}+${mod === 'ctrl' ? ch.toLowerCase() : ch}`;
  const name = NAMED[ch];
  if (name) return `${mod}+${name}`;
  // Other printable characters (e.g. [ ] { } ! ?) are passed as themselves.
  return /^[\x21-\x7e]$/.test(ch) ? `${mod}+${ch}` : null;
}

/** A special key with a modifier, or the key alone when it already carries one (e.g. `ctrl+c`). */
export const modifiedKey = (mod: Modifier, key: string) => (key.includes('+') ? key : `${mod}+${key}`);

/** The character added when an input's text grew by exactly one character at the end. */
export function appendedChar(before: string, after: string): string | null {
  if (!after.startsWith(before)) return null;
  const added = after.slice(before.length);
  return [...added].length === 1 ? added : null;
}

/** Largest paste sent to a pane, in characters. */
export const PASTE_MAX = 64 * 1024;

/**
 * Clipboard text made safe to type into a terminal: CRLF/CR become LF, and control characters
 * other than newline and tab (escape sequences included) are removed. Capped at PASTE_MAX.
 */
export function cleanPaste(raw: string): { text: string; removed: number; truncated: boolean } {
  const normalised = raw.replace(/\r\n?/g, '\n');
  // C0 controls except \t and \n, DEL, and C1 controls.
  const text = normalised.replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '');
  const removed = normalised.length - text.length;
  const truncated = text.length > PASTE_MAX;
  return { text: truncated ? text.slice(0, PASTE_MAX) : text, removed, truncated };
}
