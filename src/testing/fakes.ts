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

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * In-memory Herdr server: each `open()` yields a HerdrClient over a FakeTransport whose
 * requests are answered by per-method handlers. Throwing `{code, message}` returns an error.
 */
export class FakeHerdr {
  connections: FakeTransport[] = [];
  handlers: Record<string, Handler> = {};
  failOpen: { code: string; message: string } | null = null;
  /** Like Herdr: answer one request, then close the connection (subscriptions stay open). */
  oneRequestPerConnection = true;

  constructor(private readonly makeClient: (t: FakeTransport) => import('../protocol/client').HerdrClient) {}

  open = async () => {
    if (this.failOpen) throw Object.assign(new Error(this.failOpen.message), this.failOpen);
    const t = new FakeTransport();
    const origWrite = t.write.bind(t);
    let answered = false;
    t.write = async (d: string) => {
      await origWrite(d);
      for (const line of d.split('\n').filter(Boolean)) {
        const { id, method, params } = JSON.parse(line);
        // Herdr reads only the first line of a connection; later ones are never answered.
        if (this.oneRequestPerConnection && answered) continue;
        answered = true;
        setTimeout(() => {
          const h = this.handlers[method];
          try {
            if (!h) throw { code: 'unknown_method', message: method };
            t.push(JSON.stringify({ id, result: h(params) }) + '\n');
          } catch (e) {
            t.push(JSON.stringify({ id, error: e }) + '\n');
          }
          // The EOF arrives a moment after the response, as it does over SSH.
          if (this.oneRequestPerConnection && method !== 'events.subscribe') setTimeout(() => t.serverClose('eof'), 5);
        }, 0);
      }
    };
    this.connections.push(t);
    return this.makeClient(t);
  };

  /** Connections that have sent an events.subscribe. */
  get subscriptions(): FakeTransport[] {
    return this.connections.filter((c) => c.requests.some((r) => r.method === 'events.subscribe'));
  }

  emit(t: FakeTransport, event: string, data: Record<string, unknown>) {
    t.push(JSON.stringify({ event, data }) + '\n');
  }
}
