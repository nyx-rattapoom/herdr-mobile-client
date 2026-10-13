import type { AgentAlert } from './agents';

/**
 * Suppresses repeats of the same alert for the same pane within a window. Snapshot reads can
 * lag behind status events, so a pane may briefly flap back (blocked → working → blocked).
 */
export class AlertDeduper {
  private last = new Map<string, number>();

  constructor(
    private readonly windowMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  accept(a: AgentAlert, scope = ''): boolean {
    const key = `${scope}|${a.paneId}|${a.kind}`;
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    this.last.set(key, t);
    return true;
  }
}

export type AlertContext = { server: string; session: string; workspaceLabel?: string };

export function formatAlert(a: AgentAlert, ctx: AlertContext): { title: string; body: string } {
  const who = a.agent ?? 'Agent';
  const where = [ctx.server, ctx.session !== 'default' ? ctx.session : null, ctx.workspaceLabel ?? a.workspaceId, a.paneId]
    .filter(Boolean)
    .join(' · ');
  return a.kind === 'blocked'
    ? { title: `${who} needs your input`, body: `Blocked in ${where}` }
    : { title: `${who} finished`, body: `Completed in ${where}` };
}
