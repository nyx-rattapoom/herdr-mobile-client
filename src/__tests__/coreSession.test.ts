import { decodeUtf8, encodeUtf8 } from '../core/bytes';
import { CoreSession } from '../core/CoreSession';
import { FRAME, encodeFrame } from '../core/frames';
import { TestCore, coreRecord } from '../testing/corePeer';import { FakeByteTransport, flush } from '../testing/byteFakes';

const setup = async (initial?: Record<string, unknown>[]) => {
  const t = new FakeByteTransport();
  const core = new TestCore(t, initial);
  const session = new CoreSession(async () => t);
  await session.start();
  return { t, core, session };
};

describe('CoreSession startup', () => {
  it('handshakes, subscribes, reads the desktop document and exposes live state', async () => {
    const { core, session } = await setup();
    const snap = session.snapshot();
    expect(core.subscribeCount).toBe(1);
    expect(core.docReads).toBe(1);
    expect(snap.status).toBe('live');
    expect(snap.hello).toMatchObject({ generation: 1, core: { name: 'box' } });
    expect(snap.state.seq).toBe(10);
    expect(snap.state.terminals.get('t7')?.title).toBe('t7 title');
    expect(snap.layout?.spaces[0].tabs[0].terminals).toEqual(['t7']);
    expect(snap.layoutVersion).toBe(1);
    session.close();
  });

  it('refuses to continue when the hello lacks required methods', async () => {
    const t = new FakeByteTransport();
    t.onWrite = (bytes) => {
      if (!decodeUtf8(bytes).includes('"hello"')) return;
      const id = JSON.parse(decodeUtf8(bytes)).id;
      t.push(
        encodeUtf8(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { generation: 1, version: 'x', framed: true, methods: ['terminal.list'], features: [], core: { id: 'c', name: 'box' } },
          })}\n`,
        ),
      );
    };
    const session = new CoreSession(async () => t);
    await expect(session.start()).rejects.toMatchObject({ name: 'CoreUnsupportedError', code: 'unsupported_methods' });
    expect(session.snapshot().status).toBe('error');
    session.close();
  });
});

describe('CoreSession events and documents', () => {
  it('applies split event lines and refreshes the document on a doc event', async () => {
    const { t, core, session } = await setup();
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: { seq: 11, type: 'status', terminal: 't7', data: { status: { state: 'working' }, records: {}, reported: true } },
    });
    const bytes = encodeUtf8(`${line}\n`);
    t.push(encodeFrame(2, FRAME.DATA, bytes.subarray(0, 20)));
    t.push(encodeFrame(2, FRAME.DATA, bytes.subarray(20)));
    expect(session.snapshot().state.terminals.get('t7')?.status?.state).toBe('working');

    core.doc = { spaces: [] };
    core.docVersion = 2;
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 12, type: 'doc', data: { name: 'herdr-app', version: 2 } } });
    await flush();
    expect(core.docReads).toBe(2);
    expect(session.snapshot().layoutVersion).toBe(2);
    expect(session.snapshot().layout?.spaces).toEqual([]);
    session.close();
  });

  it('takes a missed snapshot and re-reads documents', async () => {
    const { core, session } = await setup();
    core.docVersion = 3;
    core.event({ jsonrpc: '2.0', method: 'missed', params: { seq: 30, terminals: [coreRecord('t8', { turn: 9 })] } });
    await flush();
    const snap = session.snapshot();
    expect(snap.state.seq).toBe(30);
    expect([...snap.state.terminals.keys()]).toEqual(['t8']);
    expect(core.docReads).toBe(2);
    expect(snap.layoutVersion).toBe(3);
    session.close();
  });

  it('reconnects with a new handshake and ignores the old generation', async () => {
    const first = new FakeByteTransport();
    const firstCore = new TestCore(first);
    const second = new FakeByteTransport();
    const secondCore = new TestCore(second, [coreRecord('t7', { turn: 7 })]);
    const transports = [first, second];
    const session = new CoreSession(async () => transports.shift() as FakeByteTransport);
    await session.start();
    expect(firstCore.subscribeCount).toBe(1);
    await session.reconnect();
    expect(secondCore.subscribeCount).toBe(1);
    expect(session.snapshot()).toMatchObject({ status: 'live' });
    expect(session.snapshot().state.terminals.get('t7')?.turn).toBe(7);
    const before = session.snapshot().state;
    // A late event from the dropped transport must not touch current state.
    firstCore.event({ jsonrpc: '2.0', method: 'event', params: { seq: 40, type: 'turn', terminal: 't7', data: { turn: 99, state: 'done' } } });
    expect(session.snapshot().state).toBe(before);
    session.close();
  });
});

describe('CoreSession shared state and input', () => {
  it('raises herdr.seen once per turn while the terminal is visible', async () => {
    const { t, core, session } = await setup();
    session.setVisible('t7');
    await flush();
    expect(core.labelWrites).toEqual([{ 'herdr.seen': '1' }]);
    session.setVisible('t7');
    await flush();
    expect(core.labelWrites).toHaveLength(1);
    // Another client marks it unread while the screen stays visible; unrelated
    // updates must not overrule that lower write.
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 11, type: 'labels', terminal: 't7', data: { labels: { 'herdr.seen': '0' } } } });
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 12, type: 'size', terminal: 't7', data: { cols: 100, rows: 30 } } });
    await flush();
    expect(core.labelWrites).toHaveLength(1);
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 13, type: 'turn', terminal: 't7', data: { turn: 2, state: 'done' } } });
    await flush();
    expect(core.labelWrites[1]).toEqual({ 'herdr.seen': '2' });
    session.setVisible(null);
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 14, type: 'turn', terminal: 't7', data: { turn: 3, state: 'done' } } });
    await flush();
    expect(core.labelWrites).toHaveLength(2);
    // Re-viewing is a genuine later transition and may raise it again.
    session.setVisible('t7');
    await flush();
    expect(core.labelWrites[2]).toEqual({ 'herdr.seen': '3' });
    expect(decodeUtf8(t.writtenBytes)).not.toContain('doc.set');
    session.close();
  });

  it('never lowers seen on ordinary viewing and pins with the documented labels', async () => {
    const { core, session } = await setup([coreRecord('t7', { turn: 5, labels: { 'herdr.seen': '9' } })]);
    session.setVisible('t7');
    await flush();
    expect(core.labelWrites).toHaveLength(0);
    await session.setPinned('t7', true);
    expect(core.labelWrites[0]).toEqual({ 'herdr.pinned': '1' });
    await session.setPinned('t7', false);
    expect(core.labelWrites[1]).toEqual({ 'herdr.pinned': '' });
    await session.markUnread('t7');
    expect(core.labelWrites[2]).toEqual({ 'herdr.seen': '4' });
    session.close();
  });

  it('refuses a blocked prompt by default and never force-sends', async () => {
    const { core, session } = await setup([coreRecord('t7', { status: { state: 'blocked' }, turn: 3 })]);
    await expect(session.submit('t7', 'hello')).rejects.toMatchObject({ code: 'blocked' });
    expect(core.sendCalls).toHaveLength(0);
    await expect(session.submit('t7', 'hello', true)).resolves.toEqual({ turn: 4 });
    expect(core.sendCalls[0]).toMatchObject({ terminal: 't7', text: 'hello', force: true });
    session.close();
  });
});
