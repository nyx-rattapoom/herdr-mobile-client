import { PinStore, decidePin, endpointId, hostKeyFileHint } from '../ssh/pinning';
import { MemoryKv } from '../testing/fakes';

const keyA = { algorithm: 'ssh-ed25519', key: 'AAAAC3NzaC1lZDI1NTE5AAAAIA==', fingerprint: 'SHA256:aaaa' };
const keyB = { algorithm: 'ssh-ed25519', key: 'AAAAC3NzaC1lZDI1NTE5AAAAIB==', fingerprint: 'SHA256:bbbb' };

describe('decidePin', () => {
  it('asks for confirmation when nothing is pinned', () => {
    expect(decidePin(null, keyA)).toEqual({ kind: 'unpinned', presented: keyA });
  });

  it('matches on the full key blob', () => {
    const pin = { ...keyA, pinnedAt: 1 };
    expect(decidePin(pin, keyA)).toEqual({ kind: 'match', pin });
  });

  it('blocks a different key even if the fingerprint string were spoofed', () => {
    const pin = { ...keyA, pinnedAt: 1 };
    const spoof = { ...keyB, fingerprint: keyA.fingerprint };
    expect(decidePin(pin, spoof)).toEqual({ kind: 'mismatch', pin, presented: spoof });
  });
});

describe('PinStore', () => {
  it('persists a confirmed pin per host:port', async () => {
    const kv = new MemoryKv();
    const store = new PinStore(kv, () => 42);
    expect(await store.get('Example.com', 22)).toBeNull();
    await store.pin('Example.com', 22, keyA);
    const again = new PinStore(kv);
    expect(await again.get('example.com', 22)).toEqual({ ...keyA, pinnedAt: 42 });
    expect(await again.get('example.com', 2222)).toBeNull();
  });

  it('refuses to overwrite a different existing pin', async () => {
    const store = new PinStore(new MemoryKv());
    await store.pin('h', 22, keyA);
    await expect(store.pin('h', 22, keyB)).rejects.toThrow('already pinned');
    expect((await store.get('h', 22))?.key).toBe(keyA.key);
  });

  it('re-pinning the same key is a no-op', async () => {
    const store = new PinStore(new MemoryKv(), () => 1);
    const first = await store.pin('h', 22, keyA);
    expect(await store.pin('h', 22, keyA)).toEqual(first);
  });

  it('forget allows pinning a new key', async () => {
    const store = new PinStore(new MemoryKv());
    await store.pin('h', 22, keyA);
    await store.forget('h', 22);
    await store.pin('h', 22, keyB);
    expect((await store.get('h', 22))?.key).toBe(keyB.key);
  });

  it('treats corrupt stored pins as absent', async () => {
    const kv = new MemoryKv();
    const store = new PinStore(kv);
    await store.pin('h', 22, keyA);
    const [k] = [...kv.map.keys()];
    kv.map.set(k, '{not json');
    expect(await store.get('h', 22)).toBeNull();
    kv.map.set(k, JSON.stringify({ fingerprint: 'x' }));
    expect(await store.get('h', 22)).toBeNull();
  });

  it('uses SecureStore-safe keys for any host', async () => {
    const store = new PinStore(new MemoryKv());
    await expect(store.pin('fe80::1%wlan0', 22, keyA)).resolves.toBeTruthy();
    expect(endpointId(' Host ', 22)).toBe('host:22');
  });
});

describe('forgotten pins and hints (review L9)', () => {
  it('remembers the forgotten fingerprint until the endpoint is pinned again', async () => {
    const store = new PinStore(new MemoryKv(), () => 7);
    await store.pin('h', 22, keyA);
    expect(await store.previous('h', 22)).toBeNull();
    await store.forget('h', 22);
    expect(await store.get('h', 22)).toBeNull();
    expect(await store.previous('h', 22)).toEqual({ algorithm: 'ssh-ed25519', fingerprint: keyA.fingerprint, forgottenAt: 7 });
    await store.pin('h', 22, keyB);
    expect(await store.previous('h', 22)).toBeNull();
  });

  it('purge removes the pin and its history', async () => {
    const store = new PinStore(new MemoryKv());
    await store.pin('h', 22, keyA);
    await store.forget('h', 22);
    await store.purge('h', 22);
    expect(await store.previous('h', 22)).toBeNull();
  });

  it('derives the host key file from the algorithm', () => {
    expect(hostKeyFileHint('ssh-ed25519')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    expect(hostKeyFileHint('ecdsa-sha2-nistp256')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub');
    expect(hostKeyFileHint('rsa-sha2-512')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub');
    expect(hostKeyFileHint('ssh-rsa')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub');
    expect(hostKeyFileHint('weird')).toContain('ssh_host_*_key.pub');
  });
});
