import { ServerStore, endpointInUse, validateServer } from '../store/servers';
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
    expect(validateServer({ ...base, password: '' }, { hasSavedPassword: true })).toBeNull();
    expect(validateServer({ ...base, auth: 'key', password: '' })).toBeNull();
    expect(validateServer({ ...base, herdrPath: 'herdr' })).toMatch(/Herdr path/);
  });

  it('stores profiles separately from passwords and removes both', async () => {
    const kv = new MemoryKv();
    const secrets = new MemoryKv();
    const store = new ServerStore(kv, () => 'id1', secrets);
    const s = await store.add({ ...base, host: ' 10.0.2.2 ' });
    expect(s).toEqual({ id: 'id1', label: 'herdr@10.0.2.2', host: '10.0.2.2', port: 2222, username: 'herdr', auth: 'password' });
    expect(JSON.stringify([...kv.map.values()])).not.toContain('pw');
    expect(await store.password('id1')).toBe('pw');
    await store.remove('id1');
    expect(await store.list()).toEqual([]);
    expect(await store.password('id1')).toBeNull();
  });

  it('key auth needs no password; a password becomes the fallback', async () => {
    const store = new ServerStore(new MemoryKv(), () => 'k1');
    const s = await store.add({ ...base, auth: 'key', password: '', herdrPath: '~/bin/herdr' });
    expect(s).toMatchObject({ auth: 'key', herdrPath: '~/bin/herdr' });
    expect(await store.password('k1')).toBeNull();
  });

  it('edits keep the saved password unless replaced or cleared', async () => {
    const store = new ServerStore(new MemoryKv(), () => 'e1');
    await store.add(base);
    const edited = await store.update('e1', { ...base, label: 'box', port: 22, password: '' });
    expect(edited).toMatchObject({ id: 'e1', label: 'box', port: 22 });
    expect(await store.password('e1')).toBe('pw');
    await store.update('e1', { ...base, password: 'new' });
    expect(await store.password('e1')).toBe('new');
    await expect(store.update('e1', { ...base, password: '' }, { clearPassword: true })).rejects.toThrow(/Password/);
    await store.update('e1', { ...base, auth: 'key', password: '' }, { clearPassword: true });
    expect(await store.password('e1')).toBeNull();
    await expect(store.update('nope', base)).rejects.toThrow('not found');
  });
});

describe('endpointInUse', () => {
  it('matches host case-insensitively per port', () => {
    const list = [{ host: 'Box.example', port: 22 }];
    expect(endpointInUse(list, 'box.example', 22)).toBe(true);
    expect(endpointInUse(list, 'box.example', 2222)).toBe(false);
    expect(endpointInUse([], 'box.example', 22)).toBe(false);
  });
});
