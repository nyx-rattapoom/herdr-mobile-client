import { validateHerdrPath } from '../protocol/sessions';
import { endpointId, type KeyValueStore } from '../ssh/pinning';

export type AuthMethod = 'key' | 'password';

export type ServerProfile = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  /** `key`: the device key, with the saved password (if any) as fallback. Older profiles: password. */
  auth?: AuthMethod;
  /** Optional absolute path of herdr on the server when it is not discoverable. */
  herdrPath?: string;
};

const INDEX_KEY = 'servers.v1';
export const passwordKey = (id: string) => `pw.${id}`;

export type ServerInput = {
  label?: string;
  host: string;
  port: number;
  username: string;
  auth?: AuthMethod;
  /** Empty when editing means "keep the saved password". */
  password: string;
  herdrPath?: string;
};

/** Whether any profile still connects to host:port (host-key pins are per endpoint, not per profile). */
export function endpointInUse(list: Pick<ServerProfile, 'host' | 'port'>[], host: string, port: number): boolean {
  return list.some((o) => endpointId(o.host, o.port) === endpointId(host, port));
}

export const authOf = (s: Pick<ServerProfile, 'auth'>): AuthMethod => s.auth ?? 'password';

export function validateServer(input: ServerInput, opts: { hasSavedPassword?: boolean } = {}): string | null {
  const host = input.host.trim();
  if (!host) return 'Host is required';
  if (/[\s/@]/.test(host)) return 'Host must be a hostname or IP address';
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return 'Port must be 1–65535';
  if (!input.username.trim()) return 'User is required';
  if (authOf(input) === 'password' && !input.password && !opts.hasSavedPassword) return 'Password is required';
  const herdrErr = validateHerdrPath(input.herdrPath ?? '');
  if (herdrErr) return `Herdr path: ${herdrErr}`;
  return null;
}

/** Server profiles in plain secure storage; their passwords in the secrets store. */
export class ServerStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly newId: () => string = () => Math.random().toString(36).slice(2, 10),
    private readonly secrets: KeyValueStore = kv,
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
    const profile = this.toProfile(this.newId(), input);
    if (input.password) await this.secrets.setItem(passwordKey(profile.id), input.password);
    await this.kv.setItem(INDEX_KEY, JSON.stringify([...(await this.list()), profile]));
    return profile;
  }

  /** Updates a profile. An empty password keeps the saved one; `clearPassword` removes it. */
  async update(id: string, input: ServerInput, opts: { clearPassword?: boolean } = {}): Promise<ServerProfile> {
    const all = await this.list();
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) throw new Error('Server not found');
    const hasSavedPassword = !opts.clearPassword && (await this.secrets.getItem(passwordKey(id))) !== null;
    const err = validateServer(input, { hasSavedPassword });
    if (err) throw new Error(err);
    const profile = this.toProfile(id, input);
    if (opts.clearPassword) await this.secrets.deleteItem(passwordKey(id));
    if (input.password) await this.secrets.setItem(passwordKey(id), input.password);
    all[i] = profile;
    await this.kv.setItem(INDEX_KEY, JSON.stringify(all));
    return profile;
  }

  async remove(id: string): Promise<void> {
    await this.kv.setItem(INDEX_KEY, JSON.stringify((await this.list()).filter((s) => s.id !== id)));
    await this.secrets.deleteItem(passwordKey(id));
  }

  password(id: string): Promise<string | null> {
    return this.secrets.getItem(passwordKey(id));
  }

  private toProfile(id: string, input: ServerInput): ServerProfile {
    const host = input.host.trim();
    const username = input.username.trim();
    const herdrPath = input.herdrPath?.trim() || undefined;
    return {
      id,
      label: input.label?.trim() || `${username}@${host}`,
      host,
      port: input.port,
      username,
      auth: authOf(input),
      ...(herdrPath ? { herdrPath } : {}),
    };
  }
}
