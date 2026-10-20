import { Pressable, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { LiveSession } from '../live/LiveSession';
import { PaneView, scrollbackHeader } from '../screens/PaneView';

const out = (truncated: boolean) => ({ text: 'x', truncated, lines: 300 });

describe('scrollbackHeader', () => {
  it('offers more scrollback while the read is truncated', () => {
    expect(scrollbackHeader(out(true), true, { kind: 'idle' })).toBe('load-more');
  });

  it('marks the start of scrollback only for panes without an agent', () => {
    expect(scrollbackHeader(out(false), false, { kind: 'idle' })).toBe('start');
    // A full-screen agent's untruncated read is just its screen.
    expect(scrollbackHeader(out(false), true, { kind: 'idle' })).toBe('load-history');
  });

  it('follows the history read', () => {
    expect(scrollbackHeader(out(false), true, { kind: 'loading' })).toBe('history-loading');
    expect(scrollbackHeader(out(false), true, { kind: 'none' })).toBe('history-none');
    expect(scrollbackHeader(out(false), true, { kind: 'failed', message: 'x' })).toBe('history-failed');
    expect(scrollbackHeader(out(true), true, { kind: 'shown', lines: [], partial: false })).toBe('history-shown');
    expect(scrollbackHeader(null, true, { kind: 'idle' })).toBe('loading');
  });
});

describe('PaneView history', () => {
  // Polling and list batching run on timers; keep them from outliving the test.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const screen = 'row1\nrow2\nrow3\n';
  const history = Array.from({ length: 12 }, (_, i) => `h${i}`).join('\n');

  async function render(historyText: string | Error, truncated = false, footer?: (poke: () => void) => React.ReactNode) {
    const query = jest.fn(async (_m: string, p: Record<string, unknown>) => {
      if (p.format !== 'text') return { read: { text: screen, truncated: false } };
      if (historyText instanceof Error) throw historyText;
      return { read: { text: historyText, truncated } };
    });
    const live = { query } as unknown as LiveSession;
    let r: ReactTestRenderer | undefined;
    await act(async () => {
      r = create(<PaneView live={live} paneId="w1:p1" agent="claude" footer={footer} />);
    });
    return r!;
  }
  const data = (r: ReactTestRenderer) => r.root.findByProps({ testID: 'pane-output' }).props.data as unknown[];
  const press = async (r: ReactTestRenderer, testID: string) => {
    await act(async () => {
      r.root.findByProps({ testID }).props.onPress();
    });
  };
  /** Each outermost Text's full string, nested Text included. */
  const texts = (r: ReactTestRenderer) => {
    const flat = (c: unknown): string =>
      typeof c === 'string' || typeof c === 'number'
        ? String(c)
        : Array.isArray(c)
          ? c.map(flat).join('')
          : c && typeof c === 'object' && 'props' in c
            ? flat((c as { props: { children?: unknown } }).props.children)
            : '';
    return r.root.findAll((n) => n.type === Text && n.parent?.type !== Text).map((n) => flat(n.props.children));
  };

  it('shows the agent history, then returns to the live screen', async () => {
    const r = await render(history);
    expect(data(r)).toHaveLength(3);
    await press(r, 'load-history');
    expect(data(r)).toHaveLength(12);
    expect(texts(r)).toContain('Agent history (plain text) · Back to live');
    await press(r, 'history-back');
    expect(data(r)).toHaveLength(3);
    act(() => r.unmount());
  });

  it('keeps a way back to live in view and marks a partial history', async () => {
    const r = await render(history, true);
    await press(r, 'load-history');
    expect(texts(r)).toContain('Agent history, partial (plain text) · Back to live');
    expect(texts(r)).toContain('↓ Back to live');
    await press(r, 'jump-bottom');
    expect(data(r)).toHaveLength(3);
    act(() => r.unmount());
  });

  it('returns to live when input is sent from the composer', async () => {
    const r = await render(history, false, (poke) => <Pressable testID="send" onPress={poke} />);
    await press(r, 'load-history');
    expect(data(r)).toHaveLength(12);
    await press(r, 'send');
    expect(data(r)).toHaveLength(3);
    act(() => r.unmount());
  });

  it('reports a failed read and offers a retry', async () => {
    const r = await render(new Error('pane.read timed out after 25000 ms'));
    await press(r, 'load-history');
    expect(texts(r)).toContain("Couldn't load history · Retry");
    expect(texts(r).some((t) => t.includes('timed out after 25000 ms'))).toBe(true);
    act(() => r.unmount());
  });

  it('says so when the read brings nothing older than the screen', async () => {
    const r = await render(screen);
    await press(r, 'load-history');
    expect(data(r)).toHaveLength(3);
    expect(texts(r)).toContain('No older agent history · Retry');
    act(() => r.unmount());
  });
});
