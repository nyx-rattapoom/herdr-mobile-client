import { Alert, Linking } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { parseAnsi } from '../live/ansi';
import { layoutLine } from '../live/grid';
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
