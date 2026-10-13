import type { PaneNode, TabNode, WorkspaceNode } from '../protocol/snapshot';

export type Target =
  | { kind: 'session' }
  | { kind: 'workspace'; node: WorkspaceNode }
  | { kind: 'tab'; node: TabNode }
  | { kind: 'pane'; node: PaneNode };

export type ActionId =
  | 'workspace.create'
  | 'workspace.focus'
  | 'workspace.close'
  | 'tab.create'
  | 'tab.focus'
  | 'tab.close'
  | 'pane.focus'
  | 'pane.split_right'
  | 'pane.split_down'
  | 'pane.close';

export type ActionDef = {
  id: ActionId;
  label: string;
  /** Needs explicit confirmation before it is sent. */
  destructive?: boolean;
  /** Asks the user for an optional label first. */
  asksLabel?: boolean;
};

const label = (n: { label?: string; number?: number }, id: string) => n.label || (n.number != null ? `#${n.number}` : id);

export function targetName(t: Target): string {
  switch (t.kind) {
    case 'session':
      return 'session';
    case 'workspace':
      return `workspace ${label(t.node, t.node.workspace_id)}`;
    case 'tab':
      return `tab ${label(t.node, t.node.tab_id)}`;
    case 'pane':
      return `pane ${t.node.pane_id}`;
  }
}

export function actionsFor(t: Target): ActionDef[] {
  switch (t.kind) {
    case 'session':
      return [{ id: 'workspace.create', label: 'New workspace', asksLabel: true }];
    case 'workspace':
      return [
        { id: 'workspace.focus', label: 'Focus workspace' },
        { id: 'tab.create', label: 'New tab', asksLabel: true },
        { id: 'workspace.create', label: 'New workspace', asksLabel: true },
        { id: 'workspace.close', label: 'Close workspace', destructive: true },
      ];
    case 'tab':
      return [
        { id: 'tab.focus', label: 'Focus tab' },
        { id: 'tab.create', label: 'New tab', asksLabel: true },
        { id: 'tab.close', label: 'Close tab', destructive: true },
      ];
    case 'pane':
      return [
        { id: 'pane.focus', label: 'Focus pane' },
        { id: 'pane.split_right', label: 'Split right' },
        { id: 'pane.split_down', label: 'Split down' },
        { id: 'pane.close', label: 'Close pane', destructive: true },
      ];
  }
}

export function confirmText(a: ActionDef, t: Target): string {
  const what = targetName(t);
  if (t.kind === 'pane') return `Close ${what}? Its process will be terminated.`;
  if (t.kind === 'tab') return `Close ${what} and all ${t.node.panes.length} pane(s) in it? Their processes will be terminated.`;
  if (t.kind === 'workspace') {
    const panes = t.node.tabs.reduce((n, tab) => n + tab.panes.length, 0);
    return `Close ${what} with ${t.node.tabs.length} tab(s) and ${panes} pane(s)? Their processes will be terminated.`;
  }
  return `${a.label}?`;
}

/** The socket request for an action on a target. Labels are trimmed; empty means "let Herdr choose". */
export function actionRequest(id: ActionId, t: Target, opts: { label?: string } = {}): { method: string; params: Record<string, unknown> } {
  const lbl = opts.label?.trim() || undefined;
  const ws = t.kind === 'workspace' ? t.node.workspace_id : t.kind === 'tab' || t.kind === 'pane' ? t.node.workspace_id : undefined;
  switch (id) {
    case 'workspace.create':
      return { method: 'workspace.create', params: { focus: false, ...(lbl ? { label: lbl } : {}) } };
    case 'workspace.focus':
      return { method: 'workspace.focus', params: { workspace_id: need(ws) } };
    case 'workspace.close':
      return { method: 'workspace.close', params: { workspace_id: need(ws) } };
    case 'tab.create':
      return { method: 'tab.create', params: { workspace_id: need(ws), focus: false, ...(lbl ? { label: lbl } : {}) } };
    case 'tab.focus':
      return { method: 'tab.focus', params: { tab_id: need(t.kind === 'tab' ? t.node.tab_id : undefined) } };
    case 'tab.close':
      return { method: 'tab.close', params: { tab_id: need(t.kind === 'tab' ? t.node.tab_id : undefined) } };
    case 'pane.focus':
      return { method: 'pane.focus', params: { pane_id: paneOf(t) } };
    case 'pane.split_right':
    case 'pane.split_down':
      return {
        method: 'pane.split',
        params: { target_pane_id: paneOf(t), direction: id === 'pane.split_right' ? 'right' : 'down', focus: false },
      };
    case 'pane.close':
      return { method: 'pane.close', params: { pane_id: paneOf(t) } };
  }
}

function need(v: string | undefined): string {
  if (!v) throw new Error('action does not apply to this target');
  return v;
}
const paneOf = (t: Target) => need(t.kind === 'pane' ? t.node.pane_id : undefined);

/**
 * Special keys offered in the pane key bar, as Herdr key-combo strings. `key` identifies the entry;
 * `keys` is sent instead when it is a sequence (Esc Esc). Agent shortcuts come first.
 */
export const SPECIAL_KEYS: { key: string; label: string; keys?: string[] }[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'esc esc', label: 'Esc Esc', keys: ['esc', 'esc'] },
  { key: 'shift+tab', label: '⇧Tab' },
  { key: 'tab', label: 'Tab' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'left', label: '←' },
  { key: 'right', label: '→' },
  { key: 'enter', label: '⏎' },
  { key: 'backspace', label: '⌫' },
  { key: 'ctrl+c', label: '^C' },
  { key: 'ctrl+d', label: '^D' },
  { key: 'ctrl+z', label: '^Z' },
  { key: 'ctrl+l', label: '^L' },
  { key: 'ctrl+r', label: '^R' },
];

/** The keys a special-key entry sends. */
export const keysOf = (k: { key: string; keys?: string[] }) => k.keys ?? [k.key];

/**
 * Text input request. `submit` appends Enter in the same request so the line and the key can't
 * interleave with other input. Agent prompts use `agent.prompt`, which submits on its own.
 */
export function inputRequest(paneId: string, text: string, mode: 'type' | 'submit' | 'prompt') {
  if (mode === 'prompt') return { method: 'agent.prompt', params: { target: paneId, text } };
  if (mode === 'submit') return { method: 'pane.send_input', params: { pane_id: paneId, text, keys: ['enter'] } };
  return { method: 'pane.send_text', params: { pane_id: paneId, text } };
}

export const keyRequest = (paneId: string, key: string | string[]) => ({
  method: 'pane.send_keys',
  params: { pane_id: paneId, keys: Array.isArray(key) ? key : [key] },
});

/** User-facing text for Herdr action errors. */
export function describeActionError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message ?? String(e);
  switch (code) {
    case 'agent_blocked':
      return 'The agent is waiting for an answer (blocked). Answer it with keys or text instead of a new prompt.';
    case 'workspace_group_close_required':
      return 'This workspace has linked worktree workspaces open. Close those first.';
    case 'not_found':
      return `It no longer exists: ${msg}`;
    case 'unknown_method':
    case 'method_not_found':
      return `This Herdr server does not support that action (${msg}).`;
    default:
      return msg;
  }
}
