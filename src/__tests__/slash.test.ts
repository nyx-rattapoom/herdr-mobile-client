import { readFileSync } from 'fs';
import { join } from 'path';

import { SlashMenu, hasLoneSlash, mergeCommands, parseSlashMenu } from '../live/slash';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');

describe('parseSlashMenu', () => {
  it("reads opencode's boxed menu and ignores paths and the status line", () => {
    const cmds = parseSlashMenu(fixture('opencode-slash-1.txt'));
    expect(cmds.map((c) => c.name)).toEqual([
      '/agents',
      '/compact',
      '/connect',
      '/copy',
      '/debug',
      '/diff',
      '/editor',
      '/exit',
      '/export',
      '/fork',
    ]);
    expect(cmds[1]).toEqual({ name: '/compact', description: 'Compact session' });
  });

  it('merges a scrolled page into what was already seen', () => {
    const first = parseSlashMenu(fixture('opencode-slash-1.txt'));
    const second = parseSlashMenu(fixture('opencode-slash-2.txt'));
    const all = mergeCommands(first, second);
    expect(all).toHaveLength(11);
    expect(all[10]).toEqual({ name: '/help', description: 'Help' });
  });

  it('handles other menu shapes: markers, dashes, plain columns, name-only lists', () => {
    const synthetic = [
      '> /',
      '❯ /review     Review the current changes',
      '  /clear      Start over',
      '  /model - Pick a model',
      '  /project:deploy: Run the deploy script',
      '',
      '  see /docs/setup.md for details',
    ].join('\n');
    expect(parseSlashMenu(synthetic)).toEqual([
      { name: '/review', description: 'Review the current changes' },
      { name: '/clear', description: 'Start over' },
      { name: '/model', description: 'Pick a model' },
      { name: '/project:deploy', description: 'Run the deploy script' },
    ]);
    expect(parseSlashMenu('│ /help │\n│ /quit │').map((c) => c.name)).toEqual(['/help', '/quit']);
    expect(parseSlashMenu('/tmp\nsomething')).toEqual([]);
    expect(parseSlashMenu('   /home/herdr/demo       8.2K (4%)  ctrl+p commands')).toEqual([]);
  });

  it('spots a prompt line that still holds only the slash', () => {
    expect(hasLoneSlash('  ┃\n  ┃  /\n  ┃')).toBe(true);
    expect(hasLoneSlash(fixture('opencode-slash-1.txt'))).toBe(true);
    expect(hasLoneSlash('  ┃\n  ┃  Build')).toBe(false);
  });
});

