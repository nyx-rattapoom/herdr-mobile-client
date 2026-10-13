/**
 * Control characters (C0 except tab, DEL, C1) and bidirectional overrides/isolates. The latter
 * can visually reorder text (e.g. disguise a command or a server name).
 */
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function stripUnsafe(s: string): string {
  return s.replace(UNSAFE, '');
}

/** One-line, length-limited display text for server-supplied names, labels and titles. */
export function cleanLabel(v: unknown, max = 80): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Line breaks and tabs become spaces before other controls are removed.
  const s = stripUnsafe(v.replace(/[\t\n\r\v\f]+/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
