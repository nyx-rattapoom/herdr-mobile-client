/** The parts of an SSH connection that resuming needs. */
export type Resumable = { alive(): Promise<boolean>; close(): void };
/** The parts of a live view that resuming needs. */
export type Retryable = { getState(): { status: string }; retryNow(): void };

export type ResumeResult = 'alive' | 'reconnected' | 'abandoned';

/**
 * After the app comes back to the foreground: keep a live connection (nudging views that aren't
 * live to retry now), or replace a dead one in place and let every view retry over it.
 * `current` is read again after reconnecting: if it changed, the user left meanwhile and the
 * new connection is closed.
 */
export async function resumeConnection(opts: {
  current: () => Resumable | null;
  reopen: () => Promise<Resumable>;
  install: (next: Resumable) => void;
  lives: Retryable[];
  onReconnecting?: () => void;
}): Promise<ResumeResult> {
  const c = opts.current();
  if (!c) return 'abandoned';
  if (await c.alive()) {
    opts.lives.forEach((l) => l.getState().status !== 'live' && l.retryNow());
    return 'alive';
  }
  opts.onReconnecting?.();
  const next = await opts.reopen();
  if (opts.current() !== c) {
    next.close();
    return 'abandoned';
  }
  c.close();
  opts.install(next);
  opts.lives.forEach((l) => l.retryNow());
  return 'reconnected';
}
