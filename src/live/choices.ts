import { lineText, type Line, type Style } from './ansi';

export type Choice = { label: string; index: number; key?: string };

export type ChoiceSet = {
  layout: 'vertical' | 'horizontal' | 'yesno';
  choices: Choice[];
  selected: number | null;
  context: string[];
};

export type InputStep = { keys: string[] } | { text: string };

const WINDOW = 30;
const BORDER = /^[\s│┃║|▌▐▕]+|[\s│┃║|▌▐▕]+$/g;
const MARKER = /^[❯›>▶►●◉]\s*/;
const VERTICAL = /^([❯›>▶►●◉○◯]\s*)?(?:\[|\()?(\d{1,2}|[a-zA-Z])(?:[.)\]:])\s+(\S.*)$/;
const YESNO = /[[(](y\/n|Y\/n|y\/N|yes\/no|Yes\/No)[\])]/;
const HINT = /select|confirm|enter|⇆|←|→|tab\b/i;

const strip = (s: string) => s.replace(BORDER, '');

const shade = (st: Style) => (st.inverse ? `inv:${st.fg ?? ''}` : (st.bg ?? ''));

function contextAbove(lines: string[], at: number): string[] {
  const out: string[] = [];
  for (let i = at - 1; i >= 0 && out.length < 3; i--) {
    const t = strip(lines[i]).trim();
    if (t) out.unshift(t);
  }
  return out;
}

function findVertical(texts: string[]): ChoiceSet | null {
  let best: { start: number; choices: Choice[]; selected: number | null } | null = null;
  for (let i = 0; i < texts.length; i++) {
    const run: Choice[] = [];
    let selected: number | null = null;
    let j = i;
    for (; j < texts.length; j++) {
      const m = VERTICAL.exec(strip(texts[j]).trim());
      if (!m) break;
      const key = m[2];
      const expected = run.length === 0 ? null : nextKey(run[run.length - 1].key as string);
      if (run.length === 0 ? !(key === '1' || key.toLowerCase() === 'a') : key !== expected) break;
      if (m[1] && MARKER.test(m[1])) selected = run.length;
      run.push({ label: m[3].replace(/\s{2,}.*$/, '').trim(), index: run.length, key });
    }
    if (run.length >= 2) best = { start: i, choices: run, selected };
    if (j > i) i = j - 1;
  }
  if (!best) return null;
  return {
    layout: 'vertical',
    choices: best.choices,
    selected: best.selected,
    context: contextAbove(texts, best.start),
  };
}

const nextKey = (k: string) => (/\d/.test(k) ? String(Number(k) + 1) : String.fromCharCode(k.charCodeAt(0) + 1));

function segments(line: Line): { segs: { text: string; shade: string }[]; gapShade: string } {
  const out: { text: string; shade: string; gap: number }[] = [];
  let cur: { text: string; shade: string; gap: number } | null = null;
  const gaps = new Map<string, number>();
  for (const span of line) {
    for (const ch of span.text) {
      if (ch === ' ' || /[│┃║|▌▐▕]/.test(ch)) {
        if (cur) {
          cur.gap++;
          if (cur.gap >= 3) gaps.set(shade(span.style), (gaps.get(shade(span.style)) ?? 0) + 1);
        }
        continue;
      }
      if (!cur || cur.gap >= 3) {
        cur = { text: ch, shade: shade(span.style), gap: 0 };
        out.push(cur);
      } else {
        cur.text += ' '.repeat(cur.gap) + ch;
        cur.gap = 0;
      }
    }
  }
  const gapShade = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return { segs: out.map(({ text, shade }) => ({ text: text.trim(), shade })), gapShade };
}

function findHorizontal(lines: Line[], texts: string[]): ChoiceSet | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const { segs, gapShade } = segments(lines[i]);
    if (segs.length < 2 || segs.length > 5) continue;
    if (!segs.every((s) => s.text.length <= 24 && /^[A-Z]/.test(s.text) && s.text.split(' ').length <= 4)) continue;
    const near = texts.slice(Math.max(0, i - 6), i + 4).join('\n');
    if (!HINT.test(texts.slice(i + 1, i + 4).join('\n')) && !/\?|permission|allow|approve|continue/i.test(near))
      continue;
    const lit = segs.flatMap((s, k) => (s.shade !== gapShade ? [k] : []));
    const selected = lit.length === 1 ? lit[0] : null;
    return {
      layout: 'horizontal',
      choices: segs.map((s, index) => ({ label: s.text, index })),
      selected,
      context: contextAbove(texts, i),
    };
  }
  return null;
}

function findYesNo(texts: string[]): ChoiceSet | null {
  for (let i = texts.length - 1; i >= Math.max(0, texts.length - 6); i--) {
    if (YESNO.test(texts[i])) {
      return {
        layout: 'yesno',
        choices: [
          { label: 'Yes', index: 0, key: 'y' },
          { label: 'No', index: 1, key: 'n' },
        ],
        selected: null,
        context: [...contextAbove(texts, i), strip(texts[i]).trim()].slice(-3),
      };
    }
  }
  return null;
}

export function parseChoices(screen: Line[]): ChoiceSet | null {
  let end = screen.length;
  while (end > 0 && !lineText(screen[end - 1]).trim()) end--;
  const lines = screen.slice(Math.max(0, end - WINDOW), end);
  const texts = lines.map(lineText);
  return findVertical(texts) ?? findHorizontal(lines, texts) ?? findYesNo(texts);
}

export function answerSteps(set: ChoiceSet, target: number): InputStep[] {
  const choice = set.choices[target];
  if (set.layout === 'yesno') return [{ text: choice.key as string }, { keys: ['enter'] }];
  if (set.layout === 'vertical' && set.selected === null) return [{ text: choice.key as string }];
  const from = set.selected ?? 0;
  const delta = target - from;
  const [back, fwd] = set.layout === 'vertical' ? ['up', 'down'] : ['left', 'right'];
  const steps: InputStep[] = [];
  if (delta) steps.push({ keys: Array(Math.abs(delta)).fill(delta > 0 ? fwd : back) });
  steps.push({ keys: ['enter'] });
  return steps;
}

export const FALLBACK_KEYS = [
  { key: 'enter', label: '⏎ Enter' },
  { key: 'esc', label: 'Esc' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
];
