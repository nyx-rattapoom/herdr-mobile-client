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
  push(chunk: string) {
    this.data(chunk);
  }
  serverClose(reason = 'eof') {
    this.close_(reason);
  }
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

export class FakeHerdr {
  connections: FakeTransport[] = [];
  handlers: Record<string, Handler> = { ping: () => ({ type: 'pong', version: '0.9.3', protocol: 22 }) };
  failOpen: { code: string; message: string } | null = null;
  oneRequestPerConnection = true;
  uncorrelatedInvalid = false;

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
        if (this.oneRequestPerConnection && answered) continue;
        answered = true;
        setTimeout(() => {
          const h = this.handlers[method];
          let failed = false;
          try {
            if (!h) throw { code: 'unknown_method', message: method };
            t.push(JSON.stringify({ id, result: h(params) }) + '\n');
          } catch (e) {
            failed = true;
            const uncorrelated = this.uncorrelatedInvalid && (e as { code?: string }).code === 'invalid_request';
            t.push(JSON.stringify({ id: uncorrelated ? '' : id, error: e }) + '\n');
          }
          if (this.oneRequestPerConnection && (failed || method !== 'events.subscribe'))
            setTimeout(() => t.serverClose('eof'), 5);
        }, 0);
      }
    };
    this.connections.push(t);
    return this.makeClient(t);
  };

  get subscriptions(): FakeTransport[] {
    return this.connections.filter((c) => c.requests.some((r) => r.method === 'events.subscribe'));
  }

  emit(t: FakeTransport, event: string, data: Record<string, unknown>) {
    t.push(JSON.stringify({ event, data }) + '\n');
  }
}

export function legacyHerdr(server: FakeHerdr, known: string[], version = '0.7.5') {
  server.uncorrelatedInvalid = true;
  server.handlers.ping = () => ({ type: 'pong', version, protocol: 17 });
  server.handlers['events.subscribe'] = (params) => {
    for (const s of (params.subscriptions ?? []) as { type: string }[]) {
      if (!known.includes(s.type)) {
        const list = known.map((k) => `\`${k}\``).join(', ');
        throw {
          code: 'invalid_request',
          message: `invalid request: unknown variant \`${s.type}\`, expected one of ${list}`,
        };
      }
    }
    return { type: 'subscription_started' };
  };
}
