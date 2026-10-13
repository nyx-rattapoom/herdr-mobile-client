import { DeviceKeyStore, shortKey } from '../store/deviceKey';
import { Secrets, SecretsUnavailable, loadSettings, saveSettings } from '../store/secrets';
import { MemoryKv } from '../testing/fakes';

describe('Secrets', () => {
  class CountingKv extends MemoryKv {
    reads = 0;
    writes = 0;
    async getItem(k: string) {
      this.reads++;
      return super.getItem(k);
    }
    async setItem(k: string, v: string) {
      this.writes++;
      return super.setItem(k, v);
    }
  }
  const setup = () => {
    const plain = new MemoryKv();
    const vault = new CountingKv();
    let bio = false;
    const s = new Secrets(plain, vault, () => bio);
    return { plain, vault, s, setBio: (b: boolean) => (bio = b) };
  };

  it('uses plain items without biometrics', async () => {
    const { plain, vault, s } = setup();
    await s.setItem('pw.a', '1');
    expect(plain.map.get('pw.a')).toBe('1');
    expect(await s.getItem('pw.a')).toBe('1');
    expect(vault.map.size).toBe(0);
  });

  it('moves secrets into one vault blob, unlocking once until locked', async () => {
    const { plain, vault, s, setBio } = setup();
    await s.setItem('pw.a', '1');
    await s.setItem('devicekey.prv', 'K');
    setBio(true);
    await s.enableBiometric(['pw.a', 'devicekey.prv', 'pw.missing']);
    expect(plain.map.size).toBe(0);
    expect(vault.writes).toBe(1);
    s.lock();
    expect(await s.getItem('pw.a')).toBe('1');
    expect(await s.getItem('devicekey.prv')).toBe('K');
    expect(vault.reads).toBe(1);
    await s.setItem('pw.b', '2');
    await s.deleteItem('pw.a');
    s.lock();
    expect(await s.getItem('pw.b')).toBe('2');
    expect(await s.getItem('pw.a')).toBeNull();
  });

  it('reports an invalidated vault and can move back to plain', async () => {
    const { plain, vault, s, setBio } = setup();
    setBio(true);
    await s.enableBiometric([]);
    await s.setItem('pw.a', '1');
    expect(await s.disableBiometric()).toBe(true);
    setBio(false);
    expect(plain.map.get('pw.a')).toBe('1');
    expect(vault.map.size).toBe(0);
    setBio(true);
    s.lock();
    await expect(s.getItem('pw.a')).rejects.toBeInstanceOf(SecretsUnavailable);
    expect(await s.disableBiometric()).toBe(false);
  });

  it('persists settings with safe defaults', async () => {
    const kv = new MemoryKv();
    expect(await loadSettings(kv)).toEqual({ biometric: false });
    await saveSettings(kv, { biometric: true });
    expect(await loadSettings(kv)).toEqual({ biometric: true });
    kv.map.set('settings.v1', 'garbage');
    expect(await loadSettings(kv)).toEqual({ biometric: false });
  });
});

describe('DeviceKeyStore', () => {
  const pub = (n: number) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n}xyz phone`;
  const setup = () => {
    let n = 0;
    const plain = new MemoryKv();
    const secrets = new MemoryKv();
    const gen = jest.fn(async () => ({ privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----${++n}`, publicKey: pub(n) }));
    return { store: new DeviceKeyStore(plain, secrets, gen), plain, secrets, gen };
  };

  it('generates once and keeps the private key in secrets only', async () => {
    const { store, plain, secrets, gen } = setup();
    expect(await store.publicKey()).toBeNull();
    expect(await store.ensure('phone')).toBe(pub(1));
    expect(await store.ensure('phone')).toBe(pub(1));
    expect(gen).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...plain.map.values()])).not.toContain('PRIVATE');
    expect([...secrets.map.values()][0]).toContain('PRIVATE');
    expect(await store.privateKey()).toContain('PRIVATE KEY-----1');
  });

  it('regenerates on request and rejects odd keys', async () => {
    const { store } = setup();
    await store.ensure('x');
    expect(await store.regenerate('x')).toBe(pub(2));
    const bad = new DeviceKeyStore(new MemoryKv(), new MemoryKv(), async () => ({ privateKey: 'p', publicKey: 'ssh-rsa AAAA' }));
    await expect(bad.ensure('x')).rejects.toThrow('unexpected');
    expect(shortKey(pub(1))).toBe('ssh-ed25519 …TE5AAAAI1xyz phone');
  });
});
