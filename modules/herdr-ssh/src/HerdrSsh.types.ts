export type HostKeyInfo = {
  algorithm: string;
  key: string;
  fingerprint: string;
};

export type SshAuth = { password?: string; privateKey?: string };

export type GeneratedKey = {
  privateKey: string;
  publicKey: string;
};

export type ExecResult = { stdout: string; stderr: string; exitCode: number };

/** Raw bytes arrive base64-encoded: the bridge never decodes them as text. */
export type ChannelBytesEvent = { channelId: string; data: string };
export type ChannelClosedEvent = { channelId: string; reason: string; exitCode: number | null; stderr: string };

export type HerdrSshEvents = {
  onChannelData: (e: { channelId: string; data: string }) => void;
  onChannelClose: (e: { channelId: string; reason: string }) => void;
  onChannelBytes: (e: ChannelBytesEvent) => void;
  onChannelClosed: (e: ChannelClosedEvent) => void;
};

export type SshErrorCode =
  | 'ERR_HOSTKEY_MISMATCH'
  | 'ERR_AUTH'
  | 'ERR_TIMEOUT'
  | 'ERR_CONNECT'
  | 'ERR_PROBE'
  | 'ERR_FORWARDING_PROHIBITED'
  | 'ERR_SOCKET_UNAVAILABLE'
  | 'ERR_CHANNEL'
  | 'ERR_JUMP_PROHIBITED'
  | 'ERR_JUMP_UNREACHABLE'
  | 'ERR_NO_SESSION'
  | 'ERR_NO_CHANNEL'
  | 'ERR_EXEC'
  | 'ERR_ARGS'
  | 'ERR_SSH';
