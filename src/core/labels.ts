import type { CoreTerminal } from './types';

export const SEEN_LABEL = 'herdr.seen';
export const PINNED_LABEL = 'herdr.pinned';

export type Attention = 'needs' | 'working' | 'done' | 'idle' | 'unknown' | 'finished';

const parseTurn = (v: string | undefined): number | null => {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

/** The last turn a person looked at, or null when the label is missing/invalid. */
export function seenOf(t: Pick<CoreTerminal, 'labels'>): number | null {
  return parseTurn(t.labels[SEEN_LABEL]);
}

/** A missing label is not turn 0: any finished turn then counts as done. */
export function attentionOf(t: CoreTerminal): Attention {
  if (t.state !== 'live') return 'finished';
  const word = t.status?.state;
  if (!word) return 'unknown';
  if (word === 'blocked' || word === 'error') return 'needs';
  if (word === 'working') return 'working';
  const seen = seenOf(t);
  if (seen === null) return t.turn > 0 ? 'done' : 'idle';
  return t.turn > seen ? 'done' : 'idle';
}

export const isPinned = (t: Pick<CoreTerminal, 'labels'>): boolean => (t.labels[PINNED_LABEL] ?? '') !== '';

/**
 * How the phone's viewer affects `herdr.seen`.
 *
 * Raise-only, once per turn while the terminal stays on screen. `written` is
 * the turn this viewer already raised it to; it is reset when the terminal
 * stops being visible so a later viewing transition may raise it again.
 * Another client's mark-unread therefore survives until a real re-view.
 */
export function seenRaise(t: CoreTerminal, written: number | null): number | null {
  if (t.state !== 'live') return null;
  const seen = seenOf(t);
  if (seen !== null && t.turn <= seen) return null;
  if (written !== null && t.turn <= written) return null;
  return t.turn;
}

/** Explicit "mark unread": the one lower write; at turn 0 there is nothing to mark. */
export function seenMarkUnread(t: CoreTerminal): number | null {
  return t.turn > 0 ? t.turn - 1 : null;
}

export function pinnedLabels(pinned: boolean): Record<string, string> {
  return { [PINNED_LABEL]: pinned ? '1' : '' };
}

const rank: Record<Attention, number> = { needs: 0, done: 1, working: 2, unknown: 3, idle: 4, finished: 5 };

/** Pinned first, then needing attention, done, working, unknown, idle, finished. */
export function compareTerminals(a: CoreTerminal, b: CoreTerminal): number {
  const pin = Number(isPinned(b)) - Number(isPinned(a));
  if (pin) return pin;
  const r = rank[attentionOf(a)] - rank[attentionOf(b)];
  if (r) return r;
  return a.address.localeCompare(b.address);
}
