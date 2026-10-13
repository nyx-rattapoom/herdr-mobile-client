import type { HerdrClient } from './client';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export type PaneRecord = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused?: boolean;
  cwd?: string;
  agent?: string;
  agent_status?: AgentStatus | string;
  terminal_title_stripped?: string;
  label?: string;
};

export type TabRecord = {
  tab_id: string;
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
  agent_status?: AgentStatus | string;
};

export type WorkspaceRecord = {
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
  agent_status?: AgentStatus | string;
};

export type AgentRecord = { pane_id: string; agent?: string; agent_status?: AgentStatus | string };

export type SessionSnapshot = {
  version?: string;
  protocol?: number;
  workspaces: WorkspaceRecord[];
  tabs: TabRecord[];
  panes: PaneRecord[];
  agents: AgentRecord[];
};

export type PaneNode = PaneRecord & { agent?: string };
export type TabNode = TabRecord & { panes: PaneNode[] };
export type WorkspaceNode = WorkspaceRecord & { tabs: TabNode[] };

function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function fetchSnapshot(client: HerdrClient): Promise<SessionSnapshot> {
  const res = await client.request<{ type?: string; snapshot?: Record<string, unknown> }>('session.snapshot');
  if (!res || typeof res !== 'object' || !res.snapshot) {
    throw new Error('unexpected session.snapshot response');
  }
  const s = res.snapshot;
  return {
    version: typeof s.version === 'string' ? s.version : undefined,
    protocol: typeof s.protocol === 'number' ? s.protocol : undefined,
    workspaces: list(s.workspaces),
    tabs: list(s.tabs),
    panes: list(s.panes),
    agents: list(s.agents),
  };
}

const byNumber = (a: { number?: number }, b: { number?: number }) =>
  (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);

/** Nests workspaces → tabs → panes. Records whose parent is missing are dropped. */
export function buildTree(s: SessionSnapshot): WorkspaceNode[] {
  const agentByPane = new Map(s.agents.map((a) => [a.pane_id, a]));
  const panesByTab = new Map<string, PaneNode[]>();
  for (const p of s.panes) {
    const agent = agentByPane.get(p.pane_id);
    const node: PaneNode = { ...p, agent: p.agent ?? agent?.agent, agent_status: agent?.agent_status ?? p.agent_status };
    const arr = panesByTab.get(p.tab_id) ?? [];
    arr.push(node);
    panesByTab.set(p.tab_id, arr);
  }
  const tabsByWs = new Map<string, TabNode[]>();
  for (const t of [...s.tabs].sort(byNumber)) {
    const arr = tabsByWs.get(t.workspace_id) ?? [];
    arr.push({ ...t, panes: panesByTab.get(t.tab_id) ?? [] });
    tabsByWs.set(t.workspace_id, arr);
  }
  return [...s.workspaces].sort(byNumber).map((w) => ({ ...w, tabs: tabsByWs.get(w.workspace_id) ?? [] }));
}
