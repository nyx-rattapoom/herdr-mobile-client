import { Platform } from 'react-native';

import HerdrSsh from '../../modules/herdr-ssh';
import { coreConnectCommand } from '../core/commands';
import { CORE_PLATFORM_MESSAGE } from '../core/platform';
import { NativeCoreTransport } from '../core/transport';

jest.mock('../../modules/herdr-ssh', () => ({
  __esModule: true,
  default: {
    openExecStream: jest.fn(async () => 'ch-1'),
    startExecStream: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    writeBytes: jest.fn(async () => {}),
    closeExecStream: jest.fn(),
  },
}));

const native = HerdrSsh as unknown as Record<'openExecStream' | 'startExecStream' | 'addListener' | 'writeBytes', jest.Mock>;

describe('NativeCoreTransport platform gate', () => {
  const original = Platform.OS;
  const setOs = (os: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => setOs(original));

  it('refuses Core on iOS before calling any native stream method', async () => {
    setOs('ios');
    await expect(NativeCoreTransport.open('s1', '/opt/hc')).rejects.toMatchObject({
      code: 'platform',
      message: CORE_PLATFORM_MESSAGE,
    });
    expect(native.openExecStream).not.toHaveBeenCalled();
    expect(native.addListener).not.toHaveBeenCalled();
    expect(native.startExecStream).not.toHaveBeenCalled();
  });

  it('opens `hc connect` on Android and starts delivery only after listeners exist', async () => {
    setOs('android');
    await NativeCoreTransport.open('s1', '/opt/hc');
    expect(native.openExecStream).toHaveBeenCalledWith('s1', coreConnectCommand('/opt/hc'));
    expect(native.addListener).toHaveBeenCalledTimes(2);
    expect(native.startExecStream).toHaveBeenCalledWith('ch-1');
    expect(native.startExecStream.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...native.addListener.mock.invocationCallOrder),
    );
  });

  it('hands frames to the native stream one at a time, in call order', async () => {
    setOs('android');
    const t = await NativeCoreTransport.open('s1');
    const pending: (() => void)[] = [];
    native.writeBytes.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    const first = t.write(Uint8Array.of(1));
    const second = t.write(Uint8Array.of(2));
    const third = t.write(Uint8Array.of(3));
    await Promise.resolve();
    expect(native.writeBytes.mock.calls.map((c) => c[1])).toEqual(['AQ==']);
    pending.shift()?.();
    await first;
    await Promise.resolve();
    expect(native.writeBytes.mock.calls.map((c) => c[1])).toEqual(['AQ==', 'Ag==']);
    pending.shift()?.();
    await second;
    await Promise.resolve();
    pending.shift()?.();
    await third;
    expect(native.writeBytes.mock.calls.map((c) => c[1])).toEqual(['AQ==', 'Ag==', 'Aw==']);
  });

  it('keeps later writes flowing after one native write fails', async () => {
    setOs('android');
    const t = await NativeCoreTransport.open('s1');
    native.writeBytes.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    await expect(t.write(Uint8Array.of(1))).rejects.toThrow('boom');
    await expect(t.write(Uint8Array.of(2))).resolves.toBeUndefined();
  });

  it('never opens a stream for a stored hc path that fails validation', async () => {
    setOs('android');
    await expect(NativeCoreTransport.open('s1', '/x;reboot')).rejects.toMatchObject({ code: 'hc_path_invalid' });
    expect(native.openExecStream).not.toHaveBeenCalled();
  });
});
