import {
  MAX_HOPS,
  ServerStore,
  backendOf,
  dependentsOf,
  endpointInUse,
  isCoreProfile,
  jumpCandidates,
  jumpChain,
  jumpOptions,
  routeLabel,
  validateBackend,
  validateJump,
  validateServer,
} from '../store/servers';
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
    expect(endpointInUse(list, { host: 'box.example', port: 22 })).toBe(true);
    expect(endpointInUse(list, { host: 'box.example', port: 2222 })).toBe(false);
    expect(endpointInUse([], { host: 'box.example', port: 22 })).toBe(false);
  });

  it('treats the same LAN address behind different jump hosts as different endpoints', () => {
    const list = [{ host: '192.168.1.20', port: 22, jumpId: 'a' }];
    expect(endpointInUse(list, { host: '192.168.1.20', port: 22, jumpId: 'a' })).toBe(true);
    expect(endpointInUse(list, { host: '192.168.1.20', port: 22, jumpId: 'b' })).toBe(false);
    expect(endpointInUse(list, { host: '192.168.1.20', port: 22 })).toBe(false);
  });
});

describe('jump hosts', () => {
  const ids = (...xs: string[]) => {
    let i = 0;
    return () => xs[i++];
  };

  it('stores a hop and offers every server that does not route through the edited one', async () => {
    const store = new ServerStore(new MemoryKv(), ids('a', 'b', 'c'));
    const a = await store.add({ ...base, host: '100.64.0.1', label: 'A' });
    const b = await store.add({ ...base, host: '192.168.1.20', label: 'B', jumpId: a.id });
    expect(b.jumpId).toBe('a');
    const list = await store.list();
    expect(jumpCandidates(list).map((s) => s.id)).toEqual(['a', 'b']);
    expect(jumpCandidates(list, 'a')).toEqual([]);
    expect(jumpCandidates(list, 'b').map((s) => s.id)).toEqual(['a']);
    expect(dependentsOf(list, 'a').map((s) => s.id)).toEqual(['b']);
  });

  it('chains hops in travel order', async () => {
    const store = new ServerStore(new MemoryKv(), ids('a', 'b', 'c', 'd'));
    const a = await store.add({ ...base, host: '192.168.1.100', label: 'internal' });
    const b = await store.add({ ...base, host: '10.0.0.2', label: 'pi', auth: 'key', password: '', jumpId: a.id });
    const c = await store.add({ ...base, host: '192.168.88.111', label: 'target', jumpId: b.id });
    const list = await store.list();
    expect(jumpChain(list, c).map((s) => s.id)).toEqual(['a', 'b']);
    expect(jumpChain(list, a)).toEqual([]);
    expect(routeLabel(list, c)).toBe('internal → pi');
    expect(routeLabel(list, a)).toBeUndefined();
    expect(jumpOptions(list, 'd')).toEqual([
      { id: 'a', label: 'internal', route: ['internal'] },
      { id: 'b', label: 'pi', route: ['internal', 'pi'] },
      { id: 'c', label: 'target', route: ['internal', 'pi', 'target'] },
    ]);
  });

  it('rejects loops, self hops and missing servers', async () => {
    const store = new ServerStore(new MemoryKv(), ids('a', 'b', 'c'));
    const a = await store.add({ ...base, label: 'A' });
    const b = await store.add({ ...base, label: 'B', jumpId: a.id });
    const c = await store.add({ ...base, label: 'C', jumpId: b.id });
    await expect(store.update(a.id, { ...base, jumpId: c.id })).rejects.toThrow(/loop/);
    await expect(store.update(a.id, { ...base, jumpId: b.id })).rejects.toThrow(/loop/);
    await expect(store.update(b.id, { ...base, jumpId: b.id })).rejects.toThrow(/itself/);
    await expect(store.add({ ...base, jumpId: 'missing' })).rejects.toThrow(/no longer exists/);
    expect(validateJump(await store.list(), undefined, undefined)).toBeNull();
    expect(jumpCandidates(await store.list(), 'a')).toEqual([]);
  });

  it('reports a broken route instead of looping forever', () => {
    const list = [
      { id: 'a', label: 'A', host: 'h', port: 22, username: 'u', jumpId: 'b' },
      { id: 'b', label: 'B', host: 'h', port: 22, username: 'u', jumpId: 'a' },
      { id: 'c', label: 'C', host: 'h', port: 22, username: 'u', jumpId: 'gone' },
    ];
    expect(() => jumpChain(list, list[0])).toThrow(/route to A loops back through A/);
    expect(() => jumpChain(list, list[2])).toThrow(/jump server for C was removed/);
    expect(jumpCandidates(list)).toEqual([]);
    expect(routeLabel(list, list[2])).toBe('missing server');
  });

  it('counts the servers behind the edited one against the hop cap', () => {
    const list = [
      { id: 'x', label: 'X', host: 'h', port: 22, username: 'u' },
      ...Array.from({ length: MAX_HOPS + 1 }, (_, i) => ({
        id: `s${i}`,
        label: `S${i}`,
        host: 'h',
        port: 22,
        username: 'u',
        ...(i > 0 ? { jumpId: `s${i - 1}` } : {}),
      })),
    ];
    expect(validateJump(list, 's0', 'x')).toMatch(/at most/);
    expect(jumpCandidates(list, 's0')).toEqual([]);
    expect(validateJump(list, 's1', 'x')).toBeNull();
  });

  it('explains a broken route on the chosen jump instead of calling it a loop', () => {
    const list = [
      { id: 'a', label: 'A', host: 'h', port: 22, username: 'u' },
      { id: 'b', label: 'B', host: 'h', port: 22, username: 'u', jumpId: 'gone' },
    ];
    expect(validateJump(list, 'a', 'b')).toMatch(/jump server for B was removed/);
  });

  it(`caps a route at ${MAX_HOPS} hops`, () => {
    const list = Array.from({ length: MAX_HOPS + 1 }, (_, i) => ({
      id: `s${i}`,
      label: `S${i}`,
      host: 'h',
      port: 22,
      username: 'u',
      ...(i > 0 ? { jumpId: `s${i - 1}` } : {}),
    }));
    expect(jumpChain(list, list[MAX_HOPS]).length).toBe(MAX_HOPS);
    expect(jumpCandidates(list).map((s) => s.id)).not.toContain(`s${MAX_HOPS}`);
    expect(validateJump(list, undefined, `s${MAX_HOPS}`)).toMatch(/at most/);
    expect(validateJump(list, undefined, `s${MAX_HOPS - 1}`)).toBeNull();
  });

  it('refuses to remove a server others hop through', async () => {
    const store = new ServerStore(new MemoryKv(), ids('a', 'b'));
    const a = await store.add({ ...base, label: 'A' });
    const b = await store.add({ ...base, label: 'B', jumpId: a.id });
    await expect(store.remove(a.id)).rejects.toThrow(/B hops through/);
    await store.update(b.id, { ...base, label: 'B' });
    expect((await store.list()).find((s) => s.id === 'b')?.jumpId).toBeUndefined();
    await store.remove(a.id);
  });
});

