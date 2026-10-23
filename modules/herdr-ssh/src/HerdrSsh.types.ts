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

export type HerdrSshEvents = {
  onChannelData: (e: { channelId: string; data: string }) => void;
  onChannelClose: (e: { channelId: string; reason: string }) => void;
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
  | 'ERR_NO_SESSION'
  | 'ERR_NO_CHANNEL'
  | 'ERR_EXEC'
  | 'ERR_ARGS'
  | 'ERR_SSH';
