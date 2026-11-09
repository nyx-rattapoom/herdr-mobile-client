import { encodeUtf8 } from '../core/bytes';
import { MAX_HISTORY, CoreTerminalBuffer } from '../core/terminalBuffer';

const feed = (buf: CoreTerminalBuffer, text: string) => buf.write(encodeUtf8(text));
const text = (buf: CoreTerminalBuffer) => buf.screenText();

describe('CoreTerminalBuffer text and controls', () => {
  it('handles CR progress, LF, backspace and tabs', () => {
    const buf = new CoreTerminalBuffer(20, 4);
    feed(buf, '10%\r20%\r100%\r\n');
    feed(buf, 'ab\bcd\r\n');
    feed(buf, 'a\tb');
    expect(text(buf).split('\n').slice(0, 3)).toEqual(['100%', 'acd', 'a       b']);
  });

  it('wraps at the right edge and records scrolled lines in bounded history', () => {
    const buf = new CoreTerminalBuffer(5, 2);
    feed(buf, 'abcdefghij');
    expect(buf.allLines().map((l) => l.map((s) => s.text).join('')).slice(-2)).toEqual(['abcde', 'fghij']);
    feed(buf, '\r\nX\r\nY');
    expect(buf.historyLength).toBeGreaterThan(0);
    for (let i = 0; i < MAX_HISTORY + 50; i++) feed(buf, `line${i}\n`);
    expect(buf.historyLength).toBe(MAX_HISTORY);
  });

  it('keeps the newest history lines oldest-first once the bound is reached', () => {
    const buf = new CoreTerminalBuffer(10, 1, 3);
    feed(buf, 'a\r\nb\r\nc\r\nd\r\ne\r\nf');
    expect(buf.historyLength).toBe(3);
    expect(buf.allLines().map((l) => l.map((s) => s.text).join(''))).toEqual(['c', 'd', 'e', 'f']);
    feed(buf, '\x1b[3J');
    expect(buf.allLines().map((l) => l.map((s) => s.text).join(''))).toEqual(['f']);
  });

  it('handles absolute and relative cursor movement, save/restore and erase', () => {
    const buf = new CoreTerminalBuffer(10, 4);
    feed(buf, '\x1b[2;3HX');
    expect(text(buf).split('\n')[1][2]).toBe('X');
    feed(buf, '\x1b[1;1HY\x1b[2;2H\x1b[sZ\x1b[uQ');
    expect(text(buf).split('\n')[0][0]).toBe('Y');
    expect(text(buf).split('\n')[1][1]).toBe('Q');
    feed(buf, '\x1b[2J\x1b[Hok');
    expect(text(buf).split('\n')[0]).toBe('ok');
    feed(buf, '\x1b[42;3H');
    expect(buf.cursor).toEqual({ row: 3, col: 2 });
  });

  it('handles scroll regions, insert/delete lines and insert/delete chars', () => {
    const buf = new CoreTerminalBuffer(8, 4);
    feed(buf, '1111\r\n2222\r\n3333\r\n4444');
    feed(buf, '\x1b[2;3r\x1b[3;1H\n');
    const rows = text(buf).split('\n');
    expect(rows[0]).toBe('1111');
    expect(rows[1]).toBe('3333');
    expect(rows[2]).toBe('');
    expect(rows[3]).toBe('4444');
    const buf2 = new CoreTerminalBuffer(8, 3);
    feed(buf2, 'aa\r\nbb\r\ncc');
    feed(buf2, '\x1b[2;1H\x1b[L');
    expect(text(buf2).split('\n')).toEqual(['aa', '', 'bb']);
    feed(buf2, '\x1b[2;1H\x1b[M');
    expect(text(buf2).split('\n')).toEqual(['aa', 'bb']);
    const buf3 = new CoreTerminalBuffer(8, 1);
    feed(buf3, 'abcd');
    feed(buf3, '\x1b[1;2H\x1b[2P');
    expect(text(buf3)).toBe('ad');
    feed(buf3, '\x1b[1;1H\x1b[2@xy');
    expect(text(buf3)).toBe('xyad');
  });

  it('applies 16/256/RGB SGR and resets styles', () => {
    const buf = new CoreTerminalBuffer(10, 2);
    feed(buf, '\x1b[31ma\x1b[1;4mb\x1b[38;5;196mc\x1b[48;2;1;2;3md\x1b[0me');
    const line = buf.screenLines()[0];
    expect(line[0]).toEqual({ text: 'a', style: { fg: '#cc6666' } });
    expect(line[1].style).toMatchObject({ fg: '#cc6666', bold: true, underline: true });
    expect(line[2].style.fg).toBe('#ff0000');
    expect(line[3].style.bg).toBe('#010203');
    expect(line[4]).toEqual({ text: 'e', style: {} });
  });

  it('clamps hostile repeat counts to the screen instead of looping on them', () => {
    const huge = '999999999';
    const buf = new CoreTerminalBuffer(4, 2, 5);
    const rep = Date.now();
    feed(buf, `x\x1b[${huge}b`);
    expect(Date.now() - rep).toBeLessThan(1000);
    expect(text(buf).split('\n')[0]).toBe('xxxx');
    expect(buf.historyLength).toBeLessThanOrEqual(5);
    for (const final of ['L', 'M', 'S', 'T', '@', 'P', 'X', 'I', 'Z']) {
      const b = new CoreTerminalBuffer(4, 3, 5);
      feed(b, 'ab\r\ncd\x1b[1;2H');
      const started = Date.now();
      feed(b, `\x1b[${huge}${final}`);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(b.historyLength).toBeLessThanOrEqual(5);
    }
    const scrolled = new CoreTerminalBuffer(4, 3, 10);
    feed(scrolled, 'a\r\nb\r\nc');
    feed(scrolled, `\x1b[${huge}S`);
    expect(text(scrolled)).toBe('');
    expect(scrolled.historyLength).toBe(3);
  });

  it('enters and leaves the alternate screen without losing the main screen', () => {
    const buf = new CoreTerminalBuffer(10, 3);
    feed(buf, 'main');
    feed(buf, '\x1b[?1049halt');
    expect(buf.alternateScreen).toBe(true);
    expect(text(buf).split('\n')[0]).toBe('alt');
    feed(buf, '\x1b[?1049l');
    expect(buf.alternateScreen).toBe(false);
    expect(text(buf).split('\n')[0]).toBe('main');
  });
});

