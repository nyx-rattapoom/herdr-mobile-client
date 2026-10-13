import type { AgentMap } from '../live/agents';
import { resolveSelection, rollup, selectionForPane, tabStatus, workspaceSummary } from '../live/workspace';
import type { WorkspaceNode } from '../protocol/snapshot';

const pane = (id: string, extra: object = {}) => ({
  pane_id: id,
  tab_id: id.split(':').slice(0, 2).join(':'),
  workspace_id: id.split(':')[0],
  ...extra,
});

const tree: WorkspaceNode[] = [
  {
    workspace_id: 'w1',
    label: 'demo',
    tabs: [
      {
        tab_id: 'w1:t1',
        workspace_id: 'w1',
        panes: [pane('w1:t1:p1'), pane('w1:t1:p2', { focused: true, agent: 'opencode' })],
      },
      { tab_id: 'w1:t2', workspace_id: 'w1', focused: true, panes: [pane('w1:t2:p3', { agent: 'claude' })] },
    ],
  },
  { workspace_id: 'w2', focused: true, tabs: [{ tab_id: 'w2:t1', workspace_id: 'w2', panes: [pane('w2:t1:p4')] }] },
];

describe('workspace selection', () => {
  it('falls back to what Herdr has focused, then to the first', () => {
    expect(resolveSelection(tree, {}).ws?.workspace_id).toBe('w2');
    const r = resolveSelection(tree, { workspaceId: 'w1' });
    expect(r.tab?.tab_id).toBe('w1:t2');
    expect(r.pane?.pane_id).toBe('w1:t2:p3');
    expect(resolveSelection(tree, { workspaceId: 'w1', tabId: 'w1:t1' }).pane?.pane_id).toBe('w1:t1:p2');
  });

  it('keeps an explicit choice and recovers when it is closed', () => {
    const r = resolveSelection(tree, { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:t1:p1' });
    expect(r.pane?.pane_id).toBe('w1:t1:p1');
    expect(resolveSelection(tree, { workspaceId: 'gone', tabId: 'gone' }).ws?.workspace_id).toBe('w2');
    expect(resolveSelection([], {})).toEqual({ ws: undefined, tab: undefined, pane: undefined });
  });

  it('finds the selection for a pane anywhere in the tree', () => {
    expect(selectionForPane(tree, 'w1:t2:p3')).toEqual({ workspaceId: 'w1', tabId: 'w1:t2', paneId: 'w1:t2:p3' });
    expect(selectionForPane(tree, 'nope')).toBeNull();
  });
});

describe('status roll-up', () => {
  it('ranks blocked > working > done > idle', () => {
    expect(rollup(['idle', 'done', 'working'])).toBe('working');
    expect(rollup(['idle', 'blocked', 'working'])).toBe('blocked');
    expect(rollup(['unknown', undefined])).toBeUndefined();
    expect(rollup([])).toBeUndefined();
  });

  it('summarises agents per tab and workspace, preferring live statuses', () => {
    const agents: AgentMap = new Map([
      ['w1:t1:p2', { status: 'working', agent: 'opencode' }],
      ['w1:t2:p3', { status: 'blocked', agent: 'claude' }],
    ]);
    expect(tabStatus(tree[0].tabs[0], agents)).toBe('working');
    expect(workspaceSummary(tree[0], agents)).toEqual({ status: 'blocked', agents: 2, tabs: 2 });
    expect(workspaceSummary(tree[1], agents)).toEqual({ status: undefined, agents: 0, tabs: 1 });
  });
});
