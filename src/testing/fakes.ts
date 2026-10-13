import type { Transport } from '../protocol/transport';
import type { KeyValueStore } from '../ssh/pinning';

export class FakeTransport implements Transport {
  written: string[] = [];
  closed = false;
  failWrites = false;
  private data: (c: string) => void = () => {};
  private close_: (r: string) => void = () => {};

  async write(d: string) {
    if (this.failWrites) throw new Error('write failed');
    this.written.push(d);
  }
  onData(h: (c: string) => void) {
    this.data = h;
  }
  onClose(h: (r: string) => void) {
    this.close_ = h;
  }
  close() {
    this.closed = true;
  }
  /** Simulates bytes arriving from the server. */
  push(chunk: string) {
    this.data(chunk);
  }
  serverClose(reason = 'eof') {
    this.close_(reason);
  }
  /** Parsed request objects sent so far. */
  get requests(): { id: string; method: string; params: unknown }[] {
    return this.written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}

export class MemoryKv implements KeyValueStore {
  map = new Map<string, string>();
  async getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  async setItem(k: string, v: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(k)) throw new Error(`invalid SecureStore key: ${k}`);
    this.map.set(k, v);
  }
  async deleteItem(k: string) {
    this.map.delete(k);
  }
}
