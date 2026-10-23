export type Modifier = 'ctrl' | 'alt';

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

export function modifiedChar(mod: Modifier, ch: string): string | null {
  if ([...ch].length !== 1) return null;
  if (/^[A-Za-z0-9]$/.test(ch)) return `${mod}+${mod === 'ctrl' ? ch.toLowerCase() : ch}`;
  const name = NAMED[ch];
  if (name) return `${mod}+${name}`;
  return /^[\x21-\x7e]$/.test(ch) ? `${mod}+${ch}` : null;
}

export const modifiedKey = (mod: Modifier, key: string) => (key.includes('+') ? key : `${mod}+${key}`);

export function appendedChar(before: string, after: string): string | null {
  if (!after.startsWith(before)) return null;
  const added = after.slice(before.length);
  return [...added].length === 1 ? added : null;
}

export const PASTE_MAX = 64 * 1024;

export function cleanPaste(raw: string): { text: string; removed: number; truncated: boolean } {
  const normalised = raw.replace(/\r\n?/g, '\n');
  const text = normalised.replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '');
  const removed = normalised.length - text.length;
  const truncated = text.length > PASTE_MAX;
  return { text: truncated ? text.slice(0, PASTE_MAX) : text, removed, truncated };
}
