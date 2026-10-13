import { PaneFlags, formatUntil, nextClockTime, snoozePresets } from '../store/paneFlags';
import { MemoryKv } from '../testing/fakes';

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('snooze times', () => {
  it('offers an hour and tomorrow at 9:00', () => {
    const now = at(2026, 10, 13, 22, 30);
    const [hour, tomorrow] = snoozePresets(now);
    expect(hour.until - now).toBe(3600_000);
    expect(tomorrow.until).toBe(at(2026, 10, 14, 9));
  });

  it('reads a custom HH:MM as its next occurrence', () => {
    const now = at(2026, 10, 13, 22, 30);
    expect(nextClockTime('23:15', now)).toBe(at(2026, 10, 13, 23, 15));
    expect(nextClockTime('7:05', now)).toBe(at(2026, 10, 14, 7, 5));
    expect(nextClockTime('22.30', now)).toBe(at(2026, 10, 14, 22, 30));
    expect(nextClockTime('25:00', now)).toBeNull();
    expect(nextClockTime('soon', now)).toBeNull();
    expect(formatUntil(at(2026, 10, 13, 23, 15), now)).toBe('23:15');
    expect(formatUntil(at(2026, 10, 14, 9), now)).toMatch(/^\w{3} 09:00$/);
  });
});

describe('PaneFlags', () => {
  it('pins, mutes and snoozes per pane, and persists per server and session', async () => {
    const kv = new MemoryKv();
    let now = 1000;
    const f = new PaneFlags(kv, 'srv|default', () => now);
    await f.load();
    await f.setPinned('p1', true);
    await f.setMuted('p2', true);
    await f.snooze('p3', 5000);
    expect(f.get('p1')).toEqual({ pinned: true });
    expect(f.isSilenced('p2')).toBe(true);
    expect(f.isSnoozed('p3')).toBe(true);
    expect(f.isSilenced('p1')).toBe(false);
    const g = new PaneFlags(kv, 'srv|default', () => now);
    await g.load();
    expect(g.get('p2')).toEqual({ muted: true });
    expect(new PaneFlags(kv, 'srv|other').get('p2')).toEqual({});
    now = 6000;
    expect(g.isSnoozed('p3')).toBe(false);
    await g.setPinned('p1', false);
    expect(g.get('p1')).toEqual({});
  });

  it('un-snoozes early, tells listeners when a snooze ends, and prunes closed panes', async () => {
    jest.useFakeTimers();
    try {
      let now = 0;
      const f = new PaneFlags(new MemoryKv(), 's', () => now);
      await f.load();
      const seen: number[] = [];
      f.subscribe(() => seen.push(now));
      await f.snooze('p1', 10_000);
      await f.unsnooze('p1');
      expect(f.isSnoozed('p1')).toBe(false);
      await f.snooze('p2', 10_000);
      seen.length = 0;
      now = 10_100;
      jest.advanceTimersByTime(10_100);
      expect(seen.length).toBeGreaterThan(0);
      expect(f.isSnoozed('p2')).toBe(false);
      await f.setPinned('p4', true);
      await f.prune(new Set(['p1']));
      expect(f.get('p4')).toEqual({});
      expect(f.get('p2')).toEqual({});
      f.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers a prune that arrives before loading', async () => {
    const kv = new MemoryKv();
    const a = new PaneFlags(kv, 's');
    await a.load();
    await a.setMuted('keep', true);
    await a.setMuted('gone', true);
    const b = new PaneFlags(kv, 's');
    await b.prune(new Set(['keep']));
    await b.load();
    expect(b.get('keep')).toEqual({ muted: true });
    expect(b.get('gone')).toEqual({});
  });
});
