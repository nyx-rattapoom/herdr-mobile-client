import { decodeUtf8 } from '../core/bytes';
import { CoreSession } from '../core/CoreSession';
import { FRAME, decodeResize } from '../core/frames';
import { TestCore } from '../testing/corePeer';
import { FakeByteTransport, flush } from '../testing/byteFakes';

const setup = async () => {
  const t = new FakeByteTransport();
  const core = new TestCore(t);
  const session = new CoreSession(async () => t);
  await session.start();
  return { t, core, session };
};

const dataFrames = (t: FakeByteTransport, channel: number) => t.frames.filter((f) => f.channel === channel && f.kind === FRAME.DATA);
const closeFrames = (t: FakeByteTransport, channel: number) => t.frames.filter((f) => f.channel === channel && f.kind === FRAME.CLOSE);

describe('CorePane attach lifecycle', () => {
  it('attaches in observe mode, paints into a fresh buffer and claims input by reattaching', async () => {
    const { t, core, session } = await setup();
    const pane = session.pane('t7', 20, 4, true);
    await pane.open();
    expect(core.attachParams[0]).toMatchObject({ terminal: 't7', cols: 20, rows: 4, observe: true, resize_notifications: true, resumed: false });
    expect(pane.observe).toBe(true);
    expect(pane.channel).toBe(5);

    core.paint(5, 'first paint');
    expect(pane.buffer.screenText()).toBe('first paint');

    await pane.claimInput();
    expect(core.attachParams[1]).toMatchObject({ observe: false, resumed: true });
    expect(pane.observe).toBe(false);
    expect(pane.channel).toBe(6);
    // The old viewer is detached without killing the terminal.
    expect(closeFrames(t, 5)).toHaveLength(1);
    expect(decodeUtf8(closeFrames(t, 5)[0].payload)).toContain('detached');

    // Reattach replaces the buffer with the core's authoritative paint.
    expect(pane.buffer.screenText()).toBe('');
    core.paint(6, 'authoritative');
    expect(pane.buffer.screenText()).toBe('authoritative');
    expect(decodeUtf8(t.writtenBytes)).not.toContain('terminal.kill');
    session.close();
  });

  it('sends viewer resize, focus and input only while active, and automatic input only when negotiated', async () => {
    const { t, session } = await setup();
    const pane = session.pane('t7', 20, 4, false);
    await pane.open();
    t.clear();
    await pane.resize(30, 10);
    const resize = t.frames.find((f) => f.channel === 5 && f.kind === FRAME.RESIZE);
    expect(resize && decodeResize(resize.payload)).toEqual({ cols: 30, rows: 10 });
    pane.focus(true);
    const focus = t.frames.find((f) => f.channel === 5 && f.kind === FRAME.FOCUS);
    expect(focus?.payload[0]).toBe(1);
    await pane.write('ls\r');
    const input = dataFrames(t, 5);
    expect(input.map((f) => decodeUtf8(f.payload)).join('')).toBe('ls\r');
    await pane.writeAutomatic(Uint8Array.of(0x1b));
    const automatic = t.frames.find((f) => f.channel === 5 && f.kind === FRAME.AUTOMATIC_INPUT);
    expect(automatic?.payload).toEqual(Uint8Array.of(0x1b));
    session.close();
  });

  it('keeps the observed terminal size while observing and claims with the phone viewport', async () => {
    const { t, core, session } = await setup();
    const pane = session.pane('t7', 20, 4, true);
    await pane.open();
    // The observe reply carries the terminal's own (desktop) size.
    expect([pane.buffer.cols, pane.buffer.rows]).toEqual([80, 24]);
    await pane.resize(30, 10);
    expect([pane.buffer.cols, pane.buffer.rows]).toEqual([80, 24]);
    core.paint(5, '\x1b[24;80HZ');
    expect(pane.buffer.cursor).toEqual({ row: 23, col: 79 });

    t.clear();
    await pane.claimInput();
    expect(core.attachParams[1]).toMatchObject({ cols: 30, rows: 10, observe: false });
    expect([pane.buffer.cols, pane.buffer.rows]).toEqual([30, 10]);
    expect(t.frames.filter((f) => f.kind === FRAME.RESIZE)).toHaveLength(0);
    session.close();
  });

  it('does not send RESIZE while observing, and detaches without terminal.kill', async () => {
    const { t, session } = await setup();
    const pane = session.pane('t7', 20, 4, true);
    await pane.open();
    t.clear();
    await pane.resize(40, 12);
    expect(t.frames.filter((f) => f.kind === FRAME.RESIZE)).toHaveLength(0);
    pane.detach();
    await flush();
    expect(pane.channel).toBeNull();
    expect(t.frames.filter((f) => f.kind === FRAME.CLOSE && f.channel === 5)).toHaveLength(1);
    expect(decodeUtf8(t.writtenBytes)).not.toContain('terminal.kill');
    session.close();
  });

  it('reattaches after the core connection reconnects and closes a finished terminal viewer', async () => {
    const first = new FakeByteTransport();
    const firstCore = new TestCore(first);
    const second = new FakeByteTransport();
    const secondCore = new TestCore(second);
    const transports = [first, second];
    const session = new CoreSession(async () => transports.shift() as FakeByteTransport);
    await session.start();
    const pane = session.pane('t7', 20, 4, false);
    await pane.open();
    expect(firstCore.attachCount).toBe(1);

    await session.reconnect();
    expect(secondCore.attachCount).toBe(1);
    expect(pane.channel).toBe(5);
    secondCore.paint(5, 'after reconnect');
    expect(pane.buffer.screenText()).toBe('after reconnect');

    secondCore.event({
      jsonrpc: '2.0',
      method: 'event',
      params: { seq: 11, type: 'finished', terminal: 't7', data: { reason: 'exited', exit_code: 0, signal: null, finished_ms: 2000 } },
    });
    expect(pane.channel).toBeNull();
    expect(pane.closedReason).toBe('terminal finished');
    expect(decodeUtf8(second.writtenBytes)).not.toContain('terminal.kill');
    session.close();
  });
});
