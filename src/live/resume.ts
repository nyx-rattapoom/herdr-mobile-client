/** The parts of an SSH connection that resuming needs. */
export type Resumable = { alive(): Promise<boolean>; close(): void };
/** The parts of a live view that resuming needs. */
export type Retryable = { getState(): { status: string }; retryNow(): void };

/**
 * `idle`: nothing to do. `reconnecting`: the SSH session is dead and a new one is being opened,
 * again after `retryAt` if the last try failed. `waiting`: reopening isn't possible right now
 * (e.g. locked credentials in the background). `failed`: retrying can't help; the user must act.
 */
export type ReconnectState =
  | { kind: 'idle' }
  | { kind: 'reconnecting'; attempt: number; error?: unknown; retryAt?: number }
  | { kind: 'waiting' }
  | { kind: 'failed'; error: unknown };

export type ReconnectOptions = {
  current: () => Resumable | null;
  reopen: () => Promise<Resumable>;
  install: (next: Resumable) => void;
  lives: () => Retryable[];
  /** Errors from `reopen` that retrying cannot fix (auth, host key, …). */
  isFatal: (e: unknown) => boolean;
  /** Whether `reopen` may run now; otherwise wait for the next kick. */
  canReopen?: () => boolean;
  onState?: (s: ReconnectState) => void;
  /** Backoff between failed reopens: base delay, doubled per attempt up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
};

/**
 * Keeps the SSH connection behind every live view working. Each kick (back in the foreground,
 * a view that lost its session, a request that timed out, the Reconnect button) checks the
 * connection; a dead one is replaced in place, retrying with backoff until it works, retrying
 * cannot help, or `stop()`. Kicks during a check are coalesced, never dropped, and cut a backoff
 * wait short. `current` is read again after reconnecting: if it changed, the user left meanwhile
 * and the new connection is closed.
 */
export class Reconnector {
  private state: ReconnectState = { kind: 'idle' };
  private running = false;
  private again = false;
  /** A kick from the user or the foreground: views that aren't live retry at once. */
  private nudge = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ReconnectOptions) {}

  getState(): ReconnectState {
    return this.state;
  }

  /**
   * Checks the connection now. `auto` kicks come from the app itself: they neither override a
   * failure that needs the user, cut a backoff wait short, nor make views on a working connection
   * retry. The Reconnect button and returning to the foreground do all three.
   */
  kick({ auto = false }: { auto?: boolean } = {}): void {
    if (this.stopped) return;
    if (auto && this.state.kind === 'failed') return;
    this.again = true;
    if (!auto) this.nudge = true;
    if (this.running) {
      if (!auto) this.wake?.();
      return;
    }
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private async run(): Promise<void> {
    this.running = true;
    let attempt = 0;
    try {
      while (this.again && !this.stopped) {
        this.again = false;
        const c = this.opts.current();
        if (!c) return this.set({ kind: 'idle' });
        if (await c.alive()) {
          if (this.stopped) return;
          attempt = 0;
          this.set({ kind: 'idle' });
          // Automatic kicks leave views on a working connection to their own backoff: retrying
          // them here would cancel an attempt in flight, and a view that fails for another
          // reason would retry as fast as it can report errors.
          if (this.nudge) this.opts.lives().forEach((l) => l.getState().status !== 'live' && l.retryNow());
          this.nudge = false;
          continue;
        }
        if (this.stopped || this.opts.current() !== c) return;
        // A link that stopped answering may still look connected; close it so every view fails
        // fast instead of waiting out channel timeouts, and shows it is reconnecting.
        c.close();
        if (this.opts.canReopen && !this.opts.canReopen()) {
          this.set({ kind: 'waiting' });
          continue;
        }
        attempt++;
        const prev = this.state.kind === 'reconnecting' ? this.state.error : undefined;
        this.set({ kind: 'reconnecting', attempt, error: prev });
        let next: Resumable;
        try {
          next = await this.opts.reopen();
        } catch (e) {
          if (this.stopped || this.opts.current() !== c) return;
          if (this.opts.isFatal(e)) {
            this.set({ kind: 'failed', error: e });
            continue;
          }
          const delay = Math.min((this.opts.retryMs ?? 1000) * 2 ** (attempt - 1), this.opts.maxRetryMs ?? 30_000);
          this.set({ kind: 'reconnecting', attempt, error: e, retryAt: (this.opts.now ?? Date.now)() + delay });
          await this.sleep(delay);
          this.again = true;
          continue;
        }
        if (this.stopped || this.opts.current() !== c) {
          next.close();
          return;
        }
        this.opts.install(next);
        attempt = 0;
        this.nudge = false; // Retried just now; again would cancel these attempts.
        this.set({ kind: 'idle' });
        this.opts.lives().forEach((l) => l.retryNow());
      }
    } finally {
      this.running = false;
    }
  }

  /** Waits `ms`, or less if kicked or stopped meanwhile. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => this.wake?.(), ms);
    });
  }

  private set(s: ReconnectState): void {
    this.state = s;
    this.opts.onState?.(s);
  }
}
