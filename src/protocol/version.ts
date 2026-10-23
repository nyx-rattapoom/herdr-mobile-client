import { HerdrApiError, type HerdrClient } from './client';

export const MIN_HERDR_VERSION = '0.8.0';

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export type ServerInfo = { version?: string; protocol?: number };

export async function ping(client: HerdrClient): Promise<ServerInfo> {
  const res = await client.request<{ version?: unknown; protocol?: unknown }>('ping');
  return {
    version: typeof res?.version === 'string' ? res.version : undefined,
    protocol: typeof res?.protocol === 'number' ? res.protocol : undefined,
  };
}

export class UnsupportedServerError extends HerdrApiError {
  constructor(readonly version: string) {
    super(
      'unsupported_version',
      `Herdr ${version} on this server is too old; this app needs ${MIN_HERDR_VERSION} or newer. ` +
        'Update it with `herdr update` (or your package manager), then restart the Herdr server.',
    );
  }
}

export function checkVersion(info: ServerInfo): void {
  if (!info.version) return;
  const c = compareVersions(info.version, MIN_HERDR_VERSION);
  if (c !== null && c < 0) throw new UnsupportedServerError(info.version);
}

export function parseUnknownVariant(message: string): { unknown: string; expected: string[] } | null {
  const m = /unknown variant `([^`]*)`, expected (?:one of )?(.*)$/s.exec(message);
  if (!m) return null;
  const expected = [...m[2].matchAll(/`([^`]*)`/g)].map((x) => x[1]);
  return expected.length ? { unknown: m[1], expected } : null;
}
