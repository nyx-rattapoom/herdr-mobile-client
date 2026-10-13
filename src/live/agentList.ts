import type { WorkspaceNode } from '../protocol/snapshot';
import type { AgentMap } from './agents';
import { paneStatus, tabName, workspaceName } from './workspace';

export type AgentGroup = 'pinned' | 'blocked' | 'working' | 'done' | 'idle';

/** Group order and headings in the agents sheet. */
export const AGENT_GROUPS: { id: AgentGroup; title: string }[] = [
  { id: 'pinned', title: 'Pinned' },
  { id: 'blocked', title: 'Needs you' },
  { id: 'working', title: 'Working' },
  { id: 'done', title: 'Done' },
  { id: 'idle', title: 'Idle' },
];

export type AgentRow = {
  paneId: string;
  agent?: string;
  status: string;
  group: AgentGroup;
  name: string;
  tab: string;
  workspace: string;
  workspaceId: string;
  /** Done since the user last opened the pane. */
  unseen: boolean;
  pinned?: boolean;
  muted?: boolean;
};

/** Local pin/mute/snooze marks, as far as the list needs them. */
export type RowFlags = {
  get(paneId: string): { pinned?: boolean; muted?: boolean };
  isSnoozed(paneId: string): boolean;
};

const groupOf = (s: string): AgentGroup => (s === 'blocked' || s === 'working' || s === 'done' ? s : 'idle');

/**
 * A done agent is unseen when its status changed after the pane was last opened. `since` is 0
 * for statuses already present at connect, so those count as unseen only for never-opened panes.
 */
export const isUnseen = (status: string, since: number | undefined, viewedAt: number | undefined) =>
  status === 'done' && (viewedAt ?? -1) < (since ?? 0);

/** Every agent pane in the session, grouped and ordered for the agents sheet. Snoozed panes are left out. */
export function agentRows(
  tree: WorkspaceNode[],
  agents: AgentMap,
  since: Map<string, number>,
  viewed: Record<string, number>,
  flags?: RowFlags,
): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const w of tree) {
    for (const t of w.tabs) {
      for (const p of t.panes) {
        const a = agents.get(p.pane_id);
        const agent = a?.agent ?? p.agent;
        if (!agent || flags?.isSnoozed(p.pane_id)) continue;
        const f = flags?.get(p.pane_id) ?? {};
        const status = paneStatus(p, agents) ?? 'unknown';
        rows.push({
          paneId: p.pane_id,
          agent,
          status,
          group: f.pinned ? 'pinned' : groupOf(status),
          pinned: f.pinned,
          muted: f.muted,
          name: p.label || p.terminal_title_stripped || p.pane_id,
          tab: tabName(t),
          workspace: workspaceName(w),
          workspaceId: w.workspace_id,
          unseen: isUnseen(status, since.get(p.pane_id), viewed[p.pane_id]),
        });
      }
    }
  }
  const order = (r: AgentRow) => AGENT_GROUPS.findIndex((g) => g.id === r.group);
  // Stable sort keeps tree order within a group; unseen done agents come first.
  return rows.sort((a, b) => order(a) - order(b) || Number(b.unseen) - Number(a.unseen));
}
