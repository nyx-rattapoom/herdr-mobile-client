import type { AgentAlert } from './agents';
import { cleanLabel } from './text';

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
  const who = cleanLabel(a.agent, 30) ?? 'Agent';
  const where = [
    cleanLabel(ctx.server, 40),
    ctx.session !== 'default' ? cleanLabel(ctx.session, 30) : undefined,
    cleanLabel(ctx.workspaceLabel, 30) ?? cleanLabel(a.workspaceId, 20),
    cleanLabel(a.paneId, 20),
  ]
    .filter(Boolean)
    .join(' · ');
  return a.kind === 'blocked'
    ? { title: `${who} needs your input`, body: `Blocked in ${where}` }
    : { title: `${who} finished`, body: `Completed in ${where}` };
}
