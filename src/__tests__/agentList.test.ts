import { agentRows, isUnseen } from '../live/agentList';
import type { AgentMap } from '../live/agents';
import type { WorkspaceNode } from '../protocol/snapshot';
import { MAX_VIEWED, ViewedStore, safeKeyPart } from '../store/viewed';
import { MemoryKv } from '../testing/fakes';

const pane = (id: string, ws: string, tab: string, agent?: string) => ({
  pane_id: id,
  tab_id: tab,
  workspace_id: ws,
  agent,
});
const tree: WorkspaceNode[] = [
  {
    workspace_id: 'w1',
    label: 'demo',
    tabs: [
      {
        tab_id: 'w1:t1',
        workspace_id: 'w1',
        label: 'build',
        panes: [
          pane('p1', 'w1', 'w1:t1', 'opencode'),
          pane('shell', 'w1', 'w1:t1'),
          pane('p2', 'w1', 'w1:t1', 'claude'),
        ],
      },
    ],
  },
  {
    workspace_id: 'w2',
    label: 'docs',
    tabs: [
      {
        tab_id: 'w2:t1',
        workspace_id: 'w2',
        number: 1,
        panes: [pane('p3', 'w2', 'w2:t1', 'codex'), pane('p4', 'w2', 'w2:t1', 'pi')],
      },
    ],
  },
];

describe('agents sheet rows', () => {
  const agents: AgentMap = new Map([
    ['p1', { status: 'done', agent: 'opencode' }],
    ['p2', { status: 'working', agent: 'claude' }],
    ['p3', { status: 'blocked', agent: 'codex' }],
    ['p4', { status: 'done', agent: 'pi' }],
  ]);

  it('lists agents only, grouped blocked → working → done (unseen first) → idle', () => {
    const since = new Map([
      ['p1', 1000],
      ['p4', 3000],
    ]);
    const rows = agentRows(tree, agents, since, { p1: 2000, p4: 2000 });
    expect(rows.map((r) => [r.paneId, r.group, r.unseen])).toEqual([
      ['p3', 'blocked', false],
      ['p2', 'working', false],
      ['p4', 'done', true],
      ['p1', 'done', false],
    ]);
    expect(rows[0]).toMatchObject({ agent: 'codex', workspace: 'docs', tab: 'Tab 1' });
    expect(rows[3]).toMatchObject({ workspace: 'demo', tab: 'build' });
  });

  it('puts unknown statuses with idle', () => {
    const rows = agentRows(tree, new Map([['p1', { status: 'unknown', agent: 'opencode' }]]), new Map(), {});
    expect(rows.find((r) => r.paneId === 'p1')?.group).toBe('idle');
  });

  it('treats done-at-connect as unseen only for never-opened panes', () => {
    expect(isUnseen('done', 0, undefined)).toBe(true);
    expect(isUnseen('done', 0, 5)).toBe(false);
    expect(isUnseen('done', 10, 5)).toBe(true);
    expect(isUnseen('working', 10, undefined)).toBe(false);
  });
});

describe('ViewedStore', () => {
  it('persists last-viewed times per server and session with store-safe keys', async () => {
    const kv = new MemoryKv();
    const a = new ViewedStore(kv);
    await a.mark('srv1', 'my session/1', 'w1:p1', 100);
    const b = new ViewedStore(kv);
    expect(await b.load('srv1', 'my session/1')).toEqual({ 'w1:p1': 100 });
    expect(await b.load('srv1', 'other')).toEqual({});
    expect(safeKeyPart('a b/c')).toBe('a_20_b_2f_c');
  });

  it('keeps only the most recent entries', async () => {
    const s = new ViewedStore(new MemoryKv());
    for (let i = 0; i < MAX_VIEWED + 5; i++) await s.mark('s', 'x', `p${i}`, i);
    const v = await s.load('s', 'x');
    expect(Object.keys(v)).toHaveLength(MAX_VIEWED);
    expect(v.p0).toBeUndefined();
    expect(v[`p${MAX_VIEWED + 4}`]).toBe(MAX_VIEWED + 4);
  });
});