describe('SlashMenu', () => {
  const setup = (screens: string[]) => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let i = 0;
    const query = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'pane.read') return { read: { text: screens[Math.min(i++, screens.length - 1)] } } as T;
      return {} as T;
    };
    const menu = new SlashMenu(query, 'w1:p1', async () => {}, 1000, 250);
    return { calls, menu };
  };

  it('types /, polls until the menu shows and completes a command', async () => {
    const { calls, menu } = setup(['$ ', 'prompt only', 'still drawing', fixture('opencode-slash-1.txt')]);
    expect((await menu.open()).length).toBe(10);
    expect(calls[0].params).toMatchObject({ source: 'visible', format: 'text' });
    expect(calls[1]).toEqual({ method: 'pane.send_text', params: { pane_id: 'w1:p1', text: '/' } });
    expect(calls.filter((c) => c.method === 'pane.read')).toHaveLength(4);
    await menu.choose('/help');
    expect(calls.slice(-2)).toEqual([
      { method: 'pane.send_text', params: { pane_id: 'w1:p1', text: 'help' } },
      { method: 'pane.send_keys', params: { pane_id: 'w1:p1', keys: ['enter'] } },
    ]);
    expect(menu.isOpen).toBe(false);
  });

  it('loads more by moving to the last seen command, then stepping until it wraps', async () => {
    const all = Array.from({ length: 14 }, (_, i) => `/cmd${i}`);
    let cursor = 0;
    const screen = () => {
      const c = ((cursor % all.length) + all.length) % all.length;
      const top = Math.max(0, Math.min(c - 9, all.length - 10));
      return (
        all
          .slice(top, top + 10)
          .map((n) => `  ┃ ${n}   does ${n}  ┃`)
          .join('\n') + '\n  ┃  /'
      );
    };
    const keys: string[] = [];
    const query = async <T>(method: string, params: Record<string, unknown>) => {
      if (method === 'pane.send_keys') {
        const ks = params.keys as string[];
        keys.push(`${ks[0]}×${ks.length}`);
        cursor += ks[0] === 'up' ? -ks.length : ks.length;
      }
      return (method === 'pane.read' ? { read: { text: screen() } } : {}) as T;
    };
    const menu = new SlashMenu(query, 'w1:p1', async () => {}, 0, 1);
    expect((await menu.open()).length).toBe(10);
    expect((await menu.more(2, 2)).map((c) => c.name)).toEqual(all.slice(0, 12));
    expect(keys).toEqual(['down×9', 'down×2']);
    expect(menu.complete).toBe(false);
  });

  it('walks back over the end when a step wraps past the last commands', async () => {
    const all = Array.from({ length: 14 }, (_, i) => `/cmd${i}`);
    let cursor = 0;
    const screen = () => {
      const c = ((cursor % all.length) + all.length) % all.length;
      const top = Math.max(0, Math.min(c - 9, all.length - 10));
      return all
        .slice(top, top + 10)
        .map((n) => `  ${n}   does ${n}`)
        .join('\n');
    };
    const keys: string[] = [];
    const query = async <T>(method: string, params: Record<string, unknown>) => {
      if (method === 'pane.send_keys') {
        const ks = params.keys as string[];
        keys.push(`${ks[0]}×${ks.length}`);
        cursor += ks[0] === 'up' ? -ks.length : ks.length;
      }
      return (method === 'pane.read' ? { read: { text: screen() } } : {}) as T;
    };
    const menu = new SlashMenu(query, 'w1:p1', async () => {}, 0, 1);
    await menu.open();
    expect((await menu.more(10, 5)).map((c) => c.name)).toEqual(all);
    expect(menu.complete).toBe(true);
    expect(keys).toEqual(['down×9', 'down×5', 'up×5', 'down×1', 'down×1', 'down×1', 'down×1', 'down×1']);
    expect((await menu.more()).length).toBe(14);
    expect(keys).toHaveLength(8);
  });

  it('waits for a slow redraw instead of taking a stale screen as the end of the list', async () => {
    const all = Array.from({ length: 20 }, (_, i) => `/c${i}`);
    let cursor = 0;
    let shown = 0;
    let stale = false;
    const page = (c: number) => {
      const top = Math.max(0, Math.min(c - 9, all.length - 10));
      return all
        .slice(top, top + 10)
        .map((n) => `  ${n}   about ${n}`)
        .join('\n');
    };
    const query = async <T>(method: string, params: Record<string, unknown>) => {
      if (method === 'pane.send_keys') {
        cursor = (cursor + (params.keys as string[]).length) % all.length;
        stale = true;
      }
      if (method !== 'pane.read') return {} as T;
      if (!stale) shown = cursor;
      stale = false;
      return { read: { text: page(shown) } } as T;
    };
    const menu = new SlashMenu(query, 'p', async () => {}, 0, 1);
    await menu.open();
    expect((await menu.more(10, 5)).length).toBe(20);
    expect(menu.complete).toBe(false);
  });

  it("doesn't type a second / over one left in the input", async () => {
    const { calls, menu } = setup([fixture('opencode-slash-1.txt')]);
    expect((await menu.open()).length).toBe(10);
    expect(calls.some((c) => c.method === 'pane.send_text')).toBe(false);
  });

  it('gives up with no commands after the timeout', async () => {
    const { menu } = setup(['$ ']);
    expect(await menu.open()).toEqual([]);
  });

  it('closes with Esc and removes a leftover slash', async () => {
    const left = setup([fixture('opencode-slash-1.txt'), '  ┃  /']);
    await left.menu.open();
    await left.menu.cancel();
    expect(left.calls.filter((c) => c.method === 'pane.send_keys').map((c) => c.params.keys)).toEqual([
      ['esc'],
      ['backspace'],
    ]);

    const cleared = setup([fixture('opencode-slash-1.txt'), '  ┃']);
    await cleared.menu.open();
    await cleared.menu.cancel();
    expect(cleared.calls.filter((c) => c.method === 'pane.send_keys').map((c) => c.params.keys)).toEqual([['esc']]);
    await cleared.menu.cancel();
    expect(cleared.calls.filter((c) => c.method === 'pane.send_keys')).toHaveLength(1);
  });
});
