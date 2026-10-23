import { LineBuffer, type Transport } from './transport';

export const MAX_LINE_CHARS = 2 * 1024 * 1024;

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HerdrApiError';
  }
}

export type HerdrEvent = { event: string; data: Record<string, unknown> };

type Pending = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class HerdrClient {
  private readonly lines = new LineBuffer();
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closedReason: string | null = null;
  private eventHandler: (e: HerdrEvent) => void = () => {};
  private streamErrorHandler: (e: HerdrApiError) => void = () => {};
  private closeHandlers: ((reason: string) => void)[] = [];

  constructor(
    private readonly transport: Transport,
    private readonly timeoutMs = 10_000,
  ) {
    transport.onData((chunk) => this.handleData(chunk));
    transport.onClose((reason) => this.fail(new HerdrApiError('closed', `connection closed: ${reason}`)));
  }

  onEvent(handler: (e: HerdrEvent) => void): void {
    this.eventHandler = handler;
  }

  onStreamError(handler: (e: HerdrApiError) => void): void {
    this.streamErrorHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    if (this.closedReason !== null) handler(this.closedReason);
    else this.closeHandlers.push(handler);
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (this.closedReason !== null) {
      throw new HerdrApiError('closed', `connection closed: ${this.closedReason}`);
    }
    const id = `req_${this.nextId++}`;
    const line = JSON.stringify({ id, method, params }) + '\n';
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HerdrApiError('timeout', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.transport.write(line);
    } catch (e) {
      this.settle(id)?.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return result as Promise<T>;
  }

  close(): void {
    this.transport.close();
    this.fail(new HerdrApiError('closed', 'connection closed by client'));
  }

  private handleData(chunk: string): void {
    if (this.closedReason !== null) return;
    for (const line of this.lines.push(chunk)) {
      if (line.length > MAX_LINE_CHARS) return this.overflow();
      this.handleLine(line);
    }
    if (this.lines.remainder.length > MAX_LINE_CHARS) this.overflow();
  }

  private overflow(): void {
    this.transport.close();
    this.fail(new HerdrApiError('protocol', `response line longer than ${MAX_LINE_CHARS} characters`));
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const { id, result, error, event, data } = msg as Record<string, unknown>;
    if (typeof event === 'string' && id === undefined) {
      this.eventHandler({ event, data: typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {} });
      return;
    }
    const err = error !== undefined ? toApiError(error) : null;
    if (err && (id === '' || id === undefined) && this.pending.size === 1) {
      this.settle([...this.pending.keys()][0])?.reject(err);
      return;
    }
    if (typeof id !== 'string') return;
    const p = this.settle(id);
    if (!p) {
      if (err) this.streamErrorHandler(err);
      return;
    }
    if (err) {
      p.reject(err);
    } else {
      p.resolve(result);
    }
  }

  private settle(id: string): Pending | undefined {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
    return p;
  }

  private fail(err: HerdrApiError): void {
    if (this.closedReason !== null) return;
    this.closedReason = err.message;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
    const handlers = this.closeHandlers;
    this.closeHandlers = [];
    handlers.forEach((h) => h(err.message));
  }
}

function toApiError(error: unknown): HerdrApiError {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  return new HerdrApiError(
    typeof e.code === 'string' ? e.code : 'unknown',
    typeof e.message === 'string' ? e.message : 'request failed',
  );
}
