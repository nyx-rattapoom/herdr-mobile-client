const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function stripUnsafe(s: string): string {
  return s.replace(UNSAFE, '');
}

export function cleanLabel(v: unknown, max = 80): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = stripUnsafe(v.replace(/[\t\n\r\v\f]+/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
