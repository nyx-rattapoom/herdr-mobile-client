import { execFileSync } from 'child_process';

import {
  DISCOVERY_COMMAND,
  discoveryCommand,
  explainInstall,
  explainStart,
  installCommand,
  parseDiscovery,
  parseSessionList,
  SAFE_SERVER_PATH,
  shellQuote,
  startServerCommand,
  validateHerdrPath,
} from '../protocol/sessions';

const list = JSON.stringify({
  sessions: [
    { default: false, name: 'agents', running: false, session_dir: '/home/u/.config/herdr/sessions/agents', socket_path: '/home/u/.config/herdr/sessions/agents/herdr.sock' },
    { default: true, name: 'default', running: true, session_dir: '/home/u/.config/herdr', socket_path: '/home/u/.config/herdr/herdr.sock' },
    { default: false, name: 'bad', running: true, socket_path: 'relative.sock' },
  ],
});

const body = (cmd: string) => cmd.slice("sh -c '".length, -1);

describe('server scripts', () => {
  it('are single sh -c commands without nested single quotes', () => {
    for (const c of [DISCOVERY_COMMAND, discoveryCommand('~/bin/herdr'), installCommand(), startServerCommand('/opt/h/herdr')]) {
      expect(c.startsWith("sh -c '")).toBe(true);
      expect(body(c)).not.toContain("'");
    }
  });

  it('are single-line (csh/tcsh reject newlines inside quotes)', () => {
    for (const c of [discoveryCommand(), installCommand(), startServerCommand('/opt/h/herdr')]) expect(c).not.toContain('\n');
  });

  it('only accepts plain absolute server paths for shell probes', () => {
    expect(SAFE_SERVER_PATH.test('/home/u/.config/herdr/herdr.sock')).toBe(true);
    for (const bad of ["/x'y", '/x y', '/x;id', '/x$(id)', 'rel/x', '/x\ny', '/x`id`']) expect(SAFE_SERVER_PATH.test(bad)).toBe(false);
  });

  it('are valid POSIX shell (sh -n)', () => {
    for (const c of [discoveryCommand(), discoveryCommand('~/bin/herdr'), installCommand(), startServerCommand('/opt/h/herdr')]) {
      expect(() => execFileSync('sh', ['-n', '-c', body(c)], { stdio: 'pipe' })).not.toThrow();
    }
  });

  it('discovery prefers a configured path, then PATH, then the login shell, then ~/.local/bin', () => {
    const c = body(discoveryCommand('~/tools/herdr'));
    const order = ['"$HOME"/tools/herdr', 'command -v herdr 2>/dev/null', '"$SHELL" -lc', '$HOME/.local/bin/herdr'].map((s) => c.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(c).toContain('session list --json');
  });

  it('ignores an invalid configured path rather than embedding it', () => {
    expect(body(discoveryCommand('/x; rm -rf ~'))).not.toContain('rm -rf');
  });

  it('install downloads the official installer before running it', () => {
    const c = body(installCommand());
    expect(c).toContain('https://herdr.dev/install.sh -o "$T"');
    expect(c).toContain('--proto =https --tlsv1.2');
    expect(c.indexOf('exit 92')).toBeLessThan(c.indexOf('sh "$T"'));
  });
});

describe('shellQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote('/home/u/.config/herdr/herdr.sock')).toBe("'/home/u/.config/herdr/herdr.sock'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe('validateHerdrPath', () => {
  it('accepts absolute and home-relative paths only', () => {
    expect(validateHerdrPath('')).toBeNull();
    expect(validateHerdrPath('/usr/local/bin/herdr')).toBeNull();
    expect(validateHerdrPath('~/.local/bin/herdr')).toBeNull();
    for (const bad of ['herdr', '~herdr', '/a b', '/x;id', '/x/../y', '$(id)', '/x"y']) expect(validateHerdrPath(bad)).not.toBeNull();
  });
});

describe('session discovery', () => {
  it('uses the herdr session list when present, default first', () => {
    const r = parseDiscovery(`HERDR\t/home/u/.local/bin/herdr\nHOME\t/home/u\nXDG\t\nLIST\t${list}\n`);
    expect(r.herdrFound).toBe(true);
    expect(r.herdrBin).toBe('/home/u/.local/bin/herdr');
    expect(r.sessions).toEqual([
      { name: 'default', isDefault: true, running: true, socketPath: '/home/u/.config/herdr/herdr.sock' },
      { name: 'agents', isDefault: false, running: false, socketPath: '/home/u/.config/herdr/sessions/agents/herdr.sock' },
    ]);
  });

  it('falls back to $HOME/.config/herdr/herdr.sock when herdr is not found', () => {
    expect(parseDiscovery('HERDR\t\nHOME\t/home/u\nXDG\t\nLIST\t\n')).toEqual({
      herdrBin: null,
      herdrFound: false,
      sessions: [{ name: 'default', isDefault: true, running: true, socketPath: '/home/u/.config/herdr/herdr.sock' }],
    });
  });

  it('honours XDG_CONFIG_HOME in the fallback', () => {
    expect(parseDiscovery('HOME\t/home/u\nXDG\t/data/cfg\nLIST\t\n').sessions[0].socketPath).toBe('/data/cfg/herdr/herdr.sock');
  });

  it('returns nothing usable without an absolute home', () => {
    expect(parseDiscovery('LIST\tnot json\n')).toEqual({ sessions: [], herdrBin: null, herdrFound: false });
  });

  it('rejects malformed session lists', () => {
    expect(parseSessionList('')).toBeNull();
    expect(parseSessionList('{')).toBeNull();
    expect(parseSessionList('{"sessions":{}}')).toBeNull();
  });
});

describe('install/start outcomes', () => {
  it('explains failures', () => {
    expect(explainInstall(0, '', '')).toEqual({ ok: true });
    expect(explainInstall(91, '', '')).toMatchObject({ ok: false, reason: expect.stringMatching(/curl is not installed/) });
    expect(explainInstall(92, '', '')).toMatchObject({ ok: false, reason: expect.stringMatching(/could not download/) });
    expect(explainInstall(1, '  > detected linux/aarch64\n', '  \x1b[31m✗\x1b[0m unsupported architecture: mips\n')).toEqual({
      ok: false,
      reason: 'unsupported architecture: mips',
    });
    expect(explainInstall(2, 'a\nb\nc\nd', '')).toEqual({ ok: false, reason: 'The installer failed (exit 2):\nb\nc\nd' });
    expect(explainStart(94)).toMatchObject({ ok: false });
    expect(explainStart(0)).toEqual({ ok: true });
  });
});
