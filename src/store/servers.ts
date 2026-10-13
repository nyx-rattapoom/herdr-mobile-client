import type { KeyValueStore } from '../ssh/pinning';

export type ServerProfile = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
};

const INDEX_KEY = 'servers.v1';
const passwordKey = (id: string) => `pw.${id}`;

export type ServerInput = { label?: string; host: string; port: number; username: string; password: string };

export function validateServer(input: ServerInput): string | null {
  const host = input.host.trim();
  if (!host) return 'Host is required';
  if (/[\s/@]/.test(host)) return 'Host must be a hostname or IP address';
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return 'Port must be 1–65535';
  if (!input.username.trim()) return 'User is required';
  if (!input.password) return 'Password is required';
  return null;
}

/** Server profiles plus their passwords, both kept in the secure key/value store. */
export class ServerStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly newId: () => string = () => Math.random().toString(36).slice(2, 10),
  ) {}

  async list(): Promise<ServerProfile[]> {
    const raw = await this.kv.getItem(INDEX_KEY);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as ServerProfile[]) : [];
    } catch {
      return [];
    }
  }

  async add(input: ServerInput): Promise<ServerProfile> {
    const err = validateServer(input);
    if (err) throw new Error(err);
    const host = input.host.trim();
    const username = input.username.trim();
    const profile: ServerProfile = {
      id: this.newId(),
      label: input.label?.trim() || `${username}@${host}`,
      host,
      port: input.port,
      username,
    };
    await this.kv.setItem(passwordKey(profile.id), input.password);
    await this.kv.setItem(INDEX_KEY, JSON.stringify([...(await this.list()), profile]));
    return profile;
  }

  async remove(id: string): Promise<void> {
    await this.kv.setItem(INDEX_KEY, JSON.stringify((await this.list()).filter((s) => s.id !== id)));
    await this.kv.deleteItem(passwordKey(id));
  }

  password(id: string): Promise<string | null> {
    return this.kv.getItem(passwordKey(id));
  }
}
