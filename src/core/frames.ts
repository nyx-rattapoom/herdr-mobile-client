import { encodeUtf8, concatBytes } from './bytes';

/** Frame kinds from herdr-core schema/README.md (protocol generation 1). */
export const FRAME = {
  DATA: 0,
  CREDIT: 1,
  CLOSE: 2,
  RESIZE: 3,
  FOCUS: 4,
  FACTS: 5,
  AUTOMATIC_INPUT: 6,
} as const;

export const HEADER_BYTES = 9;
export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

export type Frame = { channel: number; kind: number; payload: Uint8Array };

export class CoreFrameError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoreFrameError';
  }
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** Incremental `[channel u32le][kind u8][len u32le][payload]` parser. */
export class FrameParser {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(private readonly maxPayload = MAX_FRAME_PAYLOAD) {}

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length) this.buffer = this.buffer.length ? concatBytes(this.buffer, chunk) : chunk;
    const out: Frame[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const channel = u32(this.buffer, 0);
      const kind = this.buffer[4];
      const length = u32(this.buffer, 5);
      if (length > this.maxPayload) {
        throw new CoreFrameError('frame_too_large', `frame payload of ${length} bytes exceeds ${this.maxPayload}`);
      }
      if (kind > FRAME.AUTOMATIC_INPUT) {
        throw new CoreFrameError('frame_kind', `unknown frame kind ${kind}`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;
      out.push({
        channel,
        kind,
        payload: this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length),
      });
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
    return out;
  }

  get remainder(): number {
    return this.buffer.length;
  }
}

function header(channel: number, kind: number, length: number): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES);
  h[0] = channel & 0xff;
  h[1] = (channel >>> 8) & 0xff;
  h[2] = (channel >>> 16) & 0xff;
  h[3] = (channel >>> 24) & 0xff;
  h[4] = kind;
  h[5] = length & 0xff;
  h[6] = (length >>> 8) & 0xff;
  h[7] = (length >>> 16) & 0xff;
  h[8] = (length >>> 24) & 0xff;
  return h;
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new CoreFrameError('frame_too_large', 'payload exceeds 16 MiB');
  return concatBytes(header(channel, kind, payload.length), payload);
}

export function creditFrame(channel: number, bytes: number): Uint8Array {
  const p = new Uint8Array(4);
  p[0] = bytes & 0xff;
  p[1] = (bytes >>> 8) & 0xff;
  p[2] = (bytes >>> 16) & 0xff;
  p[3] = (bytes >>> 24) & 0xff;
  return encodeFrame(channel, FRAME.CREDIT, p);
}

export function closeFrame(channel: number, reason?: unknown): Uint8Array {
  const payload =
    reason === undefined ? new Uint8Array(0) : encodeUtf8(typeof reason === 'string' ? reason : JSON.stringify(reason));
  return encodeFrame(channel, FRAME.CLOSE, payload);
}

export function resizeFrame(channel: number, cols: number, rows: number): Uint8Array {
  const p = new Uint8Array(4);
  p[0] = cols & 0xff;
  p[1] = (cols >>> 8) & 0xff;
  p[2] = rows & 0xff;
  p[3] = (rows >>> 8) & 0xff;
  return encodeFrame(channel, FRAME.RESIZE, p);
}

export function focusFrame(channel: number, gained: boolean): Uint8Array {
  return encodeFrame(channel, FRAME.FOCUS, Uint8Array.of(gained ? 1 : 0));
}

export function factsFrame(channel: number, facts: unknown): Uint8Array {
  return encodeFrame(channel, FRAME.FACTS, encodeUtf8(JSON.stringify(facts)));
}

export function automaticInputFrame(channel: number, bytes: Uint8Array): Uint8Array {
  return encodeFrame(channel, FRAME.AUTOMATIC_INPUT, bytes);
}

export function decodeCredit(payload: Uint8Array): number | null {
  if (payload.length !== 4) return null;
  return u32(payload, 0);
}

export function decodeResize(payload: Uint8Array): { cols: number; rows: number } | null {
  if (payload.length !== 4) return null;
  return { cols: payload[0] | (payload[1] << 8), rows: payload[2] | (payload[3] << 8) };
}
