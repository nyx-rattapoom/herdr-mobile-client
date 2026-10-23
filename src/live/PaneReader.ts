export type PaneOutput = { text: string; truncated: boolean; lines: number };
export type AgentHistory = { text: string; truncated: boolean };

type Query = <T>(method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

export const DEFAULT_LINES = 300;
export const MAX_LINES = 10_000;
export const HISTORY_LINES = 1000;
export const HISTORY_TIMEOUT_MS = 25_000;
export const MAX_TEXT_CHARS = 1_000_000;

export function capText(text: string, max = MAX_TEXT_CHARS): { text: string; capped: boolean } {
  if (text.length <= max) return { text, capped: false };
  const tail = text.slice(text.length - max);
  const nl = tail.indexOf('\n');
  return { text: nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail, capped: true };
}

export class PaneReader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private last: PaneOutput | null = null;
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

  loadMore(): boolean {
    if (this.lines >= MAX_LINES) return false;
    this.lines = Math.min(this.lines * 4, MAX_LINES);
    this.pokeNow();
    return true;
  }

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
