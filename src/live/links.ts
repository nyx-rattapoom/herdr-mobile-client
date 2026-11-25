export type UrlMatch = { index: number; length: number; url: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"*_~]$/;
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const count = (s: string, ch: string) => s.split(ch).length - 1;

function trimUrl(url: string): string {
  for (;;) {
    const end = url[url.length - 1];
    if (TRAILING.test(end)) url = url.slice(0, -1);
    else if (PAIRS[end] && count(url, end) > count(url, PAIRS[end])) url = url.slice(0, -1);
    else return url;
  }
}

// http(s) URLs in plain text, minus trailing sentence punctuation and unbalanced closing brackets.
export function findUrls(text: string): UrlMatch[] {
  if (!text.includes('://')) return [];
  const out: UrlMatch[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length > url.indexOf('://') + 3) out.push({ index: m.index, length: url.length, url });
  }
  return out;
}
