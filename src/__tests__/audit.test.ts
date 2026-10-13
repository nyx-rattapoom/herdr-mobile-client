import { AuditLog, MAX_ENTRIES, PAGE_SIZE } from '../store/audit';
import { MemoryKv } from '../testing/fakes';

describe('AuditLog', () => {
  it('records entries with a time and lists them newest first', async () => {
    let t = 1000;
    const log = new AuditLog(new MemoryKv(), () => t++);
    await log.record({ server: 'box', target: 'pane w1:p2', action: 'close pane' });
    await log.record({ server: 'box', target: 'pane w2:p1', action: 'quick answer: Allow once' });
    expect(await log.list()).toEqual([
      { t: 1001, server: 'box', target: 'pane w2:p1', action: 'quick answer: Allow once' },
      { t: 1000, server: 'box', target: 'pane w1:p2', action: 'close pane' },
    ]);
  });

  it('keeps each stored value small and caps the total, dropping the oldest', async () => {
    const kv = new MemoryKv();
    const log = new AuditLog(kv);
    for (let i = 0; i < MAX_ENTRIES + PAGE_SIZE * 2 + 3; i++) {
      await log.record({
        server: 'a very long server label '.repeat(10),
        target: `pane w1:p${i}`,
        action: 'close pane',
      });
    }
    const all = await log.list();
    expect(all.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(all.length).toBeGreaterThan(MAX_ENTRIES - PAGE_SIZE);
    expect(all[0].target).toBe(`pane w1:p${MAX_ENTRIES + PAGE_SIZE * 2 + 2}`);
    expect(all[0].server.length).toBeLessThanOrEqual(80);
    for (const v of kv.map.values()) expect(v.length).toBeLessThan(2048);
  });

  it('serialises concurrent records and clears everything', async () => {
    const kv = new MemoryKv();
    const log = new AuditLog(kv);
    await Promise.all([1, 2, 3, 4, 5].map((i) => log.record({ server: 's', target: `t${i}`, action: 'x' })));
    expect((await log.list()).map((e) => e.target).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    await log.clear();
    expect(await log.list()).toEqual([]);
    expect(kv.map.size).toBe(0);
  });
});
