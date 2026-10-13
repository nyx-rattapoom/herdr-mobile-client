import type { LiveStatus } from './LiveSession';

export type PillKind = 'working' | 'blocked' | 'reconnecting' | 'offline';
export type Pill = { kind: PillKind; text: string; /** Tapping retries the connection. */ retry: boolean };

/** `45s`, `3m 07s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * What the pane's status pill shows, most important first: connection trouble, then the agent
 * needing the user, then how long it has been working. Null when there is nothing to say.
 * `since` is when the phone saw the status change (0 when it was already so at connect).
 */
export function pillFor(
  live: LiveStatus,
  agent: string | undefined,
  since: number | undefined,
  now: number,
): Pill | null {
  if (live === 'reconnecting') return { kind: 'reconnecting', text: 'Reconnecting… tap to retry', retry: true };
  if (live === 'offline') return { kind: 'offline', text: 'Offline · tap to reconnect', retry: true };
  if (live === 'unsupported') return { kind: 'offline', text: 'Not supported · tap to check again', retry: true };
  if (agent === 'blocked') return { kind: 'blocked', text: 'Needs you', retry: false };
  if (agent === 'working') {
    return { kind: 'working', text: since ? `Working · ${formatElapsed(now - since)}` : 'Working', retry: false };
  }
  return null;
}
