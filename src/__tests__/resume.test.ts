import { resumeConnection, type Resumable } from '../live/resume';

const conn = (alive: boolean) => ({ alive: jest.fn(async () => alive), close: jest.fn() });
const live = (status: string) => ({ getState: () => ({ status }), retryNow: jest.fn() });

describe('resumeConnection', () => {
  it('keeps a live connection and only nudges views that are not live', async () => {
    const c = conn(true);
    const a = live('live');
    const b = live('reconnecting');
    const reopen = jest.fn();
    expect(await resumeConnection({ current: () => c, reopen, install: jest.fn(), lives: [a, b] })).toBe('alive');
    expect(reopen).not.toHaveBeenCalled();
    expect(a.retryNow).not.toHaveBeenCalled();
    expect(b.retryNow).toHaveBeenCalled();
  });

  it('replaces a dead connection in place and retries every view', async () => {
    let current: Resumable = conn(false);
    const old = current;
    const next = conn(true);
    const views = [live('offline'), live('live')];
    const onReconnecting = jest.fn();
    const result = await resumeConnection({
      current: () => current,
      reopen: async () => next,
      install: (n) => (current = n),
      lives: views,
      onReconnecting,
    });
    expect(result).toBe('reconnected');
    expect(current).toBe(next);
    expect(old.close).toHaveBeenCalled();
    expect(onReconnecting).toHaveBeenCalled();
    views.forEach((v) => expect(v.retryNow).toHaveBeenCalled());
  });

  it('drops the new connection when the user left while reconnecting', async () => {
    let current: Resumable | null = conn(false);
    const next = conn(true);
    const install = jest.fn();
    const result = await resumeConnection({
      current: () => current,
      reopen: async () => {
        current = null;
        return next;
      },
      install,
      lives: [],
    });
    expect(result).toBe('abandoned');
    expect(next.close).toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('does nothing without a connection, and lets a failed reconnect throw', async () => {
    expect(await resumeConnection({ current: () => null, reopen: jest.fn(), install: jest.fn(), lives: [] })).toBe(
      'abandoned',
    );
    const c = conn(false);
    await expect(
      resumeConnection({
        current: () => c,
        reopen: async () => {
          throw new Error('auth');
        },
        install: jest.fn(),
        lives: [],
      }),
    ).rejects.toThrow('auth');
    expect(c.close).not.toHaveBeenCalled();
  });
});
