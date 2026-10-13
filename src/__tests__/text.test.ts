import { formatAlert } from '../live/alerts';
import { cleanLabel, stripUnsafe } from '../live/text';

describe('cleanLabel (review L7/L8)', () => {
  it('strips controls and bidi, collapses whitespace, truncates', () => {
    expect(stripUnsafe('a\u0007b‮c\u0090d\te')).toBe('abcd\te');
    expect(cleanLabel(' api\n\tworkspace ')).toBe('api workspace');
    expect(cleanLabel('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(cleanLabel(42)).toBeUndefined();
    expect(cleanLabel('‮⁦')).toBeUndefined();
  });

  it('sanitises server-supplied parts of notifications', () => {
    const { title, body } = formatAlert(
      { kind: 'blocked', paneId: 'w1:p1', agent: 'evil‮txt' + 'x'.repeat(50), workspaceId: 'w1' },
      { server: 'box', session: 'default', workspaceLabel: 'line1\nline2' },
    );
    expect(title).not.toMatch(/[‪-‮]/);
    expect(title.length).toBeLessThanOrEqual(30 + ' needs your input'.length);
    expect(body).toBe('Blocked in box · line1 line2 · w1:p1');
  });
});
