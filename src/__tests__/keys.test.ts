import { PASTE_MAX, appendedChar, cleanPaste, modifiedChar, modifiedKey } from '../live/keys';

describe('one-shot modifiers', () => {
  it('names typed characters the way Herdr parses key combos', () => {
    expect(modifiedChar('ctrl', 'A')).toBe('ctrl+a');
    expect(modifiedChar('alt', 'B')).toBe('alt+B');
    expect(modifiedChar('alt', '.')).toBe('alt+period');
    expect(modifiedChar('ctrl', '/')).toBe('ctrl+slash');
    expect(modifiedChar('ctrl', ' ')).toBe('ctrl+space');
    expect(modifiedChar('alt', '[')).toBe('alt+[');
    expect(modifiedChar('ctrl', 'é')).toBeNull();
    expect(modifiedChar('ctrl', 'ab')).toBeNull();
  });

  it('adds the modifier to special keys that have none', () => {
    expect(modifiedKey('ctrl', 'left')).toBe('ctrl+left');
    expect(modifiedKey('alt', 'backspace')).toBe('alt+backspace');
    expect(modifiedKey('alt', 'ctrl+c')).toBe('ctrl+c');
  });

  it('spots a single character typed at the end of the input', () => {
    expect(appendedChar('ab', 'abc')).toBe('c');
    expect(appendedChar('', '😀')).toBe('😀');
    expect(appendedChar('ab', 'abcd')).toBeNull();
    expect(appendedChar('ab', 'xab')).toBeNull();
    expect(appendedChar('ab', 'a')).toBeNull();
  });
});

describe('cleanPaste', () => {
  it('keeps newlines and tabs, normalises CRLF and strips other control characters', () => {
    expect(cleanPaste('a\r\nb\rc\td')).toEqual({ text: 'a\nb\nc\td', removed: 0, truncated: false });
    expect(cleanPaste('rm -rf x\x1b[201~\x07;\x00echo')).toEqual({
      text: 'rm -rf x[201~;echo',
      removed: 3,
      truncated: false,
    });
    expect(cleanPaste('x\x7f\x9by')).toMatchObject({ text: 'xy', removed: 2 });
  });

  it('caps the size', () => {
    const r = cleanPaste('z'.repeat(PASTE_MAX + 10));
    expect(r.text).toHaveLength(PASTE_MAX);
    expect(r.truncated).toBe(true);
  });
});
