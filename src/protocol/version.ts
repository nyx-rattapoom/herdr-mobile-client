import { HerdrApiError, type HerdrClient } from './client';

/**
 * Oldest Herdr release that has every socket method and event this app uses. 0.8.0 added the
 * `workspace.reordered` event; 0.7.x rejects a subscription that names it. Herdr's docs say the
 * `protocol` number in `ping` covers only its internal binary protocol, so this compares the
 * release version instead.
 */
export const MIN_HERDR_VERSION = '0.8.0';

/** `[major, minor, patch]` from a release string such as `0.9.3` or `v0.10.0-rc.1`. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`; null if unparseable. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export type ServerInfo = { version?: string; protocol?: number };

/** Reads the server's release version with `ping`. */
export async function ping(client: HerdrClient): Promise<ServerInfo> {
  const res = await client.request<{ version?: unknown; protocol?: unknown }>('ping');
  return {
    version: typeof res?.version === 'string' ? res.version : undefined,
    protocol: typeof res?.protocol === 'number' ? res.protocol : undefined,
  };
}

/** A server whose Herdr is older than MIN_HERDR_VERSION. */
export class UnsupportedServerError extends HerdrApiError {
  constructor(readonly version: string) {
    super(
      'unsupported_version',
      `Herdr ${version} on this server is too old; this app needs ${MIN_HERDR_VERSION} or newer. ` +
        'Update it with `herdr update` (or your package manager), then restart the Herdr server.',
    );
  }
}

/** Throws UnsupportedServerError when the version is known and older than the minimum. */
export function checkVersion(info: ServerInfo): void {
  if (!info.version) return;
  const c = compareVersions(info.version, MIN_HERDR_VERSION);
  if (c !== null && c < 0) throw new UnsupportedServerError(info.version);
}

/**
 * Parses serde's "unknown variant `x`, expected one of `a`, `b`" rejection into the unknown name
 * and the names the server accepts.
 */
export function parseUnknownVariant(message: string): { unknown: string; expected: string[] } | null {
  const m = /unknown variant `([^`]*)`, expected (?:one of )?(.*)$/s.exec(message);
  if (!m) return null;
  const expected = [...m[2].matchAll(/`([^`]*)`/g)].map((x) => x[1]);
  return expected.length ? { unknown: m[1], expected } : null;
}
