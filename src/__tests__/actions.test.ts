import {
  actionRequest,
  actionsFor,
  confirmText,
  describeActionError,
  inputRequest,
  keyRequest,
  SPECIAL_KEYS,
  type Target,
} from '../live/actions';

const pane = { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' };
const tab = { tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'logs', panes: [pane] };
const ws = { workspace_id: 'w1', number: 1, label: 'api', tabs: [tab] };

const t = {
  session: { kind: 'session' } as Target,
  ws: { kind: 'workspace', node: ws } as Target,
  tab: { kind: 'tab', node: tab } as Target,
  pane: { kind: 'pane', node: pane } as Target,
};

describe('actions', () => {
  it('offers focus/create/close per level; closes are destructive', () => {
    expect(actionsFor(t.session).map((a) => a.id)).toEqual(['workspace.create']);
    expect(actionsFor(t.pane).map((a) => a.id)).toEqual(['pane.focus', 'pane.split_right', 'pane.split_down', 'pane.close']);
    for (const target of Object.values(t)) {
      for (const a of actionsFor(target)) expect(Boolean(a.destructive)).toBe(a.id.endsWith('.close'));
    }
  });

  it('builds socket requests', () => {
    expect(actionRequest('workspace.create', t.session, { label: '  api ' })).toEqual({
      method: 'workspace.create',
      params: { focus: false, label: 'api' },
    });
    expect(actionRequest('workspace.create', t.session, { label: ' ' }).params).toEqual({ focus: false });
    expect(actionRequest('workspace.close', t.ws)).toEqual({ method: 'workspace.close', params: { workspace_id: 'w1' } });
    expect(actionRequest('tab.create', t.pane, { label: 'x' })).toEqual({
      method: 'tab.create',
      params: { workspace_id: 'w1', focus: false, label: 'x' },
    });
    expect(actionRequest('tab.close', t.tab)).toEqual({ method: 'tab.close', params: { tab_id: 'w1:t1' } });
    expect(actionRequest('pane.split_down', t.pane)).toEqual({
      method: 'pane.split',
      params: { target_pane_id: 'w1:p2', direction: 'down', focus: false },
    });
    expect(actionRequest('pane.close', t.pane)).toEqual({ method: 'pane.close', params: { pane_id: 'w1:p2' } });
  });

  it('rejects actions that do not apply to the target', () => {
    expect(() => actionRequest('pane.close', t.tab)).toThrow('does not apply');
    expect(() => actionRequest('workspace.close', t.session)).toThrow('does not apply');
  });

  it('confirmation text says what will be terminated', () => {
    const close = actionsFor(t.ws).find((a) => a.id === 'workspace.close')!;
    expect(confirmText(close, t.ws)).toBe('Close workspace api with 1 tab(s) and 1 pane(s)? Their processes will be terminated.');
    expect(confirmText(close, t.pane)).toMatch(/Close pane w1:p2\?/);
  });

  it('builds input requests', () => {
    expect(inputRequest('p', 'ls', 'type')).toEqual({ method: 'pane.send_text', params: { pane_id: 'p', text: 'ls' } });
    expect(inputRequest('p', 'ls', 'submit')).toEqual({ method: 'pane.send_input', params: { pane_id: 'p', text: 'ls', keys: ['enter'] } });
    expect(inputRequest('p', 'fix it', 'prompt')).toEqual({ method: 'agent.prompt', params: { target: 'p', text: 'fix it' } });
    expect(keyRequest('p', 'ctrl+c')).toEqual({ method: 'pane.send_keys', params: { pane_id: 'p', keys: ['ctrl+c'] } });
    expect(new Set(SPECIAL_KEYS.map((k) => k.key)).size).toBe(SPECIAL_KEYS.length);
  });

  it('explains common errors', () => {
    expect(describeActionError({ code: 'agent_blocked', message: 'x' })).toMatch(/blocked/);
    expect(describeActionError({ code: 'other', message: 'boom' })).toBe('boom');
  });
});
