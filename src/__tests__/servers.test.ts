import { ServerStore, validateServer } from '../store/servers';
import { MemoryKv } from '../testing/fakes';

const base = { host: '10.0.2.2', port: 2222, username: 'herdr', password: 'pw' };

describe('ServerStore', () => {
  it('validates input', () => {
    expect(validateServer(base)).toBeNull();
    expect(validateServer({ ...base, host: ' ' })).toMatch(/Host/);
    expect(validateServer({ ...base, host: 'a@b' })).toMatch(/Host/);
    expect(validateServer({ ...base, port: 0 })).toMatch(/Port/);
    expect(validateServer({ ...base, port: 70000 })).toMatch(/Port/);
    expect(validateServer({ ...base, username: '' })).toMatch(/User/);
    expect(validateServer({ ...base, password: '' })).toMatch(/Password/);
  });

  it('stores profiles separately from passwords and removes both', async () => {
    const kv = new MemoryKv();
    const store = new ServerStore(kv, () => 'id1');
    const s = await store.add({ ...base, host: ' 10.0.2.2 ' });
    expect(s).toEqual({ id: 'id1', label: 'herdr@10.0.2.2', host: '10.0.2.2', port: 2222, username: 'herdr' });
    expect(JSON.stringify(await store.list())).not.toContain('pw');
    expect(await store.password('id1')).toBe('pw');
    await store.remove('id1');
    expect(await store.list()).toEqual([]);
    expect(await store.password('id1')).toBeNull();
  });
});
