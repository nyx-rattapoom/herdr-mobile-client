import { HerdrClient } from '../protocol/client';
import { LiveSession, TREE_EVENTS } from '../live/LiveSession';
import type { AgentAlert } from '../live/agents';
import { FakeHerdr, legacyHerdr } from '../testing/fakes';

const snap = (panes: string[], agents: { pane_id: string; agent_status: string }[] = []) => ({
  type: 'session_snapshot',
  snapshot: {
    version: '0.9.3',
    workspaces: [{ workspace_id: 'w1', number: 1, label: 'main' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1 }],
    panes: panes.map((pane_id) => ({ pane_id, tab_id: 'w1:t1', workspace_id: 'w1' })),
    agents: agents.map((a) => ({ ...a, agent: 'fake' })),
  },
});

const settle = async (ms = 0) => {
  for (let i = 0; i < 20; i++) {
    jest.advanceTimersByTime(ms ? ms / 20 : 1);
    await Promise.resolve();
    await Promise.resolve();
  }
};

describe('LiveSession', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = () => {
    const server = new FakeHerdr((t) => new HerdrClient(t, 60_000));
    let current = snap(['w1:p1']);
    server.handlers['events.subscribe'] = () => ({ type: 'subscription_started' });
    server.handlers['session.snapshot'] = () => current;
    const alerts: AgentAlert[] = [];
    const live = new LiveSession(server.open, { debounceMs: 50, retryMs: 100, onAlert: (a) => alerts.push(a) });
    return { server, live, alerts, setSnap: (s: ReturnType<typeof snap>) => (current = s) };
  };

  it('subscribes to tree events and per-pane agent status, then reads the snapshot', async () => {
    const { server, live } = setup();
    void live.start();
    await settle(200);
    const st = live.getState();
    expect(st.status).toBe('live');
    expect(st.tree[0].tabs[0].panes[0].pane_id).toBe('w1:p1');
    const last = server.subscriptions[server.subscriptions.length - 1];
    const subs = (last.requests.find((r) => r.method === 'events.subscribe')!.params as { subscriptions: { type: string; pane_id?: string }[] }).subscriptions;
    expect(subs.filter((s) => !s.pane_id).map((s) => s.type)).toEqual([...TREE_EVENTS]);
    expect(subs.filter((s) => s.pane_id)).toEqual([{ type: 'pane.agent_status_changed', pane_id: 'w1:p1' }]);
    live.stop();
  });

  it('refreshes once per burst of events and resubscribes when panes change', async () => {
    const { server, live, setSnap } = setup();
    void live.start();
    await settle(200);
    const reads = () => server.connections.flatMap((c) => c.requests).filter((r) => r.method === 'session.snapshot').length;
    const before = reads();
    const sub = server.subscriptions[server.subscriptions.length - 1];
    setSnap(snap(['w1:p1', 'w1:p2']));
    server.emit(sub, 'pane_created', { pane: { pane_id: 'w1:p2' } });
    server.emit(sub, 'layout_updated', {});
    server.emit(sub, 'pane_updated', {});
    await settle(300);
    expect(reads() - before).toBeGreaterThanOrEqual(1);
    expect(reads() - before).toBeLessThanOrEqual(2);
    expect(live.getState().snapshot!.panes).toHaveLength(2);
    const newest = server.subscriptions[server.subscriptions.length - 1];
    expect(newest).not.toBe(sub);
    expect(sub.closed).toBe(true);
    live.stop();
  });

  it('applies agent status events immediately and raises alerts', async () => {
    const { server, live, alerts, setSnap } = setup();
    setSnap(snap(['w1:p1'], [{ pane_id: 'w1:p1', agent_status: 'working' }]));
    void live.start();
    await settle(200);
    const sub = server.subscriptions[server.subscriptions.length - 1];
    setSnap(snap(['w1:p1'], [{ pane_id: 'w1:p1', agent_status: 'blocked' }]));
    server.emit(sub, 'pane.agent_status_changed', { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked', agent: 'fake' });
    await Promise.resolve();
    expect(live.getState().agents.get('w1:p1')?.status).toBe('blocked');
    await settle(300);
    // The follow-up snapshot agrees, so no duplicate alert.
    expect(alerts).toEqual([{ kind: 'blocked', paneId: 'w1:p1', agent: 'fake', workspaceId: 'w1' }]);
    setSnap(snap(['w1:p1'], []));
    server.emit(sub, 'pane.agent_status_changed', { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' });
    await settle(300);
    expect(alerts.map((a) => a.kind)).toEqual(['blocked', 'completed']);
    live.stop();
  });

  it('does not alert for agents already blocked at connect, but does after a reconnect', async () => {
    const { server, live, alerts, setSnap } = setup();
    setSnap(snap(['w1:p1'], [{ pane_id: 'w1:p1', agent_status: 'blocked' }]));
    void live.start();
    await settle(200);
    expect(live.getState().agents.get('w1:p1')?.status).toBe('blocked');
    expect(alerts).toEqual([]);
    // Agent finishes and a new one blocks while the subscription is down.
    setSnap(snap(['w1:p1'], [{ pane_id: 'w1:p1', agent_status: 'working' }]));
    const sub = server.subscriptions[server.subscriptions.length - 1];
    server.emit(sub, 'pane_updated', {});
    await settle(300);
    setSnap(snap(['w1:p1'], [{ pane_id: 'w1:p1', agent_status: 'blocked' }]));
    sub.serverClose('eof');
    await settle(800);
    expect(alerts.map((a) => a.kind)).toEqual(['blocked']);
    live.stop();
  });

  it('reconnects with backoff after events_lost', async () => {
    const { server, live } = setup();
    void live.start();
    await settle(200);
    const sub = server.subscriptions[server.subscriptions.length - 1];
    sub.push('{"id":"req_1","error":{"code":"events_lost","message":"lagged"}}\n');
    await Promise.resolve();
    expect(live.getState().status).toBe('reconnecting');
    const count = server.subscriptions.length;
    await settle(500);
    expect(server.subscriptions.length).toBeGreaterThan(count);
    expect(live.getState().status).toBe('live');
    live.stop();
  });

  it('goes offline when the SSH session is gone', async () => {
    const { server, live } = setup();
    server.failOpen = { code: 'ERR_NO_SESSION', message: 'connection lost' };
    await live.start();
    expect(live.getState()).toMatchObject({ status: 'offline', error: 'connection lost' });
    live.stop();
  });

  it('request() refreshes the tree afterwards; query() does not', async () => {
    const { server, live } = setup();
    server.handlers['tab.create'] = () => ({ type: 'tab_created' });
    server.handlers['pane.read'] = () => ({ type: 'pane_read', read: { text: 'x' } });
    void live.start();
    await settle(200);
    const reads = () => server.connections.flatMap((c) => c.requests).filter((r) => r.method === 'session.snapshot').length;
    let before = reads();
    const q = live.query('pane.read', { pane_id: 'w1:p1' });
    await settle(200);
    await q;
    expect(reads()).toBe(before);
    before = reads();
    const r = live.request('tab.create', {});
    await settle(200);
    await r;
    expect(reads()).toBe(before + 1);
    live.stop();
  });

  it('uses a fresh connection per request, since Herdr closes each after one response', async () => {
    const { server, live } = setup();
    server.handlers['pane.read'] = () => ({ type: 'pane_read', read: { text: '' } });
    void live.start();
    await settle(200);
    // Back-to-back reads: the second must not go out on the connection the first one's EOF is about to close.
    const a = live.query('pane.read', { pane_id: 'w1:p1' });
    await settle(1);
    const b = live.query('pane.read', { pane_id: 'w1:p1' });
    await settle(50);
    await expect(a).resolves.toEqual({ type: 'pane_read', read: { text: '' } });
    await expect(b).resolves.toEqual({ type: 'pane_read', read: { text: '' } });
    for (const c of server.connections) expect(c.requests.filter((r) => r.method !== 'events.subscribe').length).toBeLessThanOrEqual(1);
    live.stop();
  });

  describe('against an older Herdr', () => {
    // Herdr 0.7.5 knows every type the app subscribes to except workspace.reordered.
    const known075 = [...TREE_EVENTS.filter((t) => t !== 'workspace.reordered'), 'pane.agent_status_changed'];
    const subscribeAttempts = (server: FakeHerdr) =>
      server.connections.filter((c) => c.requests.some((r) => r.method === 'events.subscribe')).length;

    it('stops with a too-old message before subscribing, and does not retry', async () => {
      const { server, live } = setup();
      legacyHerdr(server, known075);
      void live.start();
      await settle(200);
      const st = live.getState();
      expect(st.status).toBe('unsupported');
      expect(st.server).toEqual({ version: '0.7.5', protocol: 17 });
      expect(st.error).toMatch(/Herdr 0\.7\.5 on this server is too old; this app needs 0\.8\.0 or newer/);
      const opened = server.connections.length;
      await settle(60_000);
      expect(server.connections.length).toBe(opened);
      expect(subscribeAttempts(server)).toBe(0);
      live.stop();
    });

    it('continues anyway by dropping the event types the server rejects', async () => {
      const { server, live } = setup();
      legacyHerdr(server, known075);
      void live.start();
      await settle(200);
      live.continueAnyway();
      await settle(200);
      const st = live.getState();
      expect(st.status).toBe('live');
      expect(st.droppedEvents).toEqual(['workspace.reordered']);
      expect(st.tree[0].tabs[0].panes[0].pane_id).toBe('w1:p1');
      const sub = server.subscriptions[server.subscriptions.length - 1];
      const types = (sub.requests[0].params as { subscriptions: { type: string }[] }).subscriptions.map((s) => s.type);
      expect(types).not.toContain('workspace.reordered');
      expect(types).toContain('pane.agent_status_changed');
      // Only the first subscription named it; resubscriptions (e.g. for new panes) leave it out.
      const named = server.connections
        .flatMap((c) => c.requests)
        .filter((r) => r.method === 'events.subscribe')
        .map((r) =>
          (r.params as { subscriptions: { type: string }[] }).subscriptions.some(
            (x) => x.type === 'workspace.reordered',
          ),
        );
      expect(named[0]).toBe(true);
      expect(named.slice(1)).not.toContain(true);
      expect(named.length).toBeGreaterThan(2);
      live.stop();
    });

    it('drops rejected event types on a current version too, so new optional events stay optional', async () => {
      const { server, live } = setup();
      legacyHerdr(server, known075, '0.8.0');
      void live.start();
      await settle(200);
      expect(live.getState()).toMatchObject({ status: 'live', droppedEvents: ['workspace.reordered'] });
      live.stop();
    });

    it('treats any other uncorrelated invalid_request as fatal instead of reconnecting forever', async () => {
      const { server, live } = setup();
      server.uncorrelatedInvalid = true;
      server.handlers['events.subscribe'] = () => {
        throw { code: 'invalid_request', message: 'invalid request: missing field `type`' };
      };
      void live.start();
      await settle(200);
      const st = live.getState();
      expect(st.status).toBe('unsupported');
      expect(st.error).toMatch(/rejected a request from the app \(invalid request: missing field `type`\)/);
      const attempts = subscribeAttempts(server);
      await settle(60_000);
      expect(subscribeAttempts(server)).toBe(attempts);
      live.stop();
    });
  });

  it('whenSettled resolves once the first snapshot is in, or with the current state on timeout', async () => {
    const { server, live } = setup();
    const settled = live.whenSettled(5_000);
    void live.start();
    await settle(200);
    await expect(settled).resolves.toMatchObject({ status: 'live' });
    live.stop();

    // Never started, so it stays connecting.
    const stuck = new LiveSession(server.open);
    const timedOut = stuck.whenSettled(1_000);
    await settle(1_200);
    await expect(timedOut).resolves.toMatchObject({ status: 'connecting' });
  });
});
