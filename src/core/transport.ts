import HerdrSsh from '../../modules/herdr-ssh';
import { base64ToBytes, bytesToBase64 } from './bytes';
import { coreConnectCommand, explainCoreClose } from './commands';
import { CORE_PLATFORM_MESSAGE, corePlatformAvailable } from './platform';
import { CoreUnsupportedError } from './types';

export type TransportClose = { reason: string; exitCode: number | null; stderr: string };

/** Raw bytes in both directions. No UTF-8 decoding happens in this layer. */
export interface ByteTransport {
  write(bytes: Uint8Array): Promise<void>;
  onBytes(handler: (chunk: Uint8Array) => void): void;
  onClose(handler: (info: TransportClose) => void): void;
  close(): void;
}

/**
 * Android no-PTY `hc connect` byte channel.
 *
 * The native side buffers stdout until `startExecStream` runs, and only then
 * emits base64 events, so the first paint cannot be lost before listeners are
 * installed. Base64 is a bridge envelope only.
 */
export class NativeCoreTransport implements ByteTransport {
  private bytes: (chunk: Uint8Array) => void = () => {};
  private closed: (info: TransportClose) => void = () => {};
  private subs: { remove(): void }[] = [];
  private done = false;

  private constructor(private readonly channelId: string) {}

  static async open(sessionId: string, hcPath?: string): Promise<NativeCoreTransport> {
    if (!corePlatformAvailable()) throw new CoreUnsupportedError('platform', CORE_PLATFORM_MESSAGE);
    const channelId = await HerdrSsh.openExecStream(sessionId, coreConnectCommand(hcPath));
    const t = new NativeCoreTransport(channelId);
    t.subs = [
      HerdrSsh.addListener('onChannelBytes', (e) => {
        if (e.channelId !== channelId || t.done) return;
        try {
          t.bytes(base64ToBytes(e.data));
        } catch {
          t.finish({ reason: 'invalid byte payload', exitCode: null, stderr: '' });
        }
      }),
      HerdrSsh.addListener('onChannelClosed', (e) => {
        if (e.channelId !== channelId) return;
        t.finish({ reason: e.reason, exitCode: e.exitCode, stderr: e.stderr });
      }),
    ];
    HerdrSsh.startExecStream(channelId);
    return t;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.done) return Promise.reject(explainCoreClose({ reason: 'closed', exitCode: null, stderr: '' }));
    return HerdrSsh.writeBytes(this.channelId, bytesToBase64(bytes));
  }

  onBytes(handler: (chunk: Uint8Array) => void): void {
    this.bytes = handler;
  }

  onClose(handler: (info: TransportClose) => void): void {
    this.closed = handler;
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.unsubscribe();
    HerdrSsh.closeExecStream(this.channelId);
  }

  private finish(info: TransportClose): void {
    if (this.done) return;
    this.done = true;
    this.unsubscribe();
    this.closed(info);
  }

  private unsubscribe(): void {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
  }
}
