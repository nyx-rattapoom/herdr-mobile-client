import { concatBytes, decodeUtf8, encodeUtf8 } from './bytes';
import { explainCoreClose, explainStrayStdout } from './commands';
import {
  FRAME,
  FrameParser,
  closeFrame,
  creditFrame,
  decodeCredit,
  decodeResize,
  encodeFrame,
  factsFrame,
  focusFrame,
  resizeFrame,
  type Frame,
} from './frames';
import type { ByteTransport, TransportClose } from './transport';
import {
  CORE_GENERATION,
  CoreProtocolError,
  CoreUnsupportedError,
  CoreCommandError,
  parseHello,
  type CoreHello,
} from './types';

export const MAX_EARLY_BYTES = 4 * 1024 * 1024;

const REQUIRED_METHODS = ['terminal.list', 'terminal.attach', 'events.subscribe', 'terminal.label', 'doc.get'] as const;

export type CoreStreamHandlers = {
  onData: (bytes: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onClose: (reason: string) => void;
};

type Pending = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * One `hc connect` connection: plain JSON-RPC hello, then framed multiplexing.
 *
 * Channel 0 carries JSON-RPC. Terminal and event channels carry raw bytes.
 * Bytes are credited only after a consumer accepted them, and channel 0 keeps
 * flowing while a terminal stream is paused.
 */
export class CoreClient {
  private mode: 'plain' | 'framed' | 'closed' = 'plain';
  private readonly frames = new FrameParser();
  private plain: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private helloId: string | null = null;
  private helloResult: CoreHello | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<number, CoreStreamHandlers>();
  private readonly early = new Map<number, { chunks: Uint8Array[]; bytes: number }>();
  private earlyBytes = 0;
  private readonly detached = new Set<number>();
  private eventHandler: (method: string, params: Record<string, unknown>) => void = () => {};
  private readonly closeHandlers: ((err: Error) => void)[] = [];
  private closeError: Error | null = null;

  constructor(
    private readonly transport: ByteTransport,
    private readonly defaultTimeoutMs = 10_000,
  ) {
    transport.onBytes((chunk) => this.receive(chunk));
    transport.onClose((info) => this.transportClosed(info));
  }

  get hello(): CoreHello | null {
    return this.helloResult;
  }

  get closed(): boolean {
    return this.mode === 'closed';
  }

  get framed(): boolean {
    return this.mode === 'framed';
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.eventHandler = handler;
  }

  onClose(handler: (err: Error) => void): void {
    if (this.closeError) handler(this.closeError);
    else this.closeHandlers.push(handler);
  }

  /** Plain hello, then the framed switch. Resolves only after full validation. */
  async handshake(timeoutMs = this.defaultTimeoutMs): Promise<CoreHello> {
    const id = `c${this.nextId++}`;
    this.helloId = id;
    let raw: unknown;
    try {
      raw = await this.send('hello', { generation: CORE_GENERATION, framed: true }, timeoutMs, id);
    } catch (e) {
      if (e instanceof CoreProtocolError && e.code === 'unsupported_generation') {
        throw new CoreUnsupportedError(
          'unsupported_generation',
          `This server rejected Herdr Core protocol generation ${CORE_GENERATION}; update herdr-core on the server or use Herdr TUI.`,
        );
      }
      throw e;
    }
    const hello = parseHello(raw);
    if (hello.generation !== CORE_GENERATION) {
      throw new CoreUnsupportedError(
        'unsupported_generation',
        `This server speaks Herdr Core protocol generation ${hello.generation}; this app supports generation ${CORE_GENERATION}.`,
      );
    }
    if (!hello.framed) throw new CoreUnsupportedError('unsupported_framed', 'This Herdr Core did not switch to framed mode.');
    const missing = REQUIRED_METHODS.filter((m) => !hello.methods.includes(m));
    if (missing.length) {
      throw new CoreUnsupportedError(
        'unsupported_methods',
        `This Herdr Core is missing ${missing.join(', ')}. Update herdr-core on the server; the app will not fall back to Herdr TUI.`,
      );
    }
    this.helloResult = hello;
    return hello;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.mode === 'closed') throw this.closeError ?? new CoreCommandError('closed', 'connection closed');
    if (this.mode === 'plain' && method !== 'hello') {
      throw new CoreProtocolError('framed', 'requests are not available before the hello handshake');
    }
    const id = `c${this.nextId++}`;
    return (await this.send(method, params, timeoutMs, id)) as T;
  }

  private send(method: string, params: Record<string, unknown>, timeoutMs: number, id: string): Promise<unknown> {
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CoreProtocolError('timeout', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    const write =
      this.mode === 'framed'
        ? this.transport.write(encodeFrame(0, FRAME.DATA, encodeUtf8(message)))
        : this.transport.write(encodeUtf8(`${message}\n`));
    write.catch((e) => this.settle(id, e instanceof Error ? e : new Error(String(e))));
    return result;
  }

  private settle(id: string, err: Error | null, result?: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(result);
  }

  registerStream(channel: number, handlers: CoreStreamHandlers): void {
    if (this.mode === 'closed') {
      handlers.onClose('connection closed');
      return;
    }
    this.streams.set(channel, handlers);
    this.detached.delete(channel);
    const early = this.takeEarly(channel);
    if (early) for (const chunk of early.chunks) handlers.onData(chunk);
  }

  private takeEarly(channel: number): { chunks: Uint8Array[]; bytes: number } | undefined {
    const early = this.early.get(channel);
    if (!early) return undefined;
    this.early.delete(channel);
    this.earlyBytes -= early.bytes;
    return early;
  }

  /**
   * Viewer input on an attached terminal.
   *
   * Core grants the *viewer* 256 KiB of credit for data it sends; the viewer
   * sends CREDIT for bytes it consumed. Input in the other direction has no
   * core-granted credit, so it is written immediately (and must not wait for a
   * CREDIT frame that never comes).
   */
  async writeStream(channel: number, bytes: Uint8Array, automatic = false): Promise<void> {
    if (!this.streams.has(channel)) throw new CoreProtocolError('channel', `channel ${channel} is not open`);
    if (bytes.length === 0) return;
    await this.transport.write(encodeFrame(channel, automatic ? FRAME.AUTOMATIC_INPUT : FRAME.DATA, bytes));
  }

  resize(channel: number, cols: number, rows: number): Promise<void> {
    return this.transport.write(resizeFrame(channel, cols, rows));
  }

  focus(channel: number, gained: boolean): Promise<void> {
    return this.transport.write(focusFrame(channel, gained));
  }

  facts(channel: number, facts: unknown): Promise<void> {
    return this.transport.write(factsFrame(channel, facts));
  }

  /** Detach a viewer. Never kills the terminal. */
  closeStream(channel: number): void {
    if (this.mode !== 'framed' || this.closed) return;
    const stream = this.streams.get(channel);
    this.streams.delete(channel);
    this.takeEarly(channel);
    this.detached.add(channel);
    void this.transport.write(closeFrame(channel, 'detached')).catch(() => {});
    stream?.onClose('detached');
  }

  close(): void {
    if (this.mode === 'closed') return;
    this.fail(new CoreCommandError('closed', 'connection closed'));
    this.transport.close();
  }

  private receive(chunk: Uint8Array): void {
    if (this.mode === 'closed') return;
    if (this.mode === 'plain') {
      this.plain = this.plain.length ? concatBytes(this.plain, chunk) : chunk;
      this.drainPlain();
      return;
    }
    this.drainFrames(chunk);
  }

  private drainPlain(): void {
    while (this.mode === 'plain') {
      const nl = this.plain.indexOf(0x0a);
      if (nl < 0) {
        if (this.plain.length > 4 * 1024 * 1024) {
          this.fail(explainStrayStdout(decodeUtf8(this.plain.subarray(0, 200))));
        }
        return;
      }
      const line = this.plain.subarray(0, nl);
      this.plain = this.plain.subarray(nl + 1);
      if (line.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(decodeUtf8(line));
      } catch {
        this.fail(explainStrayStdout(decodeUtf8(line)));
        return;
      }
      this.handleMessage(message, true);
    }
    // Everything after the hello reply line is framed, even if coalesced.
    if (this.mode === 'framed' && this.plain.length) {
      const rest = this.plain;
      this.plain = new Uint8Array(0);
      this.drainFrames(rest);
    }
  }

  private drainFrames(chunk: Uint8Array): void {
    let frames: Frame[];
    try {
      frames = this.frames.push(chunk);
    } catch (e) {
      this.fail(asError(e));
      return;
    }
    for (const frame of frames) {
      if (this.mode === 'closed') return;
      try {
        this.handleFrame(frame);
      } catch (e) {
        this.fail(asError(e));
        return;
      }
    }
  }

  private handleFrame(frame: Frame): void {
    switch (frame.kind) {
      case FRAME.DATA:
      case FRAME.AUTOMATIC_INPUT:
        if (frame.channel === 0) this.handleChannel0(frame.payload);
        else this.handleStreamData(frame.channel, frame.payload);
        return;
      case FRAME.CREDIT: {
        // The core never grants viewer input credit; this frame only matters
        // for peers that credit their output window. It is validated and
        // otherwise ignored (no input queue waits on it).
        const n = decodeCredit(frame.payload);
        if (n === null) throw new CoreProtocolError('credit', 'invalid CREDIT frame');
        return;
      }
      case FRAME.CLOSE:
        this.handleStreamClose(frame.channel, frame.payload);
        return;
      case FRAME.RESIZE: {
        const size = decodeResize(frame.payload);
        if (!size) throw new CoreProtocolError('resize', 'invalid RESIZE frame');
        this.streams.get(frame.channel)?.onResize?.(size.cols, size.rows);
        return;
      }
      case FRAME.FOCUS:
      case FRAME.FACTS:
        return;
      default:
        throw new CoreProtocolError('frame_kind', `unknown frame kind ${frame.kind}`);
    }
  }

  private handleStreamData(channel: number, payload: Uint8Array): void {
    const stream = this.streams.get(channel);
    if (stream) {
      stream.onData(payload);
      void this.transport.write(creditFrame(channel, payload.length)).catch((e) => this.fail(asError(e)));
      return;
    }
    // Frames already in flight for a viewer this client detached are dropped.
    if (this.detached.has(channel)) return;
    const early = this.early.get(channel) ?? { chunks: [], bytes: 0 };
    if (this.earlyBytes + payload.length > MAX_EARLY_BYTES) {
      throw new CoreProtocolError('early_overflow', 'stream data arrived before its channel could be registered');
    }
    early.chunks.push(payload);
    early.bytes += payload.length;
    this.early.set(channel, early);
    this.earlyBytes += payload.length;
    // Accepted into a bounded buffer: credit it so the core can continue in order.
    void this.transport.write(creditFrame(channel, payload.length)).catch((e) => this.fail(asError(e)));
  }

  private handleStreamClose(channel: number, payload: Uint8Array): void {
    const reason = closeReason(payload);
    const stream = this.streams.get(channel);
    this.takeEarly(channel);
    this.detached.delete(channel);
    this.streams.delete(channel);
    stream?.onClose(reason);
  }

  private handleChannel0(payload: Uint8Array): void {
    if (payload.length === 0) return;
    const text = decodeUtf8(payload).trim();
    if (!text) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      throw new CoreProtocolError('json', 'a control frame did not contain JSON');
    }
    this.handleMessage(message, false);
  }

  private handleMessage(message: unknown, plain: boolean): void {
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id : typeof m.id === 'number' ? String(m.id) : null;
    if (id !== null) {
      const pending = this.pending.get(id);
      if (!pending) return; // Duplicate or unknown response: never create a new request.
      if (m.error !== undefined) {
        const e = m.error as { code?: unknown; message?: unknown; data?: { kind?: unknown } };
        this.settle(
          id,
          new CoreProtocolError(typeof e.data?.kind === 'string' ? e.data.kind : 'rpc', typeof e.message === 'string' ? e.message : 'request failed'),
        );
        return;
      }
      // The hello reply switches the connection after this message. A reply
      // and the first frame may arrive in the same native chunk.
      if (plain && this.helloId === id) {
        const framed = (m.result as { framed?: unknown } | undefined)?.framed;
        if (framed === true) this.enableFramed();
      }
      this.settle(id, null, m.result);
      return;
    }
    if (typeof m.method === 'string') {
      const params = typeof m.params === 'object' && m.params !== null ? (m.params as Record<string, unknown>) : {};
      this.eventHandler(m.method, params);
    }
  }

  private enableFramed(): void {
    if (this.mode !== 'plain') return;
    this.mode = 'framed';
  }

  private transportClosed(info: TransportClose): void {
    if (this.mode === 'closed') return;
    const err = explainCoreClose(info);
    this.fail(err);
  }

  private fail(err: Error): void {
    if (this.mode === 'closed') return;
    this.mode = 'closed';
    this.closeError = err;
    this.early.clear();
    this.earlyBytes = 0;
    this.detached.clear();
    for (const p of [...this.pending.values()]) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) stream.onClose('connection lost');
    this.streams.clear();
    this.closeHandlers.forEach((h) => h(err));
    this.closeHandlers.length = 0;
  }
}

function closeReason(payload: Uint8Array): string {
  if (payload.length === 0) return 'closed by core';
  const text = decodeUtf8(payload).trim();
  if (!text) return 'closed by core';
  try {
    const parsed = JSON.parse(text) as { reason?: unknown };
    if (typeof parsed.reason === 'string') return parsed.reason;
  } catch {
    // A CLOSE payload is a JSON reason from the core, but a relay may send text.
  }
  return text.slice(0, 200);
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Split a raw byte stream into JSON lines without losing a split UTF-8 code
 * point. Event channels carry JSON-RPC notifications as lines.
 */
export class ByteLineBuffer {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array): string[] {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] !== 0x0a) continue;
      const line = decodeUtf8(joined.subarray(start, i)).trim();
      if (line) out.push(line);
      start = i + 1;
    }
    this.pending = joined.subarray(start);
    if (this.pending.length > 8 * 1024 * 1024) this.pending = new Uint8Array(0);
    return out;
  }
}
