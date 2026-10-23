import type { AgentMap } from './agents';

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

export function monitorText(server: string, maps: AgentMap[], link: 'up' | 'reconnecting' | 'waiting' | 'failed' = 'up'): string {
  if (link === 'reconnecting') return `${server}: connection lost · reconnecting…`;
  if (link !== 'up') return `${server}: disconnected · open the app to reconnect`;
  const s = agentSummary(maps);
  return s ? `${server}: ${s}` : `${server}: no agents busy`;
}

export const AGENTS_URL = 'herdrclient://agents';
