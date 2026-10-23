import type { HostKeyInfo } from '../../modules/herdr-ssh';

export type HostKeyPin = {
  algorithm: string;
  key: string;
  fingerprint: string;
  pinnedAt: number;
};

export type PinDecision =
  | { kind: 'unpinned'; presented: HostKeyInfo }
  | { kind: 'match'; pin: HostKeyPin }
  | { kind: 'mismatch'; pin: HostKeyPin; presented: HostKeyInfo };

export function decidePin(pin: HostKeyPin | null, presented: HostKeyInfo): PinDecision {
  if (!pin) return { kind: 'unpinned', presented };
  if (pin.key === presented.key) return { kind: 'match', pin };
  return { kind: 'mismatch', pin, presented };
}

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export function endpointId(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

function storageKey(host: string, port: number, prefix = 'pin'): string {
  const id = endpointId(host, port);
  let hex = '';
  for (const b of new TextEncoder().encode(id)) hex += b.toString(16).padStart(2, '0');
  return `${prefix}.${hex}`;
}

export type ForgottenPin = { algorithm: string; fingerprint: string; forgottenAt: number };

export function hostKeyFileHint(algorithm: string): string {
  const file = algorithm.includes('ed25519')
    ? 'ssh_host_ed25519_key.pub'
    : algorithm.startsWith('ecdsa-')
      ? 'ssh_host_ecdsa_key.pub'
      : algorithm.includes('rsa')
        ? 'ssh_host_rsa_key.pub'
        : null;
  return file ? `ssh-keygen -lf /etc/ssh/${file}` : 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done';
}

export class PinStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  async get(host: string, port: number): Promise<HostKeyPin | null> {
    const raw = await this.kv.getItem(storageKey(host, port));
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Partial<HostKeyPin>;
      if (typeof p.key !== 'string' || !p.key || typeof p.fingerprint !== 'string') return null;
      return { algorithm: p.algorithm ?? 'unknown', key: p.key, fingerprint: p.fingerprint, pinnedAt: p.pinnedAt ?? 0 };
    } catch {
      return null;
    }
  }

  async pin(host: string, port: number, key: HostKeyInfo): Promise<HostKeyPin> {
    const existing = await this.get(host, port);
    if (existing && existing.key !== key.key) {
      throw new Error('a different host key is already pinned for this server');
    }
    if (existing) return existing;
    const pin: HostKeyPin = { algorithm: key.algorithm, key: key.key, fingerprint: key.fingerprint, pinnedAt: this.now() };
    await this.kv.setItem(storageKey(host, port), JSON.stringify(pin));
    await this.kv.deleteItem(storageKey(host, port, 'pinprev'));
    return pin;
  }

  async forget(host: string, port: number): Promise<void> {
    const old = await this.get(host, port);
    if (old) {
      const prev: ForgottenPin = { algorithm: old.algorithm, fingerprint: old.fingerprint, forgottenAt: this.now() };
      await this.kv.setItem(storageKey(host, port, 'pinprev'), JSON.stringify(prev));
    }
    await this.kv.deleteItem(storageKey(host, port));
  }

  async previous(host: string, port: number): Promise<ForgottenPin | null> {
    try {
      const v = JSON.parse((await this.kv.getItem(storageKey(host, port, 'pinprev'))) ?? 'null');
      return v && typeof v.fingerprint === 'string' ? (v as ForgottenPin) : null;
    } catch {
      return null;
    }
  }

  async purge(host: string, port: number): Promise<void> {
    await this.kv.deleteItem(storageKey(host, port));
    await this.kv.deleteItem(storageKey(host, port, 'pinprev'));
  }
}
