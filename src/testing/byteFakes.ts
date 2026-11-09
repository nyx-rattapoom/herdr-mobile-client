import { concatBytes, encodeUtf8 } from '../core/bytes';
import { FrameParser, type Frame } from '../core/frames';
import type { ByteTransport, TransportClose } from '../core/transport';

/** Byte-level transport double; no native module is involved. */
export class FakeByteTransport implements ByteTransport {
  written: Uint8Array[] = [];
  closed = false;
  failWrites = false;
  /** Test hook: observe bytes as the client writes them (no native module). */
  onWrite: (bytes: Uint8Array) => void = () => {};
  private bytes: (c: Uint8Array) => void = () => {};
  private closeHandler: (i: TransportClose) => void = () => {};

  async write(bytes: Uint8Array): Promise<void> {
    if (this.failWrites) throw new Error('write failed');
    this.written.push(bytes);
    this.onWrite(bytes);
  }
  onBytes(h: (chunk: Uint8Array) => void): void {
    this.bytes = h;
  }
  onClose(h: (i: TransportClose) => void): void {
    this.closeHandler = h;
  }
  close(): void {
    this.closed = true;
  }
  push(chunk: Uint8Array | string): void {
    this.bytes(typeof chunk === 'string' ? encodeUtf8(chunk) : chunk);
  }
  serverClose(info: Partial<TransportClose> = {}): void {
    this.closeHandler({ reason: 'eof', exitCode: 0, stderr: '', ...info });
  }
  clear(): void {
    this.written = [];
  }
  get writtenBytes(): Uint8Array {
    return concatBytes(...this.written);
  }
  /** Framed writes only: the plain hello line in `written` is not a frame. */
  get frames(): Frame[] {
    const parser = new FrameParser();
    return this.written.filter((w) => w.length > 0 && w[0] !== 0x7b).flatMap((w) => parser.push(w));
  }
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));
