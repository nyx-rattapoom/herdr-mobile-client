import type { KeyValueStore } from '../ssh/pinning';

const VAULT_KEY = 'vault.v1';

/**
 * Secrets (server passwords, the device private key). Without biometrics, each lives in its own
 * Keystore-backed SecureStore item. With biometrics, all of them live in one blob in a store
 * that requires user authentication, so one prompt unlocks them; the decrypted blob is cached in
 * memory until `lock()` (called when the app goes to the background). Android invalidates the
 * protected key when enrolled biometrics change; the blob then reads as null.
 */
export class Secrets implements KeyValueStore {
  private cache: Record<string, string> | null = null;

  constructor(
    private readonly plain: KeyValueStore,
    private readonly vault: KeyValueStore,
    private readonly biometric: () => boolean,
  ) {}

  lock(): void {
    this.cache = null;
  }

  get unlocked(): boolean {
    return this.cache !== null;
  }

  async getItem(key: string): Promise<string | null> {
    if (!this.biometric()) return this.plain.getItem(key);
    return (await this.load())[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!this.biometric()) return this.plain.setItem(key, value);
    const blob = { ...(await this.load()), [key]: value };
    await this.vault.setItem(VAULT_KEY, JSON.stringify(blob));
    this.cache = blob;
  }

  async deleteItem(key: string): Promise<void> {
    await this.plain.deleteItem(key);
    if (!this.biometric()) return;
    const blob = { ...(await this.load()) };
    if (!(key in blob)) return;
    delete blob[key];
    await this.vault.setItem(VAULT_KEY, JSON.stringify(blob));
    this.cache = blob;
  }

  /** Moves the given secrets into the protected vault (one write) and removes the plain copies. */
  async enableBiometric(keys: string[]): Promise<void> {
    const blob: Record<string, string> = {};
    for (const k of keys) {
      const v = await this.plain.getItem(k);
      if (v !== null) blob[k] = v;
    }
    await this.vault.setItem(VAULT_KEY, JSON.stringify(blob));
    this.cache = blob;
    for (const k of keys) await this.plain.deleteItem(k);
  }

  /** Moves everything back to plain items. Returns false if the vault could not be read. */
  async disableBiometric(): Promise<boolean> {
    const raw = this.cache ?? (await this.readVault());
    if (raw === null) return false;
    for (const [k, v] of Object.entries(raw)) await this.plain.setItem(k, v);
    await this.vault.deleteItem(VAULT_KEY);
    this.cache = null;
    return true;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    const blob = await this.readVault();
    if (blob === null) throw new SecretsUnavailable();
    this.cache = blob;
    return blob;
  }

  private async readVault(): Promise<Record<string, string> | null> {
    const raw = await this.vault.getItem(VAULT_KEY);
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? (v as Record<string, string>) : null;
    } catch {
      return null;
    }
  }
}

/** The protected vault is missing or was invalidated (e.g. biometrics changed). */
export class SecretsUnavailable extends Error {
  constructor() {
    super('Saved credentials are locked or were invalidated (biometrics changed). Re-enter passwords and recreate the device key.');
    this.name = 'SecretsUnavailable';
  }
}

export type Settings = { biometric: boolean };
const SETTINGS_KEY = 'settings.v1';

export async function loadSettings(kv: KeyValueStore): Promise<Settings> {
  try {
    const v = JSON.parse((await kv.getItem(SETTINGS_KEY)) ?? '{}');
    return { biometric: v.biometric === true };
  } catch {
    return { biometric: false };
  }
}

export const saveSettings = (kv: KeyValueStore, s: Settings) => kv.setItem(SETTINGS_KEY, JSON.stringify(s));
