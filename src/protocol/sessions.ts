export type HerdrSession = {
  name: string;
  isDefault: boolean;
  running: boolean;
  socketPath: string;
};

export function validateHerdrPath(p: string): string | null {
  const v = p.trim();
  if (!v) return null;
  if (!/^(~\/|\/)[A-Za-z0-9_./+-]*$/.test(v) || v.includes('..')) {
    return 'Use an absolute path (or ~/…) with letters, digits and _ . / + - only';
  }
  return null;
}

function herdrPathExpr(p: string): string {
  return p.startsWith('~/') ? `"$HOME"/${p.slice(2)}` : p;
}

export function findHerdrScript(herdrPath?: string): string {
  const configured = herdrPath && !validateHerdrPath(herdrPath) ? herdrPathExpr(herdrPath.trim()) : '';
  return [
    'H=""',
    configured ? `[ -x ${configured} ] && H=${configured}` : ':',
    '[ -z "$H" ] && H="$(command -v herdr 2>/dev/null || true)"',
    '[ -z "$H" ] && [ -n "${SHELL:-}" ] && H="$("$SHELL" -lc "command -v herdr" </dev/null 2>/dev/null | tail -n 1 | grep "^/" || true)"',
    '[ -z "$H" ] && [ -x "$HOME/.local/bin/herdr" ] && H="$HOME/.local/bin/herdr"',
  ].join('; ');
}

const wrap = (script: string) => {
  if (/['\n]/.test(script)) throw new Error('script must not contain single quotes or newlines');
  return `sh -c '${script}'`;
};

export const SAFE_SERVER_PATH = /^\/[A-Za-z0-9_./+-]+$/;

export function discoveryCommand(herdrPath?: string): string {
  return wrap(
    [
      findHerdrScript(herdrPath),
      'printf "HERDR\\t%s\\n" "$H"',
      'printf "HOME\\t%s\\n" "$HOME"',
      'printf "XDG\\t%s\\n" "${XDG_CONFIG_HOME:-}"',
      'printf "LIST\\t"',
      '{ [ -n "$H" ] && "$H" session list --json 2>/dev/null; } || echo',
    ].join('; '),
  );
}

export function versionCommand(herdrPath?: string): string {
  return wrap([findHerdrScript(herdrPath), '[ -n "$H" ] && "$H" --version 2>/dev/null | head -n 1', 'true'].join('; '));
}

export const DISCOVERY_COMMAND = discoveryCommand();

export type DiscoveryResult = {
  sessions: HerdrSession[];
  herdrBin: string | null;
  herdrFound: boolean;
};

export function parseDiscovery(stdout: string): DiscoveryResult {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) fields.set(line.slice(0, tab), line.slice(tab + 1).trim());
  }
  const bin = fields.get('HERDR') ?? '';
  const herdrBin = bin.startsWith('/') ? bin : null;

  const listed = parseSessionList(fields.get('LIST') ?? '');
  if (listed) return { sessions: listed, herdrBin, herdrFound: true };

  const home = fields.get('HOME') ?? '';
  const xdg = fields.get('XDG') ?? '';
  const configDir = xdg.startsWith('/') ? `${xdg}/herdr` : home.startsWith('/') ? `${home}/.config/herdr` : null;
  if (!configDir) return { sessions: [], herdrBin, herdrFound: false };
  return {
    sessions: [{ name: 'default', isDefault: true, running: true, socketPath: `${configDir}/herdr.sock` }],
    herdrBin,
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
  out.sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name),
  );
  return out;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const INSTALLER_URL = 'https://herdr.dev/install.sh';

export const INSTALL_EXIT = { noCurl: 91, download: 92 } as const;

export function installCommand(): string {
  return wrap(
    [
      'command -v curl >/dev/null 2>&1 || exit 91',
      'T="$(mktemp)"',
      `curl -fsSL --proto =https --tlsv1.2 --retry 2 --connect-timeout 10 --max-time 60 ${INSTALLER_URL} -o "$T" || { rm -f "$T"; exit 92; }`,
      'sh "$T"; R=$?; rm -f "$T"; exit $R',
    ].join('; '),
  );
}

export function startServerCommand(herdrPath?: string): string {
  return wrap(
    [
      findHerdrScript(herdrPath),
      '[ -n "$H" ] || exit 93',
      'S="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/herdr.sock"',
      '[ -S "$S" ] && exit 0',
      'cd "$HOME"',
      '{ nohup "$H" server </dev/null >/dev/null 2>&1 & }',
      'i=0; while [ $i -lt 20 ]; do [ -S "$S" ] && exit 0; sleep 0.5; i=$((i+1)); done',
      'exit 94',
    ].join('; '),
  );
}

export type InstallOutcome = { ok: true } | { ok: false; reason: string };

export function explainInstall(exitCode: number, stdout: string, stderr: string): InstallOutcome {
  if (exitCode === 0) return { ok: true };
  if (exitCode === INSTALL_EXIT.noCurl) {
    return { ok: false, reason: 'curl is not installed on the server. Install curl, or install Herdr manually: https://herdr.dev/docs/install/' };
  }
  if (exitCode === INSTALL_EXIT.download) {
    return { ok: false, reason: `The server could not download the installer from ${INSTALLER_URL}. Check its internet access, proxy or firewall.` };
  }
  const text = `${stderr}\n${stdout}`.replace(/\x1b\[[0-9;]*m/g, '');
  const reasons = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('✗'))
    .map((l) => l.replace(/^✗\s*/, ''));
  if (reasons.length) return { ok: false, reason: reasons.join('\n') };
  const tail = text.trim().split('\n').slice(-3).join('\n');
  return { ok: false, reason: `The installer failed (exit ${exitCode})${tail ? `:\n${tail}` : '.'}` };
}

export function explainStart(exitCode: number): InstallOutcome {
  if (exitCode === 0) return { ok: true };
  if (exitCode === 93) return { ok: false, reason: 'herdr was not found on the server.' };
  if (exitCode === 94) return { ok: false, reason: 'herdr server did not create its socket within 10 seconds.' };
  return { ok: false, reason: `Starting herdr failed (exit ${exitCode}).` };
}
