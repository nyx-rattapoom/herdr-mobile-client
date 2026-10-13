import { HerdrClient } from '../protocol/client';
import { buildTree, fetchSnapshot } from '../protocol/snapshot';
import { FakeTransport } from '../testing/fakes';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const snapshot = {
  version: '0.9.3',
  protocol: 17,
  focused_workspace_id: 'w2',
  workspaces: [
    { workspace_id: 'w2', number: 2, label: 'api', focused: true, agent_status: 'blocked' },
    { workspace_id: 'w1', number: 1, label: 'web' },
  ],
  tabs: [
    { tab_id: 'w2:t2', workspace_id: 'w2', number: 2, label: 'logs' },
    { tab_id: 'w2:t1', workspace_id: 'w2', number: 1, label: 'claude' },
    { tab_id: 'w1:t1', workspace_id: 'w1', number: 1 },
    { tab_id: 'w9:t1', workspace_id: 'w9', number: 1 },
  ],
  panes: [
    { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2', agent_status: 'unknown', cwd: '/srv/api' },
    { pane_id: 'w2:p2', tab_id: 'w2:t2', workspace_id: 'w2', terminal_title_stripped: 'tail -f' },
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
  ],
  agents: [{ pane_id: 'w2:p1', agent: 'claude', agent_status: 'blocked' }],
  layouts: [],
};

describe('session snapshot', () => {
  it('requests session.snapshot and normalises the payload', async () => {
    const t = new FakeTransport();
    const p = fetchSnapshot(new HerdrClient(t));
    await flush();
    expect(t.requests[0].method).toBe('session.snapshot');
    t.push(JSON.stringify({ id: 'req_1', result: { type: 'session_snapshot', snapshot: { ...snapshot, panes: null } } }) + '\n');
    const s = await p;
    expect(s.version).toBe('0.9.3');
    expect(s.panes).toEqual([]);
    expect(s.workspaces).toHaveLength(2);
  });

  it('rejects a response without a snapshot', async () => {
    const t = new FakeTransport();
    const p = fetchSnapshot(new HerdrClient(t));
    await flush();
    t.push('{"id":"req_1","result":{"type":"pong"}}\n');
    await expect(p).rejects.toThrow('unexpected session.snapshot response');
  });

  it('nests workspaces, tabs and panes in number order and merges agent status', () => {
    const tree = buildTree({ ...snapshot });
    expect(tree.map((w) => w.workspace_id)).toEqual(['w1', 'w2']);
    const api = tree[1];
    expect(api.tabs.map((t) => t.tab_id)).toEqual(['w2:t1', 'w2:t2']);
    expect(api.tabs[0].panes[0]).toMatchObject({ pane_id: 'w2:p1', agent: 'claude', agent_status: 'blocked' });
    expect(api.tabs[1].panes[0].terminal_title_stripped).toBe('tail -f');
    // Tab w9:t1 has no workspace and is dropped.
    expect(tree.flatMap((w) => w.tabs).some((t) => t.tab_id === 'w9:t1')).toBe(false);
  });
});
