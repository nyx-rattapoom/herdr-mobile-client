export type Resumable = { alive(): Promise<boolean>; close(): void };
export type Retryable = { getState(): { status: string }; retryNow(): void };

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
  isFatal: (e: unknown) => boolean;
  canReopen?: () => boolean;
  onState?: (s: ReconnectState) => void;
  retryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
};

export class Reconnector {
  private state: ReconnectState = { kind: 'idle' };
  private running = false;
  private again = false;
  private nudge = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ReconnectOptions) {}

  getState(): ReconnectState {
    return this.state;
  }

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
          if (this.nudge) this.opts.lives().forEach((l) => l.getState().status !== 'live' && l.retryNow());
          this.nudge = false;
          continue;
        }
        if (this.stopped || this.opts.current() !== c) return;
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
        this.nudge = false;
        this.set({ kind: 'idle' });
        this.opts.lives().forEach((l) => l.retryNow());
      }
    } finally {
      this.running = false;
    }
  }

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
