import { emptyCoreState, reduceNotification } from '../core/events';
import type { CoreTerminal } from '../core/types';

const record = (address: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
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

const event = (seq: number, type: string, terminal: string, data: unknown) => ({
  jsonrpc: '2.0',
  method: 'event',
  params: { seq, type, terminal, data },
});

function apply(state: ReturnType<typeof emptyCoreState>, notifications: { method: string; params: Record<string, unknown> }[] = [], events: unknown[] = []) {
  let s = state;
  const methods = [...notifications, ...events.map((e) => ({ method: 'event', params: (e as { params: Record<string, unknown> }).params }))];
  for (const { method, params } of methods) s = reduceNotification(s, method, params).state;
  return s;
}

const find = (state: ReturnType<typeof emptyCoreState>, address: string): CoreTerminal => {
  const t = state.terminals.get(address);
  if (!t) throw new Error(`missing ${address}`);
  return t;
};

describe('core event reduction', () => {
  it('handles created, status, turn, title, foreground, size and labels events', () => {
    let s = apply(emptyCoreState(), [], [event(1, 'created', 't7', record('t7'))]);
    expect(find(s, 't7').title).toBe('t7 title');
    expect(s.seq).toBe(1);

    s = reduceNotification(
      s,
      'event',
      event(2, 'status', 't7', {
        status: { state: 'blocked', app: 'claude' },
        records: { 'slow-op': { state: 'working' } },
        reported: true,
      }).params,
    ).state;
    expect(find(s, 't7').status).toMatchObject({ state: 'blocked', app: 'claude' });

    s = reduceNotification(s, 'event', event(3, 'turn', 't7', { turn: 4, state: 'blocked' }).params).state;
    expect(find(s, 't7').turn).toBe(4);

    s = reduceNotification(s, 'event', event(4, 'title', 't7', { title: 'building' }).params).state;
    expect(find(s, 't7').title).toBe('building');

    s = reduceNotification(
      s,
      'event',
      event(5, 'foreground', 't7', { pid: 123, name: 'node', argv: ['node', 'app.js'], cwd: '/work' }).params,
    ).state;
    expect(find(s, 't7').foreground).toEqual({ pid: 123, name: 'node', argv: ['node', 'app.js'], cwd: '/work' });
    s = reduceNotification(s, 'event', event(6, 'foreground', 't7', null).params).state;
    expect(find(s, 't7').foreground).toBeNull();

    s = reduceNotification(s, 'event', event(7, 'size', 't7', { cols: 120, rows: 40 }).params).state;
    expect(find(s, 't7')).toMatchObject({ cols: 120, rows: 40 });

    s = reduceNotification(s, 'event', event(8, 'labels', 't7', { labels: { 'herdr.seen': '2', 'herdr.pinned': '1' } }).params).state;
    expect(find(s, 't7').labels).toEqual({ 'herdr.seen': '2', 'herdr.pinned': '1' });
  });

  it('applies lost, finished, keep and removed transitions', () => {
    let s = apply(emptyCoreState(), [], [event(1, 'created', 't7', record('t7')), event(2, 'finished', 't7', { reason: 'exited', exit_code: 3, signal: null, finished_ms: 2222 })]);
    expect(find(s, 't7')).toMatchObject({ state: 'finished', reason: 'exited', exitCode: 3, finishedMs: 2222, status: null });

    s = reduceNotification(s, 'event', event(3, 'lost', 't7', { reason: 'core restarted', exit_code: null, signal: 9, finished_ms: null }).params).state;
    expect(find(s, 't7')).toMatchObject({ state: 'live', reason: 'core restarted', signal: 9, finishedMs: null });

    s = reduceNotification(s, 'event', event(4, 'keep', 't7', { keep: true }).params).state;
    expect(find(s, 't7').keep).toBe(true);

    s = reduceNotification(s, 'event', event(5, 'removed', 't7', {}).params).state;
    expect(s.terminals.has('t7')).toBe(false);
  });

  it('adds the whole record when a labels event newly matches a filter', () => {
    const s = apply(
      emptyCoreState(),
      [],
      [event(1, 'labels', 't9', { labels: { 'herdr.pinned': '1' }, record: record('t9', { turn: 3 }) })],
    );
    expect(find(s, 't9')).toMatchObject({ turn: 3, labels: { 'herdr.pinned': '1' } });
  });

  it('treats a missing status as unknown, never guessed idle', () => {
    const s = apply(emptyCoreState(), [], [event(1, 'created', 't7', record('t7', { status: null, reported: false }))]);
    expect(find(s, 't7').status).toBeNull();
    expect(find(s, 't7').reported).toBe(false);
  });

  it('keeps machine-qualified addresses distinct through later patches and removal', () => {
    // herdr-core remote.rs localizes a mirrored event's `terminal` to `rohan/t7`
    // before delivering it; terminal events carry no separate `machine`.
    let s = apply(emptyCoreState(), [], [event(1, 'created', 't7', record('t7', { turn: 1 })), event(2, 'created', 'rohan/t7', record('rohan/t7', { turn: 1 }))]);
    expect([...s.terminals.keys()].sort()).toEqual(['rohan/t7', 't7']);
    s = apply(s, [], [event(3, 'turn', 'rohan/t7', { turn: 8 }), event(4, 'finished', 'rohan/t7', { reason: 'exited', exit_code: 0, signal: null, finished_ms: 5 })]);
    expect(find(s, 'rohan/t7')).toMatchObject({ turn: 8, state: 'finished' });
    expect(find(s, 't7')).toMatchObject({ turn: 1, state: 'live' });
    s = apply(s, [], [event(5, 'removed', 'rohan/t7', {})]);
    expect([...s.terminals.keys()]).toEqual(['t7']);
  });

  it('ignores repeated and stale sequences but accepts a later one', () => {
    let s = apply(emptyCoreState(), [], [event(5, 'created', 't7', record('t7', { turn: 5 }))]);
    s = reduceNotification(s, 'event', event(5, 'turn', 't7', { turn: 99 }).params).state;
    s = reduceNotification(s, 'event', event(4, 'turn', 't7', { turn: 98 }).params).state;
    expect(find(s, 't7').turn).toBe(5);
    s = reduceNotification(s, 'event', event(6, 'turn', 't7', { turn: 6 }).params).state;
    expect(find(s, 't7').turn).toBe(6);
  });

  it('replaces the snapshot on missed instead of merging it', () => {
    let s = apply(emptyCoreState(), [], [event(5, 'created', 't7', record('t7'))]);
    const r = reduceNotification(s, 'missed', { seq: 20, terminals: [record('t9', { turn: 2 })] });
    expect(r.missed).toBe(true);
    s = r.state;
    expect(s.seq).toBe(20);
    expect([...s.terminals.keys()]).toEqual(['t9']);
    expect(find(s, 't9').turn).toBe(2);
    // Events at or below the missed snapshot sequence are ignored.
    const stale = reduceNotification(s, 'event', event(20, 'turn', 't9', { turn: 9 }).params);
    expect(stale.state).toBe(s);
  });

  it('advances the sequence on heartbeat, events and docs', () => {
    let s = reduceNotification(emptyCoreState(), 'heartbeat', { seq: 9 }).state;
    expect(s.seq).toBe(9);
    const doc = reduceNotification(s, 'event', { seq: 10, type: 'doc', machine: 'rohan', data: { name: 'herdr-app', version: 4 } });
    s = doc.state;
    expect(s.seq).toBe(10);
    expect(doc.docs).toEqual([{ name: 'herdr-app', machine: 'rohan', version: 4 }]);
  });

  it('rejects unsafe sequence or turn integers instead of rounding them', () => {
    expect(() => reduceNotification(emptyCoreState(), 'heartbeat', { seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /safe unsigned integer/,
    );
    const s = apply(emptyCoreState(), [], [event(1, 'created', 't7', record('t7'))]);
    expect(() => reduceNotification(s, 'event', event(2, 'turn', 't7', { turn: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(
      /safe unsigned integer/,
    );
  });
});