describe('CoreTerminalBuffer bytes and parsing', () => {
  const transcript =
    '\x1b[2J\x1b[H normal \x1b[1mbold\x1b[0m\r\n' +
    'wide 世界 emoji 🚀\r\n' +
    'combining e\u0301\r\n' +
    '\x1b]0;window title\x07' +
    '\x1b[31mred\x1b[0m \x1b[2;2H@';

  const render = (chunks: Uint8Array[]) => {
    const buf = new CoreTerminalBuffer(30, 6);
    for (const c of chunks) buf.write(c);
    return {
      text: buf.screenText(),
      cells: buf.screenLines().map((l) => JSON.stringify(l)),
      history: buf.historyLength,
      cursor: buf.cursor,
    };
  };

  it('produces identical output for whole, byte-by-byte and fragmented input', () => {
    const whole = render([encodeUtf8(transcript)]);
    const one = render([...encodeUtf8(transcript)].map((b) => Uint8Array.of(b)));
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const bytes = encodeUtf8(transcript);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; ) {
      const n = 1 + Math.floor(rand() * 7);
      chunks.push(bytes.subarray(i, i + n));
      i += n;
    }
    const fragmented = render(chunks);
    for (const r of [one, fragmented]) {
      expect(r.text).toBe(whole.text);
      expect(r.cells).toEqual(whole.cells);
      expect(r.history).toBe(whole.history);
      expect(r.cursor).toEqual(whole.cursor);
      expect(r.text).not.toContain('window title');
    }
  });

  it('never paints split or oversized escape sequences', () => {
    const buf = new CoreTerminalBuffer(20, 3);
    const split = encodeUtf8('\x1b[31mRED\x1b[0m');
    for (const b of split) buf.write(Uint8Array.of(b));
    expect(text(buf)).toBe('RED');
    expect(buf.screenLines()[0][0].style).toEqual({ fg: '#cc6666' });
    feed(buf, '\x1b[38;5;' + '9'.repeat(9000) + 'mX');
    expect(text(buf)).not.toContain('99999');
  });

  it('handles combining marks and wide-cell overwrite without orphan cells', () => {
    const buf = new CoreTerminalBuffer(10, 2);
    feed(buf, 'e\u0301X');
    expect(text(buf)).toBe('e\u0301X');
    feed(buf, '\r\x1b[2C世');
    const line = buf.screenLines()[0];
    const joined = line.map((s) => s.text).join('');
    expect(joined.startsWith('e\u0301X世')).toBe(true);
    // Overwrite the first half of the wide glyph.
    feed(buf, '\r\x1b[3CZ');
    expect(text(buf).includes('\u0000')).toBe(false);
  });

  it('resizes by cropping and padding without reflow', () => {
    const buf = new CoreTerminalBuffer(10, 3);
    feed(buf, 'abcdefghij\r\nklm');
    buf.resize(5, 2);
    expect(text(buf).split('\n')).toEqual(['abcde', 'klm']);
    buf.resize(7, 4);
    expect(text(buf).split('\n').slice(0, 2)).toEqual(['abcde', 'klm']);
    expect(buf.cols).toBe(7);
    expect(buf.rows).toBe(4);
  });
});
