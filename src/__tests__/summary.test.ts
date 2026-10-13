import type { AgentMap } from '../live/agents';
import { agentSummary, monitorText } from '../live/summary';

const map = (...statuses: string[]): AgentMap => new Map(statuses.map((s, i) => [`p${i}`, { status: s, agent: 'x' }]));

describe('agent summary', () => {
  it('counts working, needs-you and done agents across sessions', () => {
    expect(agentSummary([map('working', 'blocked', 'idle'), map('working', 'done')])).toBe(
      '2 working · 1 needs you · 1 done',
    );
    expect(agentSummary([map('blocked', 'blocked')])).toBe('2 need you');
    expect(agentSummary([map('idle'), new Map()])).toBeNull();
  });

  it('names the server in the notification text', () => {
    expect(monitorText('box', [map('working')])).toBe('box: 1 working');
    expect(monitorText('box', [])).toBe('box: no agents busy');
  });
});
