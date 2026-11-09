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

const native = HerdrSsh as unknown as Record<'openExecStream' | 'startExecStream' | 'addListener', jest.Mock>;

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

  it('never opens a stream for a stored hc path that fails validation', async () => {
    setOs('android');
    await expect(NativeCoreTransport.open('s1', '/x;reboot')).rejects.toMatchObject({ code: 'hc_path_invalid' });
    expect(native.openExecStream).not.toHaveBeenCalled();
  });
});
