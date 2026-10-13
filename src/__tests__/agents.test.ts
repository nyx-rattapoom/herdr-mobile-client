import { agentAlerts, agentsFromSnapshot, type AgentMap } from '../live/agents';

const m = (entries: [string, string][]): AgentMap =>
  new Map(entries.map(([id, status]) => [id, { status, agent: 'claude', workspaceId: 'w1' }]));

describe('agentAlerts', () => {
  it('alerts when an agent becomes blocked, once', () => {
    expect(agentAlerts(m([['p1', 'working']]), m([['p1', 'blocked']]))).toEqual([
      { kind: 'blocked', paneId: 'p1', agent: 'claude', workspaceId: 'w1' },
    ]);
    expect(agentAlerts(m([['p1', 'blocked']]), m([['p1', 'blocked']]))).toEqual([]);
    expect(agentAlerts(new Map(), m([['p1', 'blocked']]))).toHaveLength(1);
  });

  it('treats working → idle/done and working → gone as completed', () => {
    expect(agentAlerts(m([['p1', 'working']]), m([['p1', 'idle']]))[0].kind).toBe('completed');
    expect(agentAlerts(m([['p1', 'working']]), m([['p1', 'done']]))[0].kind).toBe('completed');
    expect(agentAlerts(m([['p1', 'working']]), new Map())).toEqual([
      { kind: 'completed', paneId: 'p1', agent: 'claude', workspaceId: 'w1' },
    ]);
  });

  it('does not alert for transitions that skip working', () => {
    expect(agentAlerts(m([['p1', 'unknown']]), m([['p1', 'idle']]))).toEqual([]);
    expect(agentAlerts(m([['p1', 'blocked']]), m([['p1', 'working']]))).toEqual([]);
    expect(agentAlerts(m([['p1', 'idle']]), new Map())).toEqual([]);
    expect(agentAlerts(m([['p1', 'blocked']]), m([['p1', 'idle']]))).toEqual([]);
  });

  it('builds the agent map from a snapshot', () => {
    const a = agentsFromSnapshot({
      workspaces: [],
      tabs: [],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', terminal_title_stripped: 'fake' }],
      agents: [{ pane_id: 'w1:p1', agent: 'fake', agent_status: 'working' }],
    });
    expect(a.get('w1:p1')).toEqual({ status: 'working', agent: 'fake', workspaceId: 'w1', title: 'fake' });
  });
});
