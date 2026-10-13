import { color256, lineText, parseAnsi } from '../live/ansi';

describe('parseAnsi', () => {
  it('splits CRLF lines and keeps plain text', () => {
    const lines = parseAnsi('a\r\nb\r\n');
    expect(lines.map(lineText)).toEqual(['a', 'b', '']);
  });

  it('applies SGR colours and resets', () => {
    const [line] = parseAnsi('\x1b[1m\x1b[38;5;2muser\x1b[0m:\x1b[31mred\x1b[39m plain');
    expect(line).toEqual([
      { text: 'user', style: { bold: true, fg: color256(2) } },
      { text: ':', style: {} },
      { text: 'red', style: { fg: '#cc6666' } },
      { text: ' plain', style: {} },
    ]);
  });

  it('supports truecolor, backgrounds and inverse', () => {
    const [line] = parseAnsi('\x1b[38;2;255;0;16;48;5;232;7mx');
    expect(line[0].style).toEqual({ fg: '#ff0010', bg: '#080808', inverse: true });
  });

  it('strips non-SGR CSI, OSC (BEL and ST) and control characters', () => {
    const [line] = parseAnsi('\x1b[2K\x1b]0;title\x07a\x1b]8;;http://x\x1b\\b\x07c\x1b(Bd\x1b[?25l');
    expect(lineText(line)).toBe('abcd');
  });

  it('carries style across lines and merges equal-style spans', () => {
    const lines = parseAnsi('\x1b[32mgo\ning\x1b[0m');
    expect(lines[1]).toEqual([{ text: 'ing', style: { fg: '#b5bd68' } }]);
    expect(parseAnsi('\x1b[32ma\x1b[32mb')[0]).toEqual([{ text: 'ab', style: { fg: '#b5bd68' } }]);
  });

  it('tolerates truncated escapes and bad palette indices', () => {
    expect(lineText(parseAnsi('ok\x1b[')[0])).toBe('ok');
    expect(parseAnsi('\x1b[38;5;999mx')[0][0].style).toEqual({});
    expect(color256(255)).toBe('#eeeeee');
    expect(color256(196)).toBe('#ff0000');
  });
});
