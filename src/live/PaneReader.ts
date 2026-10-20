export type PaneOutput = { text: string; truncated: boolean; lines: number };
/** `truncated`: Herdr stopped before the top of the agent's history (1000 rows or its time limit). */
export type AgentHistory = { text: string; truncated: boolean };

type Query = <T>(method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

export const DEFAULT_LINES = 300;
export const MAX_LINES = 10_000;
/** Rows asked of a full-screen agent's history; Herdr collects at most 1000. */
export const HISTORY_LINES = 1000;
/** Herdr scrolls the agent for up to 15 s, then up to 5 s to bring it back to the bottom. */
export const HISTORY_TIMEOUT_MS = 25_000;
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
  private history: Promise<AgentHistory> | null = null;

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

  /**
   * Reads a full-screen agent's own transcript once. On the alternate screen `recent` holds only
   * the visible grid; for a plain-text read of an idle agent it recognises, Herdr scrolls the agent
   * and collects the pages. Otherwise it returns the screen as usual. Polling pauses meanwhile so
   * it doesn't capture the agent mid-scroll.
   */
  loadHistory(): Promise<AgentHistory> {
    if (this.history) return this.history;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const read = (async () => {
      const res = await this.query<{ read?: { text?: string; truncated?: boolean } }>(
        'pane.read',
        { pane_id: this.paneId, source: 'recent', lines: HISTORY_LINES, format: 'text' },
        HISTORY_TIMEOUT_MS,
      );
      const { text, capped } = capText(typeof res?.read?.text === 'string' ? res.read.text : '');
      return { text, truncated: capped || res?.read?.truncated === true };
    })();
    this.history = read;
    const resume = () => {
      if (this.history !== read) return;
      this.history = null;
      this.pokeNow();
    };
    read.then(resume, resume);
    return read;
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
    if (!this.running || this.inFlight || this.history) return;
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
