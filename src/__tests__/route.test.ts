import HerdrSsh from '../../modules/herdr-ssh';
import { JumpHostError, ServerConnection, type JumpHost } from '../ssh/connection';

jest.mock('../../modules/herdr-ssh', () => ({
  __esModule: true,
  default: { connect: jest.fn(), probeHostKey: jest.fn(), disconnect: jest.fn() },
}));

const native = HerdrSsh as unknown as { connect: jest.Mock; probeHostKey: jest.Mock; disconnect: jest.Mock };
const pin = (k: string) => ({ algorithm: 'ssh-ed25519', key: k, fingerprint: `fp-${k}`, pinnedAt: 0 });
const hop = (label: string, host: string): JumpHost => ({
  label,
  params: { host, port: 22, username: 'u', password: `pw-${label}` },
  pin: pin(`key-${label}`),
});
const route = [hop('internal', '192.168.1.100'), hop('pi', '10.0.0.2')];
const target = { host: '192.168.88.111', port: 22, username: 'u', password: 'pw-target' };

beforeEach(() => {
  jest.resetAllMocks();
  native.connect.mockImplementation(async (host: string) => `s:${host}`);
});

describe('opening a route of jump hosts', () => {
  it('opens each hop through the one before it and closes inner first', async () => {
    const c = await ServerConnection.open(target, pin('key-target'), route);
    expect(native.connect.mock.calls.map((a) => [a[0], a[3].password, a[4], a[5]])).toEqual([
      ['192.168.1.100', 'pw-internal', 'key-internal', null],
      ['10.0.0.2', 'pw-pi', 'key-pi', 's:192.168.1.100'],
      ['192.168.88.111', 'pw-target', 'key-target', 's:10.0.0.2'],
    ]);
    c.close();
    expect(native.disconnect.mock.calls.map((a) => a[0])).toEqual(['s:192.168.88.111', 's:10.0.0.2', 's:192.168.1.100']);
  });

  it('names the failing middle hop, sends nothing further and closes the hops already open', async () => {
    native.connect.mockImplementation(async (host: string) => {
      if (host === '10.0.0.2') throw Object.assign(new Error('auth'), { code: 'ERR_AUTH' });
      return `s:${host}`;
    });
    const err = await ServerConnection.open(target, pin('key-target'), route).catch((e) => e);
    expect(err).toBeInstanceOf(JumpHostError);
    expect(err.label).toBe('pi');
    expect(err.code).toBe('ERR_AUTH');
    expect(native.connect).toHaveBeenCalledTimes(2);
    expect(native.disconnect.mock.calls.map((a) => a[0])).toEqual(['s:192.168.1.100']);
  });

  it('closes the whole chain when the target fails', async () => {
    native.connect.mockImplementation(async (host: string) => {
      if (host === target.host) throw Object.assign(new Error('changed'), { code: 'ERR_HOSTKEY_MISMATCH' });
      return `s:${host}`;
    });
    const err = await ServerConnection.open(target, pin('key-target'), route).catch((e) => e);
    expect(err).not.toBeInstanceOf(JumpHostError);
    expect(native.disconnect.mock.calls.map((a) => a[0])).toEqual(['s:10.0.0.2', 's:192.168.1.100']);
  });

  it('probes the target through the last hop without its credentials and then closes the route', async () => {
    native.probeHostKey.mockResolvedValue(pin('presented'));
    await expect(ServerConnection.probeHostKey(target.host, 22, route)).resolves.toEqual(pin('presented'));
    expect(native.probeHostKey).toHaveBeenCalledWith(target.host, 22, 's:10.0.0.2');
    expect(native.connect.mock.calls.map((a) => a[0])).toEqual(['192.168.1.100', '10.0.0.2']);
    expect(native.disconnect.mock.calls.map((a) => a[0])).toEqual(['s:10.0.0.2', 's:192.168.1.100']);
  });

  it('probes directly with no route', async () => {
    native.probeHostKey.mockResolvedValue(pin('presented'));
    await ServerConnection.probeHostKey(target.host, 22);
    expect(native.probeHostKey).toHaveBeenCalledWith(target.host, 22, null);
    expect(native.connect).not.toHaveBeenCalled();
  });
});
