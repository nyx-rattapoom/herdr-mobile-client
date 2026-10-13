import { DISCOVERY_COMMAND, parseDiscovery, parseSessionList } from '../protocol/sessions';

const list = JSON.stringify({
  sessions: [
    { default: false, name: 'agents', running: false, session_dir: '/home/u/.config/herdr/sessions/agents', socket_path: '/home/u/.config/herdr/sessions/agents/herdr.sock' },
    { default: true, name: 'default', running: true, session_dir: '/home/u/.config/herdr', socket_path: '/home/u/.config/herdr/herdr.sock' },
    { default: false, name: 'bad', running: true, socket_path: 'relative.sock' },
  ],
});

describe('session discovery', () => {
  it('is a single sh -c command without nested single quotes', () => {
    expect(DISCOVERY_COMMAND.startsWith("sh -c '")).toBe(true);
    expect(DISCOVERY_COMMAND.slice(7, -1)).not.toContain("'");
    expect(DISCOVERY_COMMAND).toContain('herdr session list --json');
  });

  it('uses the herdr session list when present, default first', () => {
    const r = parseDiscovery(`HOME\t/home/u\nXDG\t\nLIST\t${list}\n`);
    expect(r.herdrFound).toBe(true);
    expect(r.sessions).toEqual([
      { name: 'default', isDefault: true, running: true, socketPath: '/home/u/.config/herdr/herdr.sock' },
      { name: 'agents', isDefault: false, running: false, socketPath: '/home/u/.config/herdr/sessions/agents/herdr.sock' },
    ]);
  });

  it('falls back to $HOME/.config/herdr/herdr.sock when herdr is not on PATH', () => {
    expect(parseDiscovery('HOME\t/home/u\nXDG\t\nLIST\t\n')).toEqual({
      herdrFound: false,
      sessions: [{ name: 'default', isDefault: true, running: true, socketPath: '/home/u/.config/herdr/herdr.sock' }],
    });
  });

  it('honours XDG_CONFIG_HOME in the fallback', () => {
    expect(parseDiscovery('HOME\t/home/u\nXDG\t/data/cfg\nLIST\t\n').sessions[0].socketPath).toBe('/data/cfg/herdr/herdr.sock');
  });

  it('returns nothing usable without an absolute home', () => {
    expect(parseDiscovery('LIST\tnot json\n')).toEqual({ sessions: [], herdrFound: false });
  });

  it('rejects malformed session lists', () => {
    expect(parseSessionList('')).toBeNull();
    expect(parseSessionList('{')).toBeNull();
    expect(parseSessionList('{"sessions":{}}')).toBeNull();
  });
});
