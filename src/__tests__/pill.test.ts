import { formatElapsed, pillFor } from '../live/pill';

describe('status pill', () => {
  it('formats elapsed time compactly', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(187_000)).toBe('3m 07s');
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('puts connection trouble first, then needs-you, then working time', () => {
    expect(pillFor('reconnecting', 'blocked', 0, 0)).toMatchObject({ kind: 'reconnecting', retry: true });
    expect(pillFor('offline', 'working', 0, 0)).toMatchObject({ kind: 'offline', retry: true });
    expect(pillFor('unsupported', undefined, 0, 0)).toMatchObject({ kind: 'offline', retry: true });
    expect(pillFor('live', 'blocked', 1, 2)).toEqual({ kind: 'blocked', text: 'Needs you', retry: false });
    expect(pillFor('live', 'working', 10_000, 75_000)).toMatchObject({ kind: 'working', text: 'Working · 1m 05s' });
    expect(pillFor('live', 'working', 0, 75_000)?.text).toBe('Working');
    expect(pillFor('live', 'idle', 1, 2)).toBeNull();
    expect(pillFor('connecting', undefined, 0, 0)).toBeNull();
  });
});
