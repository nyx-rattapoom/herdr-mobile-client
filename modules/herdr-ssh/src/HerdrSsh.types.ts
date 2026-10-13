export type HostKeyInfo = {
  /** SSH algorithm name from the key blob, e.g. `ssh-ed25519`. */
  algorithm: string;
  /** Base64 of the raw public key blob; this is what gets pinned. */
  key: string;
  /** OpenSSH-style `SHA256:` fingerprint of the key blob. */
  fingerprint: string;
};

export type SshAuth = { password?: string; privateKey?: string };

export type GeneratedKey = {
  /** OpenSSH v1 private key (unencrypted PEM). Store only in Keystore-backed storage. */
  privateKey: string;
  /** `ssh-ed25519 AAAA… comment`, ready for authorized_keys. */
  publicKey: string;
};

export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export type HerdrSshEvents = {
  onChannelData: (e: { channelId: string; data: string }) => void;
  onChannelClose: (e: { channelId: string; reason: string }) => void;
};

/** Error codes rejected by the native module (`error.code`). */
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
