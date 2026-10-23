import { NativeModule, requireNativeModule } from 'expo';

import type { ExecResult, GeneratedKey, HerdrSshEvents, HostKeyInfo, SshAuth } from './HerdrSsh.types';

declare class HerdrSshModule extends NativeModule<HerdrSshEvents> {
  probeHostKey(host: string, port: number): Promise<HostKeyInfo>;
  connect(host: string, port: number, username: string, auth: SshAuth, pinnedKey: string): Promise<string>;
  generateEd25519(comment: string): Promise<GeneratedKey>;
  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  openSocket(sessionId: string, socketPath: string): Promise<string>;
  write(channelId: string, data: string): Promise<void>;
  closeChannel(channelId: string): void;
  disconnect(sessionId: string): void;
  startMonitoring(text: string): void;
  stopMonitoring(): void;
  setSecureScreen(on: boolean): void;
}

export default requireNativeModule<HerdrSshModule>('HerdrSsh');
