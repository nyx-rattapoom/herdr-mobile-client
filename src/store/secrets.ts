import type { KeyValueStore } from '../ssh/pinning';

const VAULT_KEY = 'vault.v1';

export class Secrets implements KeyValueStore {
  private cache: Record<string, string> | null = null;

  constructor(
    private readonly plain: KeyValueStore,
    private readonly vault: KeyValueStore,
    private readonly biometric: () => boolean,
    private readonly ready: Promise<unknown> = Promise.resolve(),
  ) {}

  lock(): void {
    this.cache = null;
  }

  get unlocked(): boolean {
    return this.cache !== null;
  }

  async getItem(key: string): Promise<string | null> {
    await this.ready;
    if (!this.biometric()) return this.plain.getItem(key);
    return (await this.load())[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.ready;
    if (!this.biometric()) return this.plain.setItem(key, value);
    const blob = { ...(await this.load()), [key]: value };
    await this.vault.setItem(VAULT_KEY, JSON.stringify(blob));
    this.cache = blob;
  }

  async deleteItem(key: string): Promise<void> {
    await this.ready;
    await this.plain.deleteItem(key);
    if (!this.biometric()) return;
    const blob = { ...(await this.load()) };
    if (!(key in blob)) return;
    delete blob[key];
    await this.vault.setItem(VAULT_KEY, JSON.stringify(blob));
    this.cache = blob;
  }

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

  async disableBiometric(): Promise<boolean> {
    this.cache = null;
    const raw = await this.readVault();
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

export class SecretsUnavailable extends Error {
  constructor() {
    super('Saved credentials are locked or were invalidated (biometrics changed). Re-enter passwords and recreate the device key.');
    this.name = 'SecretsUnavailable';
  }
}

export type Settings = { biometric: boolean; secureScreen: boolean };
const SETTINGS_KEY = 'settings.v1';

export async function loadSettings(kv: KeyValueStore): Promise<Settings> {
  try {
    const v = JSON.parse((await kv.getItem(SETTINGS_KEY)) ?? '{}');
    return { biometric: v.biometric === true, secureScreen: v.secureScreen === true };
  } catch {
    return { biometric: false, secureScreen: false };
  }
}

export const saveSettings = (kv: KeyValueStore, s: Settings) => kv.setItem(SETTINGS_KEY, JSON.stringify(s));
