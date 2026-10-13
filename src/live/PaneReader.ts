export type PaneOutput = { text: string; truncated: boolean; lines: number };

type Query = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

export const DEFAULT_LINES = 300;
export const MAX_LINES = 10_000;
/** Upper bound on text handed to the ANSI parser and renderer; the newest output is kept. */
export const MAX_TEXT_CHARS = 1_000_000;

/** Keeps the last `max` characters, starting at a line boundary when possible. */
export function capText(text: string, max = MAX_TEXT_CHARS): { text: string; capped: boolean } {
  if (text.length <= max) return { text, capped: false };
  const tail = text.slice(text.length - max);
  const nl = tail.indexOf('\n');
  return { text: nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail, capped: true };
}

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
  /** The previous read failed; the next success is re-emitted even if unchanged, clearing the error. */
  private failed = false;
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
      const raw = typeof res?.read?.text === 'string' ? res.read.text : '';
      const { text, capped } = capText(raw);
      const out: PaneOutput = { text, truncated: capped || res?.read?.truncated === true, lines };
      if (this.running && (!this.last || this.failed || out.text !== this.last.text || out.lines !== this.last.lines)) {
        this.last = out;
        this.failed = false;
        this.onOutput(out);
      }
    } catch (e) {
      this.failed = true;
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
