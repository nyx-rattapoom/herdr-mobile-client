import { NativeModule, requireNativeModule } from 'expo';

import type { ExecResult, GeneratedKey, HerdrSshEvents, HostKeyInfo, SshAuth } from './HerdrSsh.types';

declare class HerdrSshModule extends NativeModule<HerdrSshEvents> {
  /** Key exchange only; never authenticates. */
  probeHostKey(host: string, port: number): Promise<HostKeyInfo>;
  /**
   * Authenticates only if the server presents exactly `pinnedKey`. With both a key and a
   * password, public-key auth is tried first. Resolves to a session id.
   */
  connect(host: string, port: number, username: string, auth: SshAuth, pinnedKey: string): Promise<string>;
  /** Generates an Ed25519 key pair on the device. */
  generateEd25519(comment: string): Promise<GeneratedKey>;
  exec(sessionId: string, command: string): Promise<ExecResult>;
  /** Opens a direct-streamlocal channel to a Unix socket on the server. Resolves to a channel id. */
  openSocket(sessionId: string, socketPath: string): Promise<string>;
  write(channelId: string, data: string): Promise<void>;
  closeChannel(channelId: string): void;
  disconnect(sessionId: string): void;
  /** Starts the foreground service that keeps connections alive in the background. */
  startMonitoring(text: string): void;
  stopMonitoring(): void;
}

export default requireNativeModule<HerdrSshModule>('HerdrSsh');
