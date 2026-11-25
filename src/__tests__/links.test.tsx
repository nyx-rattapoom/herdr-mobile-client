import { Alert, Linking } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { parseAnsi } from '../live/ansi';
import { CoreTerminalBuffer, continuesOnNextLine } from '../core/terminalBuffer';
import { joinWrappedLinks, layoutLine, type GridLine } from '../live/grid';
import { findUrls } from '../live/links';
import { TermRow, cellMetrics } from '../screens/TermView';

const one = (s: string) => layoutLine(parseAnsi(s)[0]);
const urls = (s: string) => findUrls(s).map((m) => m.url);

describe('findUrls', () => {
  it('finds http and https URLs and nothing else', () => {
    expect(urls('see https://example.com/a?b=1#c and http://x.io')).toEqual([
      'https://example.com/a?b=1#c',
      'http://x.io',
    ]);
    expect(urls('ftp://x.io file:///etc javascript:alert(1) mailto:a@b.c https://')).toEqual([]);
  });

  it('drops trailing punctuation and unbalanced closing brackets', () => {
    expect(urls('Open https://example.com/path.')).toEqual(['https://example.com/path']);
    expect(urls('(https://example.com/x), "https://y.dev"')).toEqual(['https://example.com/x', 'https://y.dev']);
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(urls('[link](https://a.dev/b)')).toEqual(['https://a.dev/b']);
  });
});

describe('layoutLine links', () => {
  it('leaves rows without URLs unchanged', () => {
    expect(one('plain text').links).toBeUndefined();
  });

  it('positions a URL on the cell grid across style changes', () => {
    const g = one('\x1b[1m→ \x1b[34mhttps://a.dev/\x1b[0mx y');
    expect(g.links).toEqual([{ col: 2, cells: 15, url: 'https://a.dev/x' }]);
  });

  it('counts wide characters and tabs before the URL', () => {
    expect(one('漢字 https://a.dev').links).toEqual([{ col: 5, cells: 13, url: 'https://a.dev' }]);
    expect(one('a\thttps://a.dev').links).toEqual([{ col: 8, cells: 13, url: 'https://a.dev' }]);
  });
});

describe('joinWrappedLinks', () => {
  const URL = 'https://example.com/login?code=abc123';
  const core = (cols: number, out: string) => {
    const buf = new CoreTerminalBuffer(cols, 4);
    buf.write(new TextEncoder().encode(out));
    const all = buf.allLines();
    return joinWrappedLinks(
      all.map((l) => layoutLine(l)),
      (i) => continuesOnNextLine(all[i]),
    );
  };
  const urlsOf = (g: GridLine[]) => g.map((r) => r.links?.map((l) => l.url));

  it('links every row of a URL the terminal wrapped to the whole URL', () => {
    expect(core(20, `open ${URL} now`).slice(0, 3).map((r) => r.links)).toEqual([
      [{ col: 5, cells: 15, url: URL }],
      [{ col: 0, cells: 20, url: URL }],
      [{ col: 0, cells: 2, url: URL }],
    ]);
  });

  it('does not join a full row that ended with a newline', () => {
    expect(urlsOf(core(20, 'go https://b.dev/xyz\r\nDone'))).toEqual([['https://b.dev/xyz'], undefined, undefined, undefined]);
  });

  it('ends a wrapped URL at a space in the last column', () => {
    expect(urlsOf(core(20, 'see https://a.dev/x next'))).toEqual([['https://a.dev/x'], undefined, undefined, undefined]);
  });

  describe('without wrap information', () => {
    const rows = (...lines: string[]) => urlsOf(joinWrappedLinks(lines.map(one)));

    it('never opens a URL guessed across rows', () => {
      expect(rows('Open https://github.com/login/device', 'Enter code: ABCD-1234')).toEqual([undefined, undefined]);
      expect(rows('see https://a.dev/lo', 'gin?x=1 ok')).toEqual([undefined, undefined]);
      expect(rows('id https://a.dev/?u=', 'http://b.dev more')).toEqual([undefined, undefined]);
    });

    it('keeps URLs that a space or blank row ends', () => {
      expect(rows('visit https://a.dev', '  next', 'https://b.dev ok', 'Done', 'last https://c.dev')).toEqual([
        ['https://a.dev'],
        undefined,
        ['https://b.dev'],
        undefined,
        ['https://c.dev'],
      ]);
    });
  });
});

describe('TermRow links', () => {
  const row = (s: string) => {
    let r: ReactTestRenderer | undefined;
    act(() => {
      r = create(<TermRow g={one(s)} m={cellMetrics(12, 7)} />);
    });
    return r!;
  };
  const spots = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.testID === 'term-link' && !!n.props.onPress);

  it('opens a tapped URL in the browser', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const r = row('go to https://a.dev/x now');
    const [spot] = spots(r);
    expect(spot.props.accessibilityLabel).toBe('https://a.dev/x');
    await act(async () => spot.props.onPress());
    expect(open).toHaveBeenCalledWith('https://a.dev/x');
    open.mockRestore();
  });

  it('says so when the URL cannot be opened', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const r = row('https://a.dev');
    await act(async () => spots(r)[0].props.onPress());
    expect(alert).toHaveBeenCalledWith("Couldn't open link", 'https://a.dev');
    open.mockRestore();
    alert.mockRestore();
  });

  it('opens the whole URL from each row it wraps across', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const buf = new CoreTerminalBuffer(20, 4);
    buf.write(new TextEncoder().encode('see https://a.dev/login?x=1 ok'));
    const all = buf.allLines();
    const g = joinWrappedLinks(
      all.map((l) => layoutLine(l)),
      (i) => continuesOnNextLine(all[i]),
    );
    for (const line of g.slice(0, 2)) {
      let r: ReactTestRenderer | undefined;
      act(() => {
        r = create(<TermRow g={line} m={cellMetrics(12, 7)} />);
      });
      await act(async () => spots(r!)[0].props.onPress());
    }
    expect(open.mock.calls).toEqual([['https://a.dev/login?x=1'], ['https://a.dev/login?x=1']]);
    open.mockRestore();
  });

  it('adds no tap targets to rows without URLs', () => {
    expect(spots(row('no links here'))).toHaveLength(0);
  });
});
