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

    // Another document, or the version already read, needs no re-read.
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 12, type: 'doc', data: { name: 'notes', version: 7 } } });
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 13, type: 'doc', data: { name: 'herdr-app', version: 1 } } });
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 14, type: 'doc', machine: 'rohan', data: { name: 'herdr-app', version: 17 } } });
    await flush();
    expect(core.docReads).toBe(1);

    core.doc = { spaces: [] };
    core.docVersion = 2;
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 15, type: 'doc', data: { name: 'herdr-app', version: 2 } } });
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

  it('resubscribes and re-reads documents every time the core closes the event channel', async () => {
    const { t, core, session } = await setup();
    for (let loss = 1; loss <= 3; loss++) {
      t.push(encodeFrame(2, FRAME.CLOSE));
      await flush();
      expect(core.subscribeCount).toBe(1 + loss);
      expect(core.docReads).toBe(1 + loss);
    }
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 11, type: 'turn', terminal: 't7', data: { turn: 5, state: 'done' } } });
    expect(session.snapshot().state.terminals.get('t7')?.turn).toBe(5);
    expect(session.snapshot()).toMatchObject({ status: 'live', error: null });
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
  it('raises herdr.seen for a visible terminal when a snapshot brings a newer turn', async () => {
    const { t, core, session } = await setup();
    session.setVisible('t7');
    await flush();
    expect(core.labelWrites).toEqual([{ 'herdr.seen': '1' }]);

    core.event({ jsonrpc: '2.0', method: 'missed', params: { seq: 30, terminals: [coreRecord('t7', { turn: 2, labels: { 'herdr.seen': '1' } })] } });
    await flush();
    expect(core.labelWrites[1]).toEqual({ 'herdr.seen': '2' });

    core.terminals.set('t7', coreRecord('t7', { turn: 3, labels: { 'herdr.seen': '2' } }));
    t.push(encodeFrame(2, FRAME.CLOSE));
    await flush();
    expect(core.labelWrites[2]).toEqual({ 'herdr.seen': '3' });

    // A later snapshot carrying another client's mark-unread for the same turn keeps it.
    core.event({ jsonrpc: '2.0', method: 'missed', params: { seq: 40, terminals: [coreRecord('t7', { turn: 3, labels: { 'herdr.seen': '2' } })] } });
    await flush();
    expect(core.labelWrites).toHaveLength(3);
    session.close();
  });

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
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 21, type: 'labels', terminal: 't7', data: { labels: { 'herdr.seen': '0' } } } });
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 22, type: 'size', terminal: 't7', data: { cols: 100, rows: 30 } } });
    await flush();
    expect(core.labelWrites).toHaveLength(1);
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 23, type: 'turn', terminal: 't7', data: { turn: 2, state: 'done' } } });
    await flush();
    expect(core.labelWrites[1]).toEqual({ 'herdr.seen': '2' });
    session.setVisible(null);
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 30, type: 'turn', terminal: 't7', data: { turn: 3, state: 'done' } } });
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

  it('applies label writes through the ordered event stream, never from the reply record', async () => {
    const { t, core, session } = await setup();
    const reply = t.onWrite;
    t.onWrite = (bytes) => {
      // A newer event reaches the phone before the label reply.
      if (decodeUtf8(bytes).includes('"terminal.label"')) {
        core.event({
          jsonrpc: '2.0',
          method: 'event',
          params: { seq: 11, type: 'status', terminal: 't7', data: { status: { state: 'working' }, records: {}, reported: true } },
        });
      }
      reply(bytes);
    };
    await session.setPinned('t7', true);
    const t7 = session.snapshot().state.terminals.get('t7');
    expect(t7?.status?.state).toBe('working');
    expect(t7?.labels['herdr.pinned']).toBe('1');
    expect(session.snapshot().state.seq).toBe(12);
    session.close();
  });

  it('clears a transient live error only after the same kind of operation succeeds', async () => {
    const { core, session } = await setup();
    core.failOnce.add('terminal.label');
    session.setVisible('t7');
    await flush();
    expect(session.snapshot()).toMatchObject({ status: 'live', error: 'busy' });

    // A different kind of success does not hide the failed label write.
    core.event({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 11 } });
    await flush();
    expect(session.snapshot().error).toBe('busy');

    await session.setPinned('t7', true);
    expect(session.snapshot()).toMatchObject({ status: 'live', error: null });
    session.close();
  });

  it('keeps a state error and a label error apart so neither success hides the other', async () => {
    const { core, session } = await setup();
    const rejectTurn = (seq: number) =>
      core.event({ jsonrpc: '2.0', method: 'event', params: { seq, type: 'turn', terminal: 't7', data: { turn: Number.MAX_SAFE_INTEGER + 1 } } });

    rejectTurn(11);
    await flush();
    core.failOnce.add('terminal.label');
    session.setVisible('t7');
    await flush();
    expect(core.failOnce.size).toBe(0);
    expect(session.snapshot().error).toMatch(/safe unsigned integer/);

    // The label success repairs only the label failure, not the dropped event.
    await session.setPinned('t7', true);
    expect(session.snapshot().error).toMatch(/safe unsigned integer/);
    core.event({ jsonrpc: '2.0', method: 'missed', params: { seq: 20, terminals: [coreRecord('t7', { labels: { 'herdr.seen': '1' } })] } });
    await flush();
    expect(session.snapshot()).toMatchObject({ status: 'live', error: null });

    // In the other order, the resnapshot leaves the outstanding label failure visible.
    core.failOnce.add('terminal.label');
    core.event({ jsonrpc: '2.0', method: 'missed', params: { seq: 21, terminals: [coreRecord('t7', { turn: 2, labels: { 'herdr.seen': '1' } })] } });
    await flush();
    expect(core.failOnce.size).toBe(0);
    expect(session.snapshot().error).toBe('busy');
    rejectTurn(22);
    await flush();
    expect(session.snapshot().error).toMatch(/safe unsigned integer/);
    core.event({ jsonrpc: '2.0', method: 'missed', params: { seq: 30, terminals: [coreRecord('t7', { turn: 2, labels: { 'herdr.seen': '1' } })] } });
    await flush();
    expect(session.snapshot().error).toBe('busy');
    await session.setPinned('t7', false);
    expect(session.snapshot()).toMatchObject({ status: 'live', error: null });
    session.close();
  });

  it('keeps an event rejected while the document read is in flight, and a reconnect starts clean', async () => {
    const first = new FakeByteTransport();
    const firstCore = new TestCore(first);
    const second = new FakeByteTransport();
    const secondCore = new TestCore(second);
    const reply = first.onWrite;
    first.onWrite = (bytes) => {
      if (decodeUtf8(bytes).includes('"doc.get"')) {
        firstCore.event({ jsonrpc: '2.0', method: 'event', params: { seq: 11, type: 'turn', terminal: 't7', data: { turn: Number.MAX_SAFE_INTEGER + 1 } } });
      }
      reply(bytes);
    };
    const transports = [first, second];
    const session = new CoreSession(async () => transports.shift() as FakeByteTransport);

    await session.start();
    expect(firstCore.docReads).toBe(1);
    expect(session.snapshot()).toMatchObject({ status: 'live', error: expect.stringMatching(/safe unsigned integer/) });
    expect(session.snapshot().state.seq).toBe(10);

    // A label failure is not repaired by a snapshot, only by a new connect attempt.
    firstCore.failOnce.add('terminal.label');
    session.setVisible('t7');
    await flush();
    expect(firstCore.failOnce.size).toBe(0);

    await session.reconnect();
    expect(secondCore.docReads).toBe(1);
    expect(secondCore.labelWrites).toHaveLength(0);
    expect(session.snapshot()).toMatchObject({ status: 'live', error: null });
    session.close();
  });

  it('does not report live when the connection closes while the document read is in flight', async () => {
    const t = new FakeByteTransport();
    new TestCore(t);
    const reply = t.onWrite;
    t.onWrite = (bytes) => {
      if (decodeUtf8(bytes).includes('"doc.get"')) {
        t.serverClose({ reason: 'eof', exitCode: 1, stderr: 'hc: lost' });
        return;
      }
      reply(bytes);
    };
    const session = new CoreSession(async () => t);
    await session.start();
    const snap = session.snapshot();
    expect(snap.status).toBe('error');
    expect(snap.error).not.toBeNull();
    session.close();
  });

  it('keeps a rejected snapshot visible until an authoritative resnapshot replaces state', async () => {
    const { t, core, session } = await setup();
    core.event({
      jsonrpc: '2.0',
      method: 'missed',
      params: { seq: 30, terminals: [coreRecord('t7', { turn: Number.MAX_SAFE_INTEGER + 1 })] },
    });
    await flush();
    expect(session.snapshot().error).toMatch(/safe unsigned integer/);
    expect(session.snapshot().state.seq).toBe(10);

    // Ordinary events and other successes cannot repair the dropped snapshot.
    core.event({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 31 } });
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 32, type: 'size', terminal: 't7', data: { cols: 100, rows: 30 } } });
    await flush();
    await session.setPinned('t7', true);
    expect(session.snapshot().error).toMatch(/safe unsigned integer/);

    core.event({ jsonrpc: '2.0', method: 'missed', params: { seq: 40, terminals: [coreRecord('t7', { turn: 2 })] } });
    await flush();
    expect(session.snapshot()).toMatchObject({ status: 'live', error: null });
    expect(session.snapshot().state.terminals.get('t7')?.turn).toBe(2);

    // A rejected event is likewise repaired only by the resubscribe snapshot.
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 41, type: 'turn', terminal: 't7', data: { turn: Number.MAX_SAFE_INTEGER + 1 } } });
    core.event({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 42 } });
    await flush();
    expect(session.snapshot().error).toMatch(/safe unsigned integer/);
    t.push(encodeFrame(2, FRAME.CLOSE));
    await flush();
    expect(core.subscribeCount).toBe(2);
    expect(session.snapshot()).toMatchObject({ status: 'live', error: null });
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
