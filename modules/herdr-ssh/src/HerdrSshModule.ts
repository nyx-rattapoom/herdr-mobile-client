import { NativeModule, requireNativeModule } from 'expo';

import type { ExecResult, GeneratedKey, HerdrSshEvents, HostKeyInfo, SshAuth } from './HerdrSsh.types';

declare class HerdrSshModule extends NativeModule<HerdrSshEvents> {
  probeHostKey(host: string, port: number, viaSessionId: string | null): Promise<HostKeyInfo>;
  connect(
    host: string,
    port: number,
    username: string,
    auth: SshAuth,
    pinnedKey: string,
    viaSessionId: string | null,
  ): Promise<string>;
  generateEd25519(comment: string): Promise<GeneratedKey>;
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  openSocket(sessionId: string, socketPath: string): Promise<string>;
  /** Android only until the iOS Core follow-up: a long-lived no-PTY exec channel. */
  openExecStream(sessionId: string, command: string): Promise<string>;
  /** Starts byte delivery after the JS consumer has installed its listeners. */
  startExecStream(channelId: string): void;
  /** Base64 is the bridge envelope only; frame bytes are never text-decoded. */
  writeBytes(channelId: string, data: string): Promise<void>;
  closeExecStream(channelId: string): void;
  write(channelId: string, data: string): Promise<void>;
  closeChannel(channelId: string): void;
  disconnect(sessionId: string): void;
  startMonitoring(text: string): void;
  stopMonitoring(): void;
  setSecureScreen(on: boolean): void;
}

export default requireNativeModule<HerdrSshModule>('HerdrSsh');
