import { Alert, Linking } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { parseAnsi } from '../live/ansi';
import { CoreTerminalBuffer } from '../core/terminalBuffer';
import { dropWrappedLinks, layoutLine, type GridLine } from '../live/grid';
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

describe('dropWrappedLinks', () => {
  const snapshot = (...lines: string[]) => urlsOf(dropWrappedLinks(lines.map(one), 0));
  const core = (cols: number, out: string) => {
    const buf = new CoreTerminalBuffer(cols, 4);
    buf.write(new TextEncoder().encode(out));
    return urlsOf(dropWrappedLinks(buf.allLines().map((l) => layoutLine(l))));
  };
  const urlsOf = (g: GridLine[]) => g.map((r) => r.links?.map((l) => l.url));

  it('keeps a URL on a row narrower than the widest row of its snapshot', () => {
    expect(
      snapshot(
        "remote: Create a pull request for 'b' on GitHub by visiting:",
        'remote:      https://github.com/o/r/pull/new/b',
        'remote:',
      ),
    ).toEqual([undefined, ['https://github.com/o/r/pull/new/b'], undefined]);
  });

  it('gives no tap target to a URL that may run on past the pane edge', () => {
    expect(snapshot('Open https://github.com/login/device', 'Enter code: ABCD-1234')).toEqual([undefined, undefined]);
  });

  it('gives no tap target on any row of a URL wrapped across three rows', () => {
    expect(snapshot('go https://auth.x.dev/authorize?id=abcde', 'fghijklmnopqrstuvwxyz0123456789&scope=al', '&r=https://app.dev/cb more')).toEqual([undefined, undefined, undefined]);
  });

  it('keeps URLs that a space or blank row ends', () => {
    expect(snapshot('visit https://a.dev', '  next', 'https://b.dev ok', 'Done', 'last https://c.dev')).toEqual([
      ['https://a.dev'],
      undefined,
      ['https://b.dev'],
      undefined,
      ['https://c.dev'],
    ]);
  });

  it('treats a row one cell short of the widest as wrapped before a wide glyph', () => {
    expect(snapshot('a full row of twenty', 'see https://ja.dev/', '日本語 wiki')).toEqual([undefined, undefined, undefined]);
  });

  it('measures the width over the current snapshot only, not older kept rows', () => {
    const kept = one('older output from a wider pane, a long row');
    const rows = [kept, ...['Open https://github.com/login/device', 'Enter code: ABCD-1234'].map(one)];
    expect(urlsOf(dropWrappedLinks(rows, 1))).toEqual([undefined, undefined, undefined]);
  });

  it('treats older kept rows as possibly wrapped whatever their width', () => {
    const rows = ['see https://a.dev/x', 'more', 'a much wider snapshot row of pane output'].map(one);
    expect(urlsOf(dropWrappedLinks(rows, 2))).toEqual([undefined, undefined, undefined]);
    expect(urlsOf(dropWrappedLinks(rows, 0))).toEqual([['https://a.dev/x'], undefined, undefined]);
  });

  it('gives no tap target to a URL at any row edge in the Core console', () => {
    expect(core(20, 'open https://example.com/login?code=abc123 now')).toEqual([undefined, undefined, undefined, undefined]);
    expect(core(30, 'go https://b.dev/x\r\nDone')).toEqual([undefined, undefined, undefined, undefined]);
    expect(core(30, 'go https://b.dev/x ok\r\nDone')).toEqual([['https://b.dev/x'], undefined, undefined, undefined]);
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

  it('adds no tap targets to rows without URLs', () => {
    expect(spots(row('no links here'))).toHaveLength(0);
  });
});
