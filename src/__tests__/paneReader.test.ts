import { DEFAULT_LINES, MAX_LINES, PaneReader } from '../live/PaneReader';

describe('PaneReader', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = (texts: string[]) => {
    const calls: Record<string, unknown>[] = [];
    let i = 0;
    const query = jest.fn(async (_m: string, p: Record<string, unknown>) => {
      calls.push(p);
      return { read: { text: texts[Math.min(i++, texts.length - 1)], truncated: true } } as never;
    });
    const outputs: { text: string; lines: number }[] = [];
    const errors: unknown[] = [];
    const r = new PaneReader(query, 'w1:p1', (o) => outputs.push(o), (e) => errors.push(e), 1000);
    return { r, calls, outputs, errors, query };
  };
  const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('reads recent ANSI output and only emits changes', async () => {
    const { r, calls, outputs } = setup(['a', 'a', 'b']);
    r.start();
    await tick();
    expect(calls[0]).toEqual({ pane_id: 'w1:p1', source: 'recent', lines: DEFAULT_LINES, format: 'ansi' });
    jest.advanceTimersByTime(1000);
    await tick();
    jest.advanceTimersByTime(1000);
    await tick();
    expect(outputs.map((o) => o.text)).toEqual(['a', 'b']);
    r.stop();
  });

  it('grows the window up to the cap', async () => {
    const { r, calls } = setup(['a']);
    r.start();
    await tick();
    while (r.loadMore()) await tick();
    expect(r.windowLines).toBe(MAX_LINES);
    expect(calls[calls.length - 1].lines).toBe(MAX_LINES);
    r.stop();
  });

  it('stops polling and reports errors while running', async () => {
    const query = jest.fn(async () => {
      throw new Error('boom');
    });
    const errors: unknown[] = [];
    const r = new PaneReader(query, 'p', () => {}, (e) => errors.push(e), 1000);
    r.start();
    await tick();
    expect(errors).toHaveLength(1);
    r.stop();
    jest.advanceTimersByTime(5000);
    await tick();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
