import type { SessionSnapshot } from '../protocol/snapshot';

export type AgentState = { status: string; agent?: string; workspaceId?: string; title?: string };
/** pane_id → current agent state, for panes that have an agent. */
export type AgentMap = Map<string, AgentState>;

export type AgentAlert = {
  kind: 'blocked' | 'completed';
  paneId: string;
  agent?: string;
  workspaceId?: string;
};

export function agentsFromSnapshot(s: SessionSnapshot): AgentMap {
  const m: AgentMap = new Map();
  for (const a of s.agents) {
    if (!a.pane_id) continue;
    const pane = s.panes.find((p) => p.pane_id === a.pane_id);
    m.set(a.pane_id, {
      status: a.agent_status ?? 'unknown',
      agent: a.agent,
      workspaceId: pane?.workspace_id,
      title: pane?.terminal_title_stripped,
    });
  }
  return m;
}

const FINISHED = new Set(['idle', 'done']);

/**
 * Alerts for transitions between two agent maps:
 * - blocked: an agent enters `blocked` (it needs the user).
 * - completed: a `working` agent becomes idle/done, or disappears (Herdr drops idle agents
 *   from the agent list).
 * Transitions that skip `working` (e.g. unknown → idle) are not completions.
 */
export function agentAlerts(prev: AgentMap, next: AgentMap): AgentAlert[] {
  const out: AgentAlert[] = [];
  for (const [paneId, n] of next) {
    const p = prev.get(paneId);
    if (n.status === 'blocked' && p?.status !== 'blocked') {
      out.push({ kind: 'blocked', paneId, agent: n.agent ?? p?.agent, workspaceId: n.workspaceId ?? p?.workspaceId });
    } else if (p?.status === 'working' && FINISHED.has(n.status)) {
      out.push({ kind: 'completed', paneId, agent: n.agent ?? p.agent, workspaceId: n.workspaceId ?? p.workspaceId });
    }
  }
  for (const [paneId, p] of prev) {
    if (!next.has(paneId) && p.status === 'working') {
      out.push({ kind: 'completed', paneId, agent: p.agent, workspaceId: p.workspaceId });
    }
  }
  return out;
}
