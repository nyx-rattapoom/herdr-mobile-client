import { NativeModule, requireNativeModule } from 'expo';

import type { ExecResult, HerdrSshEvents, HostKeyInfo } from './HerdrSsh.types';

declare class HerdrSshModule extends NativeModule<HerdrSshEvents> {
  /** Key exchange only; never authenticates. */
  probeHostKey(host: string, port: number): Promise<HostKeyInfo>;
  /** Authenticates only if the server presents exactly `pinnedKey`. Resolves to a session id. */
  connect(host: string, port: number, username: string, password: string, pinnedKey: string): Promise<string>;
  exec(sessionId: string, command: string): Promise<ExecResult>;
  /** Opens a direct-streamlocal channel to a Unix socket on the server. Resolves to a channel id. */
  openSocket(sessionId: string, socketPath: string): Promise<string>;
  write(channelId: string, data: string): Promise<void>;
  closeChannel(channelId: string): void;
  disconnect(sessionId: string): void;
}

export default requireNativeModule<HerdrSshModule>('HerdrSsh');
