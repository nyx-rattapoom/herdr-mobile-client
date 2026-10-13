import { cleanLabel } from '../live/text';
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

/** Per-kind cap on snapshot records; a real session is far smaller. */
export const MAX_RECORDS = 1000;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** Display text from the server: sanitised and length-limited. */
const label = (v: unknown, max = 80) => cleanLabel(v, max);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/**
 * Keeps at most MAX_RECORDS objects whose id fields are strings, and copies only the known fields
 * with the expected types, so nothing unexpected reaches the UI.
 */
function records<T>(v: unknown, ids: string[], pick: (o: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const o of v) {
    if (out.length >= MAX_RECORDS) break;
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    if (ids.every((k) => typeof r[k] === 'string')) out.push(pick(r));
  }
  return out;
}

const pickWorkspace = (r: Record<string, unknown>): WorkspaceRecord => ({
  workspace_id: r.workspace_id as string,
  number: num(r.number),
  label: label(r.label),
  focused: bool(r.focused),
  agent_status: str(r.agent_status),
});
const pickTab = (r: Record<string, unknown>): TabRecord => ({
  tab_id: r.tab_id as string,
  workspace_id: r.workspace_id as string,
  number: num(r.number),
  label: label(r.label),
  focused: bool(r.focused),
  agent_status: str(r.agent_status),
});
const pickPane = (r: Record<string, unknown>): PaneRecord => ({
  pane_id: r.pane_id as string,
  tab_id: r.tab_id as string,
  workspace_id: r.workspace_id as string,
  focused: bool(r.focused),
  cwd: label(r.cwd, 200),
  agent: label(r.agent, 40),
  agent_status: str(r.agent_status),
  terminal_title_stripped: label(r.terminal_title_stripped, 120),
  label: label(r.label),
});
const pickAgent = (r: Record<string, unknown>): AgentRecord => ({
  pane_id: r.pane_id as string,
  agent: label(r.agent, 40),
  agent_status: str(r.agent_status),
});

export async function fetchSnapshot(client: HerdrClient): Promise<SessionSnapshot> {
  const res = await client.request<{ type?: string; snapshot?: Record<string, unknown> }>('session.snapshot');
  if (!res || typeof res !== 'object' || !res.snapshot) {
    throw new Error('unexpected session.snapshot response');
  }
  const s = res.snapshot;
  return {
    version: typeof s.version === 'string' ? s.version : undefined,
    protocol: typeof s.protocol === 'number' ? s.protocol : undefined,
    workspaces: records(s.workspaces, ['workspace_id'], pickWorkspace),
    tabs: records(s.tabs, ['tab_id', 'workspace_id'], pickTab),
    panes: records(s.panes, ['pane_id', 'tab_id', 'workspace_id'], pickPane),
    agents: records(s.agents, ['pane_id'], pickAgent),
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
