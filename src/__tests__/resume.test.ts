import { Reconnector, type ReconnectOptions, type ReconnectState, type Resumable } from '../live/resume';

const conn = (alive: boolean) => ({ alive: jest.fn(async () => alive), close: jest.fn() });
const live = (status: string) => ({ getState: () => ({ status }), retryNow: jest.fn() });
const offline = Object.assign(new Error('Connection timed out.'), { code: 'ERR_TIMEOUT' });
const authFail = Object.assign(new Error('authentication failed'), { code: 'ERR_AUTH' });

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const setup = (first: Resumable | null, opts: Partial<ReconnectOptions> = {}) => {
  let current = first;
  const states: ReconnectState[] = [];
  const views = [live('offline'), live('live')];
  const reopen = jest.fn(async (): Promise<Resumable> => conn(true));
  const r = new Reconnector({
    current: () => current,
    reopen,
    install: (n) => (current = n),
    lives: () => views,
    isFatal: (e) => (e as { code?: string }).code !== 'ERR_TIMEOUT',
    onState: (s) => states.push(s),
    retryMs: 1000,
    maxRetryMs: 8000,
    ...opts,
  });
  return { r, reopen, views, states, current: () => current, setCurrent: (c: Resumable | null) => (current = c) };
};

describe('Reconnector', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps a live connection and only nudges views that are not live', async () => {
    const c = conn(true);
    const { r, reopen, views } = setup(c);
    r.kick();
    await flush();
    expect(reopen).not.toHaveBeenCalled();
    expect(views[0].retryNow).toHaveBeenCalled();
    expect(views[1].retryNow).not.toHaveBeenCalled();
    expect(r.getState()).toEqual({ kind: 'idle' });
  });

  it('leaves views on a working connection to their own backoff after an automatic kick', async () => {
    const { r, reopen, views } = setup(conn(true));
    r.kick({ auto: true });
    await flush();
    expect(reopen).not.toHaveBeenCalled();
    views.forEach((v) => expect(v.retryNow).not.toHaveBeenCalled());
  });

  it('closes a dead connection at once, replaces it in place and retries every view', async () => {
    const old = conn(false);
    const { r, views, current, states } = setup(old);
    r.kick();
    await flush();
    expect(old.close).toHaveBeenCalled();
    expect(current()).not.toBe(old);
    views.forEach((v) => expect(v.retryNow).toHaveBeenCalled());
    expect(states.map((s) => s.kind)).toEqual(['reconnecting', 'idle']);
  });

  it('keeps retrying with backoff while the server is unreachable, then recovers', async () => {
    const { r, reopen, current, views } = setup(conn(false));
    reopen.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline);
    r.kick();
    await flush();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(r.getState()).toMatchObject({ kind: 'reconnecting', attempt: 1, error: offline });
    jest.advanceTimersByTime(999);
    await flush();
    expect(reopen).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(reopen).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(2000);
    await flush();
    expect(reopen).toHaveBeenCalledTimes(3);
    expect(r.getState()).toEqual({ kind: 'idle' });
    expect(await current()!.alive()).toBe(true);
    views.forEach((v) => expect(v.retryNow).toHaveBeenCalled());
  });

  it('caps the backoff', async () => {
    const { r, reopen, states } = setup(conn(false), { now: () => 0 });
    reopen.mockRejectedValue(offline);
    r.kick();
    for (let i = 0; i < 6; i++) {
      await flush();
      jest.advanceTimersByTime(8000);
    }
    const delays = states.flatMap((s) => (s.kind === 'reconnecting' && s.retryAt !== undefined ? [s.retryAt] : []));
    expect(delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    r.stop();
  });

  it('retries each view once after a user-kicked reconnect, even if kicked again meanwhile', async () => {
    let r!: Reconnector;
    const s = setup(conn(false), {
      reopen: async () => {
        r.kick({ auto: true });
        return conn(true);
      },
    });
    r = s.r;
    r.kick();
    await flush();
    s.views.forEach((v) => expect(v.retryNow).toHaveBeenCalledTimes(1));
  });

  it('reconnects again when the new connection drops right after recovering', async () => {
    const { r, reopen, current } = setup(conn(false));
    r.kick();
    await flush();
    expect(reopen).toHaveBeenCalledTimes(1);
    (current()!.alive as jest.Mock).mockResolvedValue(false);
    r.kick({ auto: true });
    await flush();
    expect(reopen).toHaveBeenCalledTimes(2);
    expect(r.getState()).toEqual({ kind: 'idle' });
  });

  it('coalesces kicks during a check instead of dropping them', async () => {
    let answer!: (v: boolean) => void;
    const c = { alive: jest.fn(() => new Promise<boolean>((res) => (answer = res))), close: jest.fn() };
    const { r, reopen } = setup(c);
    r.kick();
    r.kick({ auto: true });
    r.kick({ auto: true });
    answer(true);
    await flush();
    expect(c.alive).toHaveBeenCalledTimes(2);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('cuts a backoff wait short on a user kick but not on an automatic one', async () => {
    const { r, reopen } = setup(conn(false));
    reopen.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline);
    r.kick();
    await flush();
    jest.advanceTimersByTime(500);
    r.kick({ auto: true });
    await flush();
    expect(reopen).toHaveBeenCalledTimes(1);
    r.kick();
    await flush();
    expect(reopen).toHaveBeenCalledTimes(2);
  });

  it('stops on an error retrying cannot fix, and only the user restarts it', async () => {
    const { r, reopen } = setup(conn(false));
    reopen.mockRejectedValueOnce(authFail);
    r.kick();
    await flush();
    expect(r.getState()).toEqual({ kind: 'failed', error: authFail });
    jest.advanceTimersByTime(60_000);
    r.kick({ auto: true });
    await flush();
    expect(reopen).toHaveBeenCalledTimes(1);
    r.kick();
    await flush();
    expect(reopen).toHaveBeenCalledTimes(2);
    expect(r.getState()).toEqual({ kind: 'idle' });
  });

  it('waits while reopening is not possible, and reopens on the next kick once it is', async () => {
    let allowed = false;
    const { r, reopen } = setup(conn(false), { canReopen: () => allowed });
    r.kick({ auto: true });
    await flush();
    expect(r.getState()).toEqual({ kind: 'waiting' });
    expect(reopen).not.toHaveBeenCalled();
    allowed = true;
    r.kick();
    await flush();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(r.getState()).toEqual({ kind: 'idle' });
  });

  it('drops the new connection when the user left while reconnecting', async () => {
    const next = conn(true);
    const install = jest.fn();
    const { r, setCurrent } = setup(conn(false), {
      install,
      reopen: async () => {
        setCurrent(null);
        return next;
      },
    });
    r.kick();
    await flush();
    expect(next.close).toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('does nothing without a connection, or after stop()', async () => {
    const empty = setup(null);
    empty.r.kick();
    await flush();
    expect(empty.reopen).not.toHaveBeenCalled();

    const { r, reopen } = setup(conn(false));
    reopen.mockRejectedValue(offline);
    r.kick();
    await flush();
    r.stop();
    jest.advanceTimersByTime(60_000);
    await flush();
    r.kick();
    await flush();
    expect(reopen).toHaveBeenCalledTimes(1);
  });
});
