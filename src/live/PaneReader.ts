export type PaneOutput = { text: string; truncated: boolean; lines: number };

type Query = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

export const DEFAULT_LINES = 300;
export const MAX_LINES = 10_000;

/**
 * Polls `pane.read` (source `recent`, which includes scrollback) while a pane is on screen.
 * Herdr has no output-stream event, so polling is the read path; unchanged text is not
 * re-emitted and polls never overlap.
 */
export class PaneReader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private last: PaneOutput | null = null;
  private lines = DEFAULT_LINES;

  constructor(
    private readonly query: Query,
    private readonly paneId: string,
    private readonly onOutput: (o: PaneOutput) => void,
    private readonly onError: (e: unknown) => void,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Grows the scrollback window and reads immediately. Returns false at the cap. */
  loadMore(): boolean {
    if (this.lines >= MAX_LINES) return false;
    this.lines = Math.min(this.lines * 4, MAX_LINES);
    this.pokeNow();
    return true;
  }

  /** Reads now instead of waiting for the next interval, e.g. right after sending input. */
  pokeNow(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.tick();
  }

  get windowLines(): number {
    return this.lines;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      const lines = this.lines;
      const res = await this.query<{ read?: { text?: string; truncated?: boolean } }>('pane.read', {
        pane_id: this.paneId,
        source: 'recent',
        lines,
        format: 'ansi',
      });
      const out: PaneOutput = { text: res?.read?.text ?? '', truncated: res?.read?.truncated === true, lines };
      if (this.running && (!this.last || out.text !== this.last.text || out.lines !== this.last.lines)) {
        this.last = out;
        this.onOutput(out);
      }
    } catch (e) {
      if (this.running) this.onError(e);
    } finally {
      this.inFlight = false;
      if (this.running && !this.timer) this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, this.intervalMs);
    }
  }
}
