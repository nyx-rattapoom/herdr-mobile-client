/** A Herdr named session on the server and the absolute path of its API socket. */
export type HerdrSession = {
  name: string;
  isDefault: boolean;
  running: boolean;
  socketPath: string;
};

/**
 * Read-only discovery script run over an SSH exec channel. It prints the environment the
 * socket path depends on and, when the already-installed `herdr` is reachable, its session
 * list. Wrapped in `sh -c` so it works whatever the login shell is (fish, etc.).
 * Must not contain single quotes.
 */
const DISCOVERY_SCRIPT = [
  'PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
  'printf "HOME\\t%s\\n" "$HOME"',
  'printf "XDG\\t%s\\n" "${XDG_CONFIG_HOME:-}"',
  'printf "LIST\\t"',
  'herdr session list --json 2>/dev/null || echo',
].join('; ');

export const DISCOVERY_COMMAND = `sh -c '${DISCOVERY_SCRIPT}'`;

export type DiscoveryResult = { sessions: HerdrSession[]; herdrFound: boolean };

/** Parses DISCOVERY_COMMAND output. Falls back to the default socket path when herdr is not on PATH. */
export function parseDiscovery(stdout: string): DiscoveryResult {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) fields.set(line.slice(0, tab), line.slice(tab + 1).trim());
  }

  const listed = parseSessionList(fields.get('LIST') ?? '');
  if (listed) return { sessions: listed, herdrFound: true };

  const home = fields.get('HOME') ?? '';
  const xdg = fields.get('XDG') ?? '';
  const configDir = xdg.startsWith('/') ? `${xdg}/herdr` : home.startsWith('/') ? `${home}/.config/herdr` : null;
  if (!configDir) return { sessions: [], herdrFound: false };
  return {
    sessions: [{ name: 'default', isDefault: true, running: true, socketPath: `${configDir}/herdr.sock` }],
    herdrFound: false,
  };
}

export function parseSessionList(json: string): HerdrSession[] | null {
  if (!json.trim()) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  const raw = (doc as { sessions?: unknown })?.sessions;
  if (!Array.isArray(raw)) return null;
  const out: HerdrSession[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const { name, default: isDefault, running, socket_path } = s as Record<string, unknown>;
    if (typeof name !== 'string' || typeof socket_path !== 'string' || !socket_path.startsWith('/')) continue;
    out.push({ name, isDefault: isDefault === true, running: running === true, socketPath: socket_path });
  }
  // Default first, then running, then by name.
  out.sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name),
  );
  return out;
}
