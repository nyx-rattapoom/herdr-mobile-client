import type { AgentMap } from './agents';

/** "2 working · 1 needs you · 1 done" across sessions; null when no agent is busy or waiting. */
export function agentSummary(maps: AgentMap[]): string | null {
  const count = (s: string) => maps.reduce((n, m) => n + [...m.values()].filter((a) => a.status === s).length, 0);
  const parts = [
    [count('working'), 'working'],
    [count('blocked'), 'needs you'],
    [count('done'), 'done'],
  ]
    .filter(([n]) => n)
    .map(([n, label]) => (label === 'needs you' && n !== 1 ? `${n} need you` : `${n} ${label}`));
  return parts.length ? parts.join(' · ') : null;
}

/** Text of the ongoing notification while connected to a server. */
export function monitorText(server: string, maps: AgentMap[]): string {
  const s = agentSummary(maps);
  return s ? `${server}: ${s}` : `${server}: no agents busy`;
}

/** The URL the ongoing notification opens: show the agents sheet. */
export const AGENTS_URL = 'herdrclient://agents';
