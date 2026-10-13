import { MAX_DRAFTS, draftKey, getDraft, setDraft } from '../live/drafts';

describe('drafts', () => {
  it('keeps one draft per server, session and pane', () => {
    const a = draftKey('srv', 'default', 'w1:p1');
    const b = draftKey('srv', 'default', 'w1:p2');
    setDraft(a, 'fix the tests\nthen commit');
    expect(getDraft(a)).toBe('fix the tests\nthen commit');
    expect(getDraft(b)).toBe('');
    setDraft(a, '');
    expect(getDraft(a)).toBe('');
  });

  it('drops the least recently edited drafts beyond the cap', () => {
    for (let i = 0; i <= MAX_DRAFTS; i++) setDraft(`k${i}`, `d${i}`);
    expect(getDraft('k0')).toBe('');
    expect(getDraft(`k${MAX_DRAFTS}`)).toBe(`d${MAX_DRAFTS}`);
    setDraft('k1', 'edited');
    for (let i = 0; i < MAX_DRAFTS - 1; i++) setDraft(`n${i}`, 'x');
    expect(getDraft('k1')).toBe('edited');
  });
});
