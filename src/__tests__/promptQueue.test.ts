import type { AgentMap } from '../live/agents';
import { MAX_QUEUE, PromptQueues, START_TIMEOUT_MS } from '../live/promptQueue';
import { MemoryKv } from '../testing/fakes';

const agents = (status: string): AgentMap => new Map([['p1', { status, agent: 'opencode' }]]);
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('PromptQueues', () => {
  const setup = async (kv = new MemoryKv()) => {
    let t = 0;
    const sent: string[] = [];
    const q = new PromptQueues(
      kv,
      'srv|default',
      async (_pane, text) => void sent.push(text),
      () => t,
    );
    await q.load();
    return { q, sent, kv, tick: (ms: number) => (t += ms) };
  };

  it('holds prompts while the agent works and sends them one per finished turn', async () => {
    const { q, sent } = await setup();
    q.drive('live', agents('working'));
    await q.add('p1', 'first');
    await q.add('p1', 'second');
    await flush();
    expect(sent).toEqual([]);
    q.drive('live', agents('idle'));
    await flush();
    expect(sent).toEqual(['first']);
    expect(q.items('p1').map((i) => i.text)).toEqual(['second']);
    // Still idle: the agent hasn't picked the first one up yet, so the second waits.
    q.drive('live', agents('idle'));
    await flush();
    expect(sent).toEqual(['first']);
    q.drive('live', agents('working'));
    q.drive('live', agents('done'));
    await flush();
    expect(sent).toEqual(['first', 'second']);
    expect(q.items('p1')).toEqual([]);
  });

  it('never sends while the agent is blocked or the connection is down', async () => {
    const { q, sent } = await setup();
    await q.add('p1', 'later');
    q.drive('live', agents('blocked'));
    await flush();
    expect(q.pausedReason('p1')).toMatch(/waiting for an answer/);
    q.drive('reconnecting', agents('idle'));
    await flush();
    expect(q.pausedReason('p1')).toMatch(/disconnected/);
    expect(sent).toEqual([]);
    q.drive('live', agents('idle'));
    await flush();
    expect(sent).toEqual(['later']);
  });

  it('moves on when a sent prompt never made the agent start', async () => {
    jest.useFakeTimers();
    try {
      const { q, sent, tick } = await setup();
      q.drive('live', agents('working'));
      await q.add('p1', 'a');
      await q.add('p1', 'b');
      q.drive('live', agents('idle'));
      await flush();
      expect(sent).toEqual(['a']);
      tick(START_TIMEOUT_MS + 1);
      jest.advanceTimersByTime(START_TIMEOUT_MS + 200);
      await flush();
      expect(sent).toEqual(['a', 'b']);
      q.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('edits, reorders, deletes and sends now', async () => {
    const { q, sent } = await setup();
    q.drive('live', agents('working'));
    await q.add('p1', 'one');
    await q.add('p1', 'two');
    await q.add('p1', 'three');
    const [one, two, three] = q.items('p1');
    await q.move('p1', three.id, -1);
    expect(q.items('p1').map((i) => i.text)).toEqual(['one', 'three', 'two']);
    await q.update('p1', two.id, 'two, edited');
    await q.remove('p1', one.id);
    expect(q.items('p1').map((i) => i.text)).toEqual(['three', 'two, edited']);
    await q.sendNow('p1', two.id);
    expect(sent).toEqual(['two, edited']);
    expect(q.items('p1').map((i) => i.text)).toEqual(['three']);
  });

  it('persists across restarts, long prompts included, and prunes panes that are gone', async () => {
    const kv = new MemoryKv();
    const a = await setup(kv);
    a.q.drive('live', agents('working'));
    const long = 'x'.repeat(5000);
    await a.q.add('p1', long);
    await a.q.add('p2', 'other pane');
    for (const v of kv.map.values()) expect(v.length).toBeLessThan(2048);
    const b = await setup(kv);
    expect(b.q.items('p1')[0].text).toBe(long);
    expect(b.q.items('p2')[0].text).toBe('other pane');
    await b.q.prune(new Set(['p1']));
    expect(b.q.items('p2')).toEqual([]);
    const c = await setup(kv);
    expect(c.q.items('p2')).toEqual([]);
    expect(c.q.items('p1')).toHaveLength(1);
    await c.q.add('p1', 'next');
    expect(new Set(c.q.items('p1').map((i) => i.id)).size).toBe(2);
  });

  it('defers a prune that arrives before the stored queues are loaded', async () => {
    const kv = new MemoryKv();
    const a = await setup(kv);
    a.q.drive('live', agents('working'));
    await a.q.add('p1', 'kept');
    await a.q.add('p9', 'pane gone');
    const b = new PromptQueues(kv, 'srv|default', async () => {});
    await b.prune(new Set(['p1']));
    await b.load();
    expect(b.items('p1').map((i) => i.text)).toEqual(['kept']);
    expect(b.items('p9')).toEqual([]);
  });

  it('returns the same empty list until something is queued (for useSyncExternalStore)', async () => {
    const { q } = await setup();
    expect(q.items('p1')).toBe(q.items('p1'));
    expect(q.items('p1')).toBe(q.items('other'));
  });

  it('caps each pane queue', async () => {
    const { q } = await setup();
    q.drive('live', agents('working'));
    for (let i = 0; i < MAX_QUEUE; i++) await q.add('p1', `p${i}`);
    await expect(q.add('p1', 'one too many')).rejects.toThrow(/At most/);
  });
});
