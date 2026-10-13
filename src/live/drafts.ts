/**
 * Unsent composer text per pane, kept in memory so it survives switching tabs, workspaces and
 * screens. Not persisted: a draft can hold secrets typed for a password prompt.
 */
const drafts = new Map<string, string>();

/** Most drafts kept; the oldest are dropped first. */
export const MAX_DRAFTS = 100;

export const draftKey = (serverId: string, session: string, paneId: string) => `${serverId}|${session}|${paneId}`;

export function getDraft(key: string): string {
  return drafts.get(key) ?? '';
}

export function setDraft(key: string, text: string): void {
  drafts.delete(key);
  if (!text) return;
  drafts.set(key, text);
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value as string);
}
