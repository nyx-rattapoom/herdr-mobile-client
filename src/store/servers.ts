import { validateHerdrPath } from '../protocol/sessions';
import { endpointId, pinHost, type KeyValueStore } from '../ssh/pinning';

export type AuthMethod = 'key' | 'password';

export type ServerProfile = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth?: AuthMethod;
  herdrPath?: string;
  jumpId?: string;
};

const INDEX_KEY = 'servers.v1';
export const passwordKey = (id: string) => `pw.${id}`;

export type ServerInput = {
  label?: string;
  host: string;
  port: number;
  username: string;
  auth?: AuthMethod;
  password: string;
  herdrPath?: string;
  jumpId?: string;
};

type PinTarget = { host: string; port: number; jumpId?: string };

export function endpointInUse(list: PinTarget[], target: PinTarget): boolean {
  const id = endpointId(pinHost(target), target.port);
  return list.some((o) => endpointId(pinHost(o), o.port) === id);
}

export const MAX_HOPS = 8;

export function jumpChain(list: ServerProfile[], server: Pick<ServerProfile, 'id' | 'label' | 'jumpId'>): ServerProfile[] {
  const chain: ServerProfile[] = [];
  const seen = new Set<string>([server.id]);
  let next = server.jumpId;
  let from = server.label;
  while (next) {
    const hop = list.find((s) => s.id === next);
    if (!hop) throw new Error(`The jump server for ${from} was removed. Edit ${from} to pick another.`);
    if (seen.has(hop.id)) throw new Error(`The route to ${server.label} loops back through ${hop.label}.`);
    if (chain.length >= MAX_HOPS) throw new Error(`The route to ${server.label} has more than ${MAX_HOPS} hops.`);
    seen.add(hop.id);
    chain.unshift(hop);
    from = hop.label;
    next = hop.jumpId;
  }
  return chain;
}

const routesThrough = (list: ServerProfile[], start: ServerProfile, id: string): boolean => {
  try {
    return start.id === id || jumpChain(list, start).some((h) => h.id === id);
  } catch {
    return true;
  }
};

const hopsTo = (list: ServerProfile[], s: ServerProfile): number => {
  try {
    return jumpChain(list, s).length;
  } catch {
    return MAX_HOPS;
  }
};


export type JumpOption = { id: string; label: string; route: string[] };

export const jumpOptions = (list: ServerProfile[], selfId?: string): JumpOption[] =>
  jumpCandidates(list, selfId).map((s) => ({ id: s.id, label: s.label, route: [...jumpChain(list, s), s].map((h) => h.label) }));

const depthBelow = (list: ServerProfile[], id: string, seen = new Set<string>()): number => {
  if (seen.has(id)) return 0;
  seen.add(id);
  return list.filter((s) => s.jumpId === id).reduce((max, s) => Math.max(max, 1 + depthBelow(list, s.id, seen)), 0);
};

export const jumpCandidates = (list: ServerProfile[], selfId?: string): ServerProfile[] => {
  const below = selfId ? depthBelow(list, selfId) : 0;
  return list.filter((s) => hopsTo(list, s) + 1 + below <= MAX_HOPS && (selfId === undefined || !routesThrough(list, s, selfId)));
};

export function validateJump(list: ServerProfile[], selfId: string | undefined, jumpId: string | undefined): string | null {
  if (!jumpId) return null;
  if (jumpId === selfId) return 'A server cannot hop through itself';
  const jump = list.find((s) => s.id === jumpId);
  if (!jump) return 'The jump server no longer exists';
  let hops: number;
  try {
    hops = jumpChain(list, jump).length + 1;
  } catch (e) {
    return (e as Error).message;
  }
  if (selfId && routesThrough(list, jump, selfId)) return `${jump.label} already hops through this server, so that would loop`;
  if (hops + (selfId ? depthBelow(list, selfId) : 0) > MAX_HOPS) return `A route can have at most ${MAX_HOPS} hops`;
  return null;
}

export const routeLabel = (list: ServerProfile[], server: ServerProfile): string | undefined => {
  if (!server.jumpId) return undefined;
  try {
    return jumpChain(list, server)
      .map((h) => h.label)
      .join(' → ');
  } catch {
    return list.find((s) => s.id === server.jumpId)?.label ?? 'missing server';
  }
};

export const dependentsOf = (list: ServerProfile[], id: string): ServerProfile[] => list.filter((s) => s.jumpId === id);

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
    const err = validateServer(input) ?? validateJump(await this.list(), undefined, input.jumpId);
    if (err) throw new Error(err);
    const profile = this.toProfile(this.newId(), input);
    if (input.password) await this.secrets.setItem(passwordKey(profile.id), input.password);
    await this.kv.setItem(INDEX_KEY, JSON.stringify([...(await this.list()), profile]));
    return profile;
  }

  async update(id: string, input: ServerInput, opts: { clearPassword?: boolean } = {}): Promise<ServerProfile> {
    const all = await this.list();
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) throw new Error('Server not found');
    const hasSavedPassword = !opts.clearPassword && (await this.secrets.getItem(passwordKey(id))) !== null;
    const err = validateServer(input, { hasSavedPassword }) ?? validateJump(all, id, input.jumpId);
    if (err) throw new Error(err);
    const profile = this.toProfile(id, input);
    if (opts.clearPassword) await this.secrets.deleteItem(passwordKey(id));
    if (input.password) await this.secrets.setItem(passwordKey(id), input.password);
    all[i] = profile;
    await this.kv.setItem(INDEX_KEY, JSON.stringify(all));
    return profile;
  }

  async remove(id: string): Promise<void> {
    const using = dependentsOf(await this.list(), id);
    if (using.length) throw new Error(`${using.map((s) => s.label).join(', ')} hop${using.length === 1 ? 's' : ''} through this server`);
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
    const jumpId = input.jumpId || undefined;
    return {
      id,
      label: input.label?.trim() || `${username}@${host}`,
      host,
      port: input.port,
      username,
      auth: authOf(input),
      ...(herdrPath ? { herdrPath } : {}),
      ...(jumpId ? { jumpId } : {}),
    };
  }
}
