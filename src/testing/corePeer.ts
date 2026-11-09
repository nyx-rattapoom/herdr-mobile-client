import { decodeUtf8, encodeUtf8 } from '../core/bytes';
import { FRAME, FrameParser, encodeFrame } from '../core/frames';
import { FakeByteTransport } from './byteFakes';

export const CORE_METHODS = [
  'terminal.list',
  'terminal.attach',
  'events.subscribe',
  'terminal.label',
  'doc.get',
  'terminal.send',
  'terminal.keys',
];

export const coreRecord = (address: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  address,
  name: null,
  title: `${address} title`,
  labels: {},
  state: 'live',
  turn: 1,
  status: { state: 'idle' },
  cols: 80,
  rows: 24,
  created_ms: 1000,
  finished_ms: null,
  exit_code: null,
  signal: null,
  reason: null,
  screen: 'exact',
  keep: false,
  parent: null,
  foreground: null,
  reported: true,
  ...over,
});

export const CORE_LAYOUT_DOC = {
  spaces: [{ id: 's1', name: 'work', folder: '/w', tabs: [{ id: 'tab1', name: 'api', root: { type: 'block', content: { terminal: 't7' } } }] }],
};

/**
 * An in-process core speaking the pinned wire contract. It is an independent
 * peer: requests are parsed from bytes and replies are built from the schema,
 * not from the client's own reducers.
 */
export class TestCore {
  framed = false;
  terminals = new Map<string, Record<string, unknown>>();
  subscribeCount = 0;
  docReads = 0;
  labelWrites: Record<string, string>[] = [];
  sendCalls: Record<string, unknown>[] = [];
  attachCount = 0;
  attachParams: Record<string, unknown>[] = [];
  nextChannel = 5;
  doc: unknown = CORE_LAYOUT_DOC;
  docVersion = 1;
  /** The last event sequence this core produced; subscribe snapshots report it. */
  seq = 10;
  /** Methods whose next request is refused once with a transient error. */
  failOnce = new Set<string>();

  constructor(
    readonly t: FakeByteTransport,
    initial: Record<string, unknown>[] = [coreRecord('t7')],
  ) {
    for (const r of initial) this.terminals.set(r.address as string, r);
    t.onWrite = (bytes) => this.accept(bytes);
  }

  event(message: unknown): void {
    const seq = (message as { params?: { seq?: unknown } }).params?.seq;
    if (typeof seq === 'number' && seq > this.seq) this.seq = seq;
    this.t.push(encodeFrame(2, FRAME.DATA, encodeUtf8(`${JSON.stringify(message)}\n`)));
  }

  paint(channel: number, bytes: Uint8Array | string): void {
    this.t.push(encodeFrame(channel, FRAME.DATA, typeof bytes === 'string' ? encodeUtf8(bytes) : bytes));
  }

  private accept(bytes: Uint8Array): void {
    if (!this.framed) {
      const text = decodeUtf8(bytes).trim();
      if (!text) return;
      this.handle(JSON.parse(text), true);
      return;
    }
    for (const frame of new FrameParser().push(bytes)) {
      if (frame.channel !== 0 || frame.kind !== FRAME.DATA) continue;
      this.handle(JSON.parse(decodeUtf8(frame.payload)), false);
    }
  }

  private handle(msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> }, plain: boolean): void {
    const id = msg.id;
    if (id === undefined || typeof msg.method !== 'string') return;
    const method = msg.method;
    const params = msg.params ?? {};
    const reply = (result: unknown) => {
      if (plain) {
        this.t.push(encodeUtf8(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`));
        this.framed = true;
      } else {
        this.t.push(encodeFrame(0, FRAME.DATA, encodeUtf8(JSON.stringify({ jsonrpc: '2.0', id, result }))));
      }
    };
    const fail = (kind: string) => {
      const error = { code: -32000, message: kind, data: { kind } };
      if (plain) this.t.push(encodeUtf8(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`));
      else this.t.push(encodeFrame(0, FRAME.DATA, encodeUtf8(JSON.stringify({ jsonrpc: '2.0', id, error }))));
    };
    if (this.failOnce.delete(method)) {
      fail('busy');
      return;
    }
    switch (method) {
      case 'hello':
        reply({
          generation: 1,
          version: '0.1.19',
          framed: true,
          methods: CORE_METHODS,
          features: ['automatic_input', 'resize_notifications'],
          core: { id: 'core-1', name: 'box' },
        });
        return;
      case 'events.subscribe':
        this.subscribeCount++;
        reply({ seq: this.seq, terminals: [...this.terminals.values()], channel: 2 });
        return;
      case 'doc.get':
        this.docReads++;
        reply({ value: this.doc, version: this.docVersion });
        return;
      case 'terminal.label': {
        const address = params.terminal as string;
        const labels = params.labels as Record<string, string>;
        this.labelWrites.push(labels);
        const prev = this.terminals.get(address) ?? coreRecord(address);
        const now = { ...prev, labels: { ...((prev.labels as Record<string, string>) ?? {}) } };
        for (const [k, v] of Object.entries(labels)) {
          if (v === '') delete (now.labels as Record<string, string>)[k];
          else (now.labels as Record<string, string>)[k] = v;
        }
        this.terminals.set(address, now);
        this.event({ jsonrpc: '2.0', method: 'event', params: { seq: this.seq + 1, type: 'labels', terminal: address, data: { labels: now.labels } } });
        reply(now);
        return;
      }
      case 'terminal.send':
        this.sendCalls.push(params);
        reply({ turn: 4, status: 'working', started: true, wait: null });
        return;
      case 'terminal.keys':
        reply({ turn: 4, status: 'working' });
        return;
      case 'terminal.attach': {
        this.attachCount++;
        this.attachParams.push(params);
        const address = params.terminal as string;
        const channel = this.nextChannel++;
        const record = this.terminals.get(address) ?? coreRecord(address);
        // An observer never sizes the terminal; an active viewer does.
        const size = params.observe === true ? {} : { cols: params.cols, rows: params.rows };
        reply({
          channel,
          terminal: { ...record, ...size },
          resize_notifications: true,
          automatic_input: true,
        });
        return;
      }
      default:
        fail('not_found');
    }
  }
}
