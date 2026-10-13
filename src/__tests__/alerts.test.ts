import { AlertDeduper, formatAlert } from '../live/alerts';

const blocked = { kind: 'blocked' as const, paneId: 'w1:p1', agent: 'claude', workspaceId: 'w1' };

describe('AlertDeduper', () => {
  it('drops repeats within the window, per pane, kind and scope', () => {
    let t = 0;
    const d = new AlertDeduper(1000, () => t);
    expect(d.accept(blocked)).toBe(true);
    t = 500;
    expect(d.accept(blocked)).toBe(false);
    expect(d.accept({ ...blocked, kind: 'completed' })).toBe(true);
    expect(d.accept({ ...blocked, paneId: 'w1:p2' })).toBe(true);
    expect(d.accept(blocked, 'other-server')).toBe(true);
    t = 1500;
    expect(d.accept(blocked)).toBe(true);
  });
});

describe('formatAlert', () => {
  it('names agent, server, session and location', () => {
    expect(formatAlert(blocked, { server: 'box', session: 'default', workspaceLabel: 'api' })).toEqual({
      title: 'claude needs your input',
      body: 'Blocked in box · api · w1:p1',
    });
    expect(formatAlert({ kind: 'completed', paneId: 'w2:p1' }, { server: 'box', session: 'agents' })).toEqual({
      title: 'Agent finished',
      body: 'Completed in box · agents · w2:p1',
    });
  });
});
