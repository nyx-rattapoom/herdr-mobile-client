import type { KeyValueStore } from '../ssh/pinning';

export const DEVICE_KEY_SECRET = 'devicekey.prv';
const PUBLIC_KEY = 'devicekey.pub';

export type Generated = { privateKey: string; publicKey: string };

export class DeviceKeyStore {
  constructor(
    private readonly plain: KeyValueStore,
    private readonly secrets: KeyValueStore,
    private readonly generate: (comment: string) => Promise<Generated>,
  ) {}

  publicKey(): Promise<string | null> {
    return this.plain.getItem(PUBLIC_KEY);
  }

  privateKey(): Promise<string | null> {
    return this.secrets.getItem(DEVICE_KEY_SECRET);
  }

  async ensure(comment: string): Promise<string> {
    const existing = await this.publicKey();
    if (existing) return existing;
    return this.create(comment);
  }

  async regenerate(comment: string): Promise<string> {
    await this.secrets.deleteItem(DEVICE_KEY_SECRET);
    await this.plain.deleteItem(PUBLIC_KEY);
    return this.create(comment);
  }

  private async create(comment: string): Promise<string> {
    const k = await this.generate(comment);
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( |$)/.test(k.publicKey)) throw new Error('unexpected public key format');
    await this.secrets.setItem(DEVICE_KEY_SECRET, k.privateKey);
    await this.plain.setItem(PUBLIC_KEY, k.publicKey);
    return k.publicKey;
  }
}

export function shortKey(pub: string): string {
  const [type, b64 = '', comment = ''] = pub.split(' ');
  return `${type} …${b64.slice(-12)} ${comment}`.trim();
}