describe('backend selection', () => {
  it('treats missing and unknown stored backends as the original Herdr TUI', async () => {
    const kv = new MemoryKv();
    kv.map.set('servers.v1', JSON.stringify([{ id: 'old', label: 'old', host: 'h', port: 22, username: 'u', auth: 'key' }]));
    const store = new ServerStore(kv);
    const [old] = await store.list();
    expect(backendOf(old)).toBe('legacy');
    expect(isCoreProfile(old)).toBe(false);
    expect(backendOf({ backend: 'future' } as never)).toBe('legacy');
    expect(validateBackend(undefined)).toBeNull();
    expect(validateBackend('legacy')).toBeNull();
    expect(validateBackend('core')).toBeNull();
    expect(validateBackend('future')).toMatch(/Backend/);
  });

  it('persists an explicit Core profile and keeps both executable paths independent when toggled', async () => {
    const secrets = new MemoryKv();
    const store = new ServerStore(new MemoryKv(), () => 'c1', secrets);
    const core = await store.add({ ...base, backend: 'core', herdrPath: '~/bin/herdr', hcPath: '~/bin/hc' });
    expect(core).toMatchObject({ backend: 'core', herdrPath: '~/bin/herdr', hcPath: '~/bin/hc' });
    expect(await store.password('c1')).toBe('pw');

    const legacy = await store.update('c1', { ...base, backend: 'legacy', herdrPath: '~/bin/herdr', hcPath: '~/bin/hc', password: '' });
    expect(legacy.backend).toBeUndefined();
    expect(legacy).toMatchObject({ herdrPath: '~/bin/herdr', hcPath: '~/bin/hc' });
    expect(await store.password('c1')).toBe('pw');

    const again = await store.update('c1', { ...base, backend: 'core', herdrPath: '~/bin/herdr2', hcPath: '~/bin/hc2', password: '' });
    expect(again).toMatchObject({ backend: 'core', herdrPath: '~/bin/herdr2', hcPath: '~/bin/hc2' });
  });

  it('does not write an empty hcPath or backend, keeping old profile shape stable', async () => {
    const store = new ServerStore(new MemoryKv(), () => 'p1');
    const p = await store.add({ ...base, backend: 'legacy', hcPath: '  ' });
    expect(p).not.toHaveProperty('backend');
    expect(p).not.toHaveProperty('hcPath');
  });

  it('rejects invalid backend and hc paths, including shell syntax and traversal', async () => {
    expect(validateServer({ ...base, backend: 'future' } as never)).toMatch(/Backend/);
    expect(validateServer({ ...base, hcPath: 'hc' })).toMatch(/hc path/);
    expect(validateServer({ ...base, hcPath: '/x;id' })).toMatch(/hc path/);
    expect(validateServer({ ...base, hcPath: '/x$(id)' })).toMatch(/hc path/);
    expect(validateServer({ ...base, hcPath: '/x`id`' })).toMatch(/hc path/);
    expect(validateServer({ ...base, hcPath: '/x/../y' })).toMatch(/hc path/);
    expect(validateServer({ ...base, hcPath: '~/bin/hc' })).toBeNull();
    const store = new ServerStore(new MemoryKv(), () => 'x');
    await expect(store.add({ ...base, backend: 'core', hcPath: '/x;id' })).rejects.toThrow(/hc path/);
  });
});
