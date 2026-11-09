import { concatBytes, decodeUtf8, encodeUtf8 } from '../core/bytes';
import { CoreClient, MAX_EARLY_BYTES } from '../core/client';
import { FRAME, FrameParser, decodeCredit, encodeFrame } from '../core/frames';
import { FakeByteTransport, flush } from '../testing/byteFakes';

const HELLO = {
  generation: 1,
  version: '0.1.19',
  framed: true,
  methods: ['terminal.list', 'terminal.attach', 'events.subscribe', 'terminal.label', 'doc.get'],
  features: ['automatic_input', 'resize_notifications'],
  core: { id: 'core-1', name: 'box' },
};

const reply = (id: string, result: unknown) =>
  encodeUtf8(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

const control = (message: unknown) => encodeFrame(0, FRAME.DATA, encodeUtf8(JSON.stringify(message)));

async function handshake(t: FakeByteTransport, hello: unknown = HELLO) {
  const c = new CoreClient(t);
  const p = c.handshake();
  await flush();
  const request = JSON.parse(decodeUtf8(t.written[0]));
  expect(request.method).toBe('hello');
  expect(request.params).toEqual({ generation: 1, framed: true });
  t.push(reply(request.id, hello));
  const result = await p;
  return { c, id: request.id as string, result };
}

describe('CoreClient handshake', () => {
  it('switches to framed mode after the plain hello reply even when the first frame is coalesced', async () => {
    const t = new FakeByteTransport();
    const c = new CoreClient(t);
    const pending = c.handshake();
    await flush();
    const id = JSON.parse(decodeUtf8(t.written[0])).id;
    t.push(concatBytes(reply(id, HELLO), encodeFrame(7, FRAME.DATA, encodeUtf8('first paint'))));
    const hello = await pending;
    expect(hello.core).toEqual({ id: 'core-1', name: 'box' });
    expect(c.framed).toBe(true);
    let got: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    c.registerStream(7, {
      onData: (b) => {
        got = concatBytes(got, b);
      },
      onClose: () => {},
    });
    expect(decodeUtf8(got)).toBe('first paint');
    // Exactly one credit for the accepted bytes.
    const credit = t.frames.filter((f) => f.channel === 7 && f.kind === FRAME.CREDIT);
    expect(credit).toHaveLength(1);
    expect(decodeCredit(credit[0].payload)).toBe(11);
  });

  it('parses a hello line split at every byte offset, including inside multi-byte UTF-8', async () => {
    const hello = { ...HELLO, core: { id: 'core-1', name: 'café ☕' } };
    for (let split = 0; split <= 80; split++) {
      const t = new FakeByteTransport();
      const c = new CoreClient(t);
      const pending = c.handshake();
      await flush();
      const id = JSON.parse(decodeUtf8(t.written[0])).id;
      const line = reply(id, hello);
      t.push(line.subarray(0, Math.min(split, line.length)));
      t.push(line.subarray(Math.min(split, line.length)));
      await expect(pending).resolves.toMatchObject({ core: { name: 'café ☕' } });
      expect(c.framed).toBe(true);
    }
  });

  it('rejects incompatible generation, framed=false and missing required methods', async () => {    for (const hello of [
      { ...HELLO, generation: 2 },
      { ...HELLO, framed: false },
      { ...HELLO, methods: HELLO.methods.filter((m) => m !== 'terminal.label') },
    ]) {
      const t = new FakeByteTransport();
      const c = new CoreClient(t);
      const p = c.handshake();
      await flush();
      const id = JSON.parse(decodeUtf8(t.written[0])).id;
      t.push(reply(id, hello));
      await expect(p).rejects.toMatchObject({ name: 'CoreUnsupportedError' });
    }
  });

  it('maps a rejected hello generation to an explicit unsupported error', async () => {
    const t = new FakeByteTransport();
    const c = new CoreClient(t);
    const p = c.handshake();
    await flush();
    const id = JSON.parse(decodeUtf8(t.written[0])).id;
    t.push(
      encodeUtf8(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'unsupported_generation', data: { kind: 'unsupported_generation' } },
        })}\n`,
      ),
    );
    await expect(p).rejects.toMatchObject({ name: 'CoreUnsupportedError', code: 'unsupported_generation' });
    expect((await p.catch((e: Error) => e.message)) as string).toMatch(/generation/);
  });

  it('treats shell or banner stdout as an explicit Core error', async () => {
    const t = new FakeByteTransport();
    const c = new CoreClient(t);
    const p = c.handshake();
    await flush();
    t.push('Welcome to your server!\n');
    await expect(p).rejects.toMatchObject({ name: 'CoreCommandError', code: 'hc_stdout' });
  });

  it('maps a closed transport with exit 97 to a missing-hc error', async () => {
    const t = new FakeByteTransport();
    const c = new CoreClient(t);
    const errors: Error[] = [];
    c.onClose((e) => errors.push(e));
    const p = c.handshake();
    await flush();
    t.serverClose({ exitCode: 97, stderr: '' });
    await expect(p).rejects.toMatchObject({ code: 'hc_missing' });
    expect(errors[0].message).toContain('hc');
  });
});

describe('CoreClient requests and streams', () => {
  it('sends framed channel-0 requests and resolves out of order', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    t.clear();
    const one = c.request('terminal.list');
    const two = c.request('terminal.get', { terminal: 't7' });
    await flush();
    const sent = t.frames.filter((f) => f.channel === 0).map((f) => JSON.parse(decodeUtf8(f.payload)));
    expect(sent.map((s) => s.method)).toEqual(['terminal.list', 'terminal.get']);
    t.push(control({ jsonrpc: '2.0', id: sent[1].id, result: { address: 't7' } }));
    t.push(control({ jsonrpc: '2.0', id: sent[0].id, result: { terminals: [] } }));
    await expect(two).resolves.toEqual({ address: 't7' });
    await expect(one).resolves.toEqual({ terminals: [] });
  });

  it('times out once and ignores duplicate/unknown response ids', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    await expect(c.request('terminal.list', {}, 5)).rejects.toMatchObject({ code: 'timeout' });
    t.push(control({ jsonrpc: '2.0', id: 'nope', result: 1 }));
    t.push(control({ jsonrpc: '2.0', id: 'nope', result: 2 }));
    await flush();
    expect(c.closed).toBe(false);
  });

  it('carries every byte value through a stream without text decoding', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    let got: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    c.registerStream(4, {
      onData: (b) => {
        got = concatBytes(got, b);
      },
      onClose: () => {},
    });
    t.push(encodeFrame(4, FRAME.DATA, all.subarray(0, 100)));
    t.push(encodeFrame(4, FRAME.DATA, all.subarray(100)));
    expect(got).toEqual(all);
  });

  it('drains bounded early frames exactly once when the channel registers', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    t.push(encodeFrame(9, FRAME.DATA, encodeUtf8('a')));
    t.push(encodeFrame(9, FRAME.DATA, encodeUtf8('b')));
    let got = '';
    c.registerStream(9, {
      onData: (b) => {
        got += decodeUtf8(b);
      },
      onClose: () => {},
    });
    expect(got).toBe('ab');
    c.closeStream(9);
    c.registerStream(9, {
      onData: (b) => {
        got += decodeUtf8(b);
      },
      onClose: () => {},
    });
    expect(got).toBe('ab');
  });

  it('rejects unbounded early frames instead of growing memory', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    const errors: Error[] = [];
    c.onClose((e) => errors.push(e));
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < MAX_EARLY_BYTES / chunk.length + 1; i++) t.push(encodeFrame(5, FRAME.DATA, chunk));
    expect(errors[0]).toMatchObject({ code: 'early_overflow' });
  });

  it('drops in-flight frames for detached viewers so switching terminals never exhausts the early budget', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    const errors: Error[] = [];
    c.onClose((e) => errors.push(e));
    // A core keeps sending up to its 256 KiB credit window after a viewer CLOSE.
    const window = new Uint8Array(256 * 1024);
    const switches = MAX_EARLY_BYTES / window.length + 4;
    for (let channel = 10; channel < 10 + switches; channel++) {
      c.registerStream(channel, { onData: () => {}, onClose: () => {} });
      c.closeStream(channel);
      t.push(encodeFrame(channel, FRAME.DATA, window));
      t.push(encodeFrame(channel, FRAME.CLOSE));
    }
    // A superseded attach is closed before it was ever registered.
    c.closeStream(99);
    t.push(encodeFrame(99, FRAME.DATA, window));
    expect(errors).toEqual([]);
    expect(c.closed).toBe(false);

    // The whole budget is still available to a channel that registers late.
    const full = new Uint8Array(MAX_EARLY_BYTES);
    t.push(encodeFrame(200, FRAME.DATA, full));
    let got = 0;
    c.registerStream(200, { onData: (b) => (got += b.length), onClose: () => {} });
    expect(got).toBe(MAX_EARLY_BYTES);
    expect(errors).toEqual([]);
  });

  it('returns early bytes to the budget when the core closes an unregistered channel', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    const errors: Error[] = [];
    c.onClose((e) => errors.push(e));
    const chunk = new Uint8Array(MAX_EARLY_BYTES - 1);
    t.push(encodeFrame(30, FRAME.DATA, chunk));
    t.push(encodeFrame(30, FRAME.CLOSE));
    t.push(encodeFrame(31, FRAME.DATA, chunk));
    expect(errors).toEqual([]);
  });

  it('credits consumed stream bytes exactly and never gates viewer input on credit', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    c.registerStream(2, { onData: () => {}, onClose: () => {} });
    t.clear();
    t.push(encodeFrame(2, FRAME.DATA, new Uint8Array(100)));
    const credit = t.frames.filter((f) => f.channel === 2 && f.kind === FRAME.CREDIT);
    expect(credit).toHaveLength(1);
    expect(decodeCredit(credit[0].payload)).toBe(100);

    // Viewer input has no core-granted credit: a large paste is written now.
    t.clear();
    const paste = new Uint8Array(300 * 1024);
    await c.writeStream(2, paste);
    const data = t.frames.filter((f) => f.channel === 2 && f.kind === FRAME.DATA);
    expect(data).toHaveLength(1);
    expect(data[0].payload.length).toBe(paste.length);
  });

  it('treats a core CLOSE as a viewer detach, not a connection loss', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    const reasons: string[] = [];
    c.registerStream(6, { onData: () => {}, onClose: (r) => reasons.push(r) });
    t.push(encodeFrame(6, FRAME.CLOSE, encodeUtf8(JSON.stringify({ reason: 'exited', exit_code: 0 }))));
    expect(reasons).toEqual(['exited']);
    expect(c.closed).toBe(false);
    const p = c.request('terminal.list');
    await flush();
    const sent = t.frames.filter((f) => f.channel === 0).map((f) => JSON.parse(decodeUtf8(f.payload)));
    t.push(control({ jsonrpc: '2.0', id: sent[sent.length - 1].id, result: {} }));
    await expect(p).resolves.toEqual({});
  });

  it('detaches a viewer with CLOSE and never sends terminal.kill', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    c.registerStream(8, { onData: () => {}, onClose: () => {} });
    t.clear();
    c.closeStream(8);
    await flush();
    expect(t.frames).toHaveLength(1);
    expect(t.frames[0]).toMatchObject({ channel: 8, kind: FRAME.CLOSE });
    const text = decodeUtf8(t.writtenBytes);
    expect(text).not.toContain('terminal.kill');
  });

  it('closes on malformed control JSON and unknown frame kinds', async () => {
    for (const bad of [encodeFrame(0, FRAME.DATA, encodeUtf8('not json'))]) {
      const t = new FakeByteTransport();
      const { c } = await handshake(t);
      const errors: Error[] = [];
      c.onClose((e) => errors.push(e));
      t.push(bad);
      expect(errors[0]).toMatchObject({ code: 'json' });
    }
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    const errors: Error[] = [];
    c.onClose((e) => errors.push(e));
    const bad = new Uint8Array(9);
    bad[4] = 42;
    t.push(bad);
    await flush();
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toMatch(/unknown frame kind/);
  });

  it('handles a fragmented frame and a stalled renderer independently of channel 0', async () => {
    const t = new FakeByteTransport();
    const { c } = await handshake(t);
    const parser = new FrameParser();
    expect(parser.push(encodeFrame(4, FRAME.DATA, encodeUtf8('xyz')).subarray(0, 5))).toEqual([]);
    // Control requests still flow while the stream has no registered consumer.
    const p = c.request('terminal.list');
    await flush();
    const sent = t.frames.filter((f) => f.channel === 0).map((f) => JSON.parse(decodeUtf8(f.payload)));
    t.push(control({ jsonrpc: '2.0', id: sent[0].id, result: {} }));
    await expect(p).resolves.toEqual({});
    const full = encodeFrame(4, FRAME.DATA, encodeUtf8('xyz'));
    let got = '';
    c.registerStream(4, { onData: (b) => (got += decodeUtf8(b)), onClose: () => {} });
    t.push(full.subarray(0, 5));
    expect(got).toBe('');
    t.push(full.subarray(5));
    expect(got).toBe('xyz');
  });
});
