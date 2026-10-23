import type { PaneNode, TabNode, WorkspaceNode } from '../protocol/snapshot';
import type { AgentMap } from './agents';

export type Selection = { workspaceId?: string; tabId?: string; paneId?: string };

export type Resolved = { ws?: WorkspaceNode; tab?: TabNode; pane?: PaneNode };

const pick = <T extends { focused?: boolean }>(items: T[], match: (x: T) => boolean): T | undefined =>
  items.find(match) ?? items.find((x) => x.focused) ?? items[0];

export function resolveSelection(tree: WorkspaceNode[], sel: Selection): Resolved {
  const ws = pick(tree, (w) => w.workspace_id === sel.workspaceId);
  const tab = ws ? pick(ws.tabs, (t) => t.tab_id === sel.tabId) : undefined;
  const pane = tab ? pick(tab.panes, (p) => p.pane_id === sel.paneId) : undefined;
  return { ws, tab, pane };
}

export function selectionForPane(tree: WorkspaceNode[], paneId: string): Selection | null {
  for (const w of tree) {
    for (const t of w.tabs) {
      if (t.panes.some((p) => p.pane_id === paneId)) return { workspaceId: w.workspace_id, tabId: t.tab_id, paneId };
    }
  }
  return null;
}

const RANK: Record<string, number> = { blocked: 4, working: 3, done: 2, idle: 1 };

export function rollup(statuses: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const s of statuses) {
    if (s && (RANK[s] ?? 0) > (best ? (RANK[best] ?? 0) : 0)) best = s;
  }
  return best;
}

export const paneStatus = (p: PaneNode, agents: AgentMap): string | undefined =>
  agents.get(p.pane_id)?.status ?? p.agent_status;

const hasAgent = (p: PaneNode, agents: AgentMap) => Boolean(agents.get(p.pane_id)?.agent ?? p.agent);

export const tabStatus = (t: TabNode, agents: AgentMap) =>
  rollup(t.panes.filter((p) => hasAgent(p, agents)).map((p) => paneStatus(p, agents)));

export type WorkspaceSummary = { status?: string; agents: number; tabs: number };

export function workspaceSummary(w: WorkspaceNode, agents: AgentMap): WorkspaceSummary {
  const panes = w.tabs.flatMap((t) => t.panes).filter((p) => hasAgent(p, agents));
  return { status: rollup(panes.map((p) => paneStatus(p, agents))), agents: panes.length, tabs: w.tabs.length };
}

export const workspaceName = (w: WorkspaceNode) => w.label || `Workspace ${w.number ?? w.workspace_id}`;
export const tabName = (t: TabNode) =>
  t.label && t.label !== String(t.number) ? t.label : `Tab ${t.number ?? t.tab_id}`;
export const paneName = (p: PaneNode, agents?: AgentMap) =>
  p.label || agents?.get(p.pane_id)?.agent || p.agent || p.terminal_title_stripped || p.pane_id;
