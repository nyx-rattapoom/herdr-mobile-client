import type { HostKeyInfo } from '../../modules/herdr-ssh';

/** A host key the user explicitly confirmed for one host:port. */
export type HostKeyPin = {
  algorithm: string;
  /** Base64 key blob. Comparison is on the full blob, not the fingerprint. */
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

/** Minimal key/value storage; SecureStore in the app, a Map in tests. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/** Pins are scoped to the exact endpoint the user typed. */
export function endpointId(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/** SecureStore keys allow only [A-Za-z0-9._-]. */
function storageKey(host: string, port: number): string {
  const id = endpointId(host, port);
  let hex = '';
  for (const b of new TextEncoder().encode(id)) hex += b.toString(16).padStart(2, '0');
  return `pin.${hex}`;
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

  /**
   * Records a key the user confirmed. Refuses to replace a different existing pin; the user must
   * forget the old pin first, so a mismatch can never be silently accepted.
   */
  async pin(host: string, port: number, key: HostKeyInfo): Promise<HostKeyPin> {
    const existing = await this.get(host, port);
    if (existing && existing.key !== key.key) {
      throw new Error('a different host key is already pinned for this server');
    }
    if (existing) return existing;
    const pin: HostKeyPin = { algorithm: key.algorithm, key: key.key, fingerprint: key.fingerprint, pinnedAt: this.now() };
    await this.kv.setItem(storageKey(host, port), JSON.stringify(pin));
    return pin;
  }

  async forget(host: string, port: number): Promise<void> {
    await this.kv.deleteItem(storageKey(host, port));
  }
}
