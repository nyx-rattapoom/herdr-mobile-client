import { HerdrApiError, HerdrClient, MAX_LINE_CHARS } from '../protocol/client';
import { LineBuffer } from '../protocol/transport';
import { FakeTransport } from '../testing/fakes';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('LineBuffer', () => {
  it('reassembles lines split across chunks and strips CR', () => {
    const b = new LineBuffer();
    expect(b.push('{"a"')).toEqual([]);
    expect(b.push(':1}\r\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(b.remainder).toBe('{"c"');
    expect(b.push(':3}\n\n')).toEqual(['{"c":3}']);
  });
});

describe('HerdrClient', () => {
  it('sends one NDJSON request per line with unique ids', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    c.request('ping').catch(() => {});
    c.request('session.snapshot', { x: 1 }).catch(() => {});
    await flush();
    expect(t.written.every((w) => w.endsWith('\n') && w.indexOf('\n') === w.length - 1)).toBe(true);
    const [a, b] = t.requests;
    expect(a).toEqual({ id: 'req_1', method: 'ping', params: {} });
    expect(b).toEqual({ id: 'req_2', method: 'session.snapshot', params: { x: 1 } });
    c.close();
  });

  it('resolves responses by id, out of order and across chunk boundaries', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const p1 = c.request('ping');
    const p2 = c.request('workspace.list');
    await flush();
    t.push('{"id":"req_2","result":{"type":"workspace_list","work');
    t.push('spaces":[]}}\n{"id":"req_1","res');
    t.push('ult":{"type":"pong"}}\n');
    await expect(p1).resolves.toEqual({ type: 'pong' });
    await expect(p2).resolves.toEqual({ type: 'workspace_list', workspaces: [] });
  });

  it('rejects with the server error code and message', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const p = c.request('pane.get', { pane_id: 'w9:p9' });
    await flush();
    t.push('{"id":"req_1","error":{"code":"not_found","message":"pane not found"}}\n');
    await expect(p).rejects.toMatchObject({ name: 'HerdrApiError', code: 'not_found', message: 'pane not found' });
  });

  it('ignores unknown ids, events, non-JSON lines and unknown fields', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const p = c.request('ping');
    await flush();
    t.push('garbage\n{"id":"other","result":{}}\n{"event":"pane.updated"}\n[1,2]\n');
    t.push('{"id":"req_1","result":{"type":"pong","new_field":true},"extra":1}\n');
    await expect(p).resolves.toEqual({ type: 'pong', new_field: true });
  });

  it('gives an error with an empty id to the one request in flight, as Herdr 0.7 sends it', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const streamErrors: HerdrApiError[] = [];
    c.onStreamError((e) => streamErrors.push(e));
    const p = c.request('events.subscribe', { subscriptions: [] });
    await flush();
    t.push('{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `x`"}}\n');
    await expect(p).rejects.toMatchObject({ code: 'invalid_request', message: 'invalid request: unknown variant `x`' });
    expect(streamErrors).toEqual([]);
  });

  it('treats an empty-id error as a stream error when it could belong to more than one request', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t, 50);
    const streamErrors: HerdrApiError[] = [];
    c.onStreamError((e) => streamErrors.push(e));
    const a = c.request('ping').catch((e) => e);
    const b = c.request('ping').catch((e) => e);
    await flush();
    t.push('{"id":"","error":{"code":"invalid_request","message":"bad"}}\n');
    expect(streamErrors.map((e) => e.code)).toEqual(['invalid_request']);
    expect(await a).toMatchObject({ code: 'timeout' });
    expect(await b).toMatchObject({ code: 'timeout' });
  });

  it('times out a request that gets no response', async () => {
    jest.useFakeTimers();
    try {
      const t = new FakeTransport();
      const c = new HerdrClient(t, 500);
      const p = c.request('ping');
      jest.advanceTimersByTime(501);
      await expect(p).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets one request wait longer than the default timeout', async () => {
    jest.useFakeTimers();
    try {
      const c = new HerdrClient(new FakeTransport(), 500);
      let settled = false;
      const p = c.request('pane.read', {}, 2000).finally(() => (settled = true));
      p.catch(() => {});
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1001);
      await expect(p).rejects.toMatchObject({ code: 'timeout', message: 'pane.read timed out after 2000 ms' });
      const q = c.request('ping', {}, undefined);
      jest.advanceTimersByTime(501);
      await expect(q).rejects.toMatchObject({ message: 'ping timed out after 500 ms' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails pending and future requests when the connection closes', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const p = c.request('ping');
    await flush();
    t.serverClose('eof');
    await expect(p).rejects.toBeInstanceOf(HerdrApiError);
    await expect(c.request('ping')).rejects.toMatchObject({ code: 'closed' });
  });

  it('rejects when the write fails', async () => {
    const t = new FakeTransport();
    t.failWrites = true;
    const c = new HerdrClient(t);
    await expect(c.request('ping')).rejects.toThrow('write failed');
  });

  it('close() closes the transport and rejects pending requests', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const p = c.request('ping');
    c.close();
    expect(t.closed).toBe(true);
    await expect(p).rejects.toMatchObject({ code: 'closed' });
  });
});

describe('bounded buffering (review M1)', () => {
  it('LineBuffer does not re-split pending text for chunks without a newline', () => {
    const b = new LineBuffer();
    const split = jest.spyOn(String.prototype, 'split');
    for (let i = 0; i < 1000; i++) b.push('x'.repeat(100));
    expect(split).not.toHaveBeenCalled();
    split.mockRestore();
    expect(b.push('\n')).toEqual(['x'.repeat(100_000)]);
  });

  it('closes the connection when a line without newline exceeds the cap', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const p = c.request('ping');
    await flush();
    const chunk = 'y'.repeat(64 * 1024);
    for (let sent = 0; sent <= MAX_LINE_CHARS && !t.closed; sent += chunk.length) t.push(chunk);
    expect(t.closed).toBe(true);
    await expect(p).rejects.toMatchObject({ code: 'protocol' });
    t.push('{"id":"req_1","result":{}}\n');
  });

  it('closes the connection when a complete line exceeds the cap', async () => {
    const t = new FakeTransport();
    const c = new HerdrClient(t);
    const p = c.request('ping');
    await flush();
    t.push('z'.repeat(MAX_LINE_CHARS + 1) + '\n');
    expect(t.closed).toBe(true);
    await expect(p).rejects.toMatchObject({ code: 'protocol' });
  });
});
