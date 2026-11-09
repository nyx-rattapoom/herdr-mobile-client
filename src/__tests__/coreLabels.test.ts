import { attentionOf, compareTerminals, isPinned, pinnedLabels, seenMarkUnread, seenOf, seenRaise } from '../core/labels';
import type { CoreTerminal } from '../core/types';

const terminal = (over: Partial<CoreTerminal> = {}): CoreTerminal => ({
  address: 't7',
  name: null,
  title: 'agent',
  labels: {},
  state: 'live',
  turn: 0,
  status: { state: 'idle' },
  cols: 80,
  rows: 24,
  createdMs: 0,
  finishedMs: null,
  exitCode: null,
  signal: null,
  reason: null,
  screen: 'exact',
  keep: false,
  parent: null,
  foreground: null,
  reported: true,
  ...over,
});

describe('shared seen label', () => {
  it('reads only a complete unsigned turn and treats a missing label as null, not zero', () => {
    expect(seenOf(terminal())).toBeNull();
    expect(seenOf(terminal({ labels: { 'herdr.seen': '' } }))).toBeNull();
    expect(seenOf(terminal({ labels: { 'herdr.seen': '-1' } }))).toBeNull();
    expect(seenOf(terminal({ labels: { 'herdr.seen': '1.5' } }))).toBeNull();
    expect(seenOf(terminal({ labels: { 'herdr.seen': '3' } }))).toBe(3);
  });

  it('uses blocked/error/working words, then done when turn is above seen', () => {
    expect(attentionOf(terminal({ status: { state: 'blocked' } }))).toBe('needs');
    expect(attentionOf(terminal({ status: { state: 'error' } }))).toBe('needs');
    expect(attentionOf(terminal({ status: { state: 'working' }, turn: 5, labels: { 'herdr.seen': '5' } }))).toBe('working');
    expect(attentionOf(terminal({ status: { state: 'done' }, turn: 5, labels: { 'herdr.seen': '4' } }))).toBe('done');
    expect(attentionOf(terminal({ status: { state: 'done' }, turn: 5, labels: { 'herdr.seen': '5' } }))).toBe('idle');
    expect(attentionOf(terminal({ status: null, turn: 5, labels: { 'herdr.seen': '5' } }))).toBe('unknown');
    expect(attentionOf(terminal({ state: 'finished' }))).toBe('finished');
  });

  it('treats a missing or invalid seen label as never seen, not as turn 0', () => {
    expect(attentionOf(terminal({ status: { state: 'done' }, turn: 4 }))).toBe('done');
    expect(attentionOf(terminal({ status: { state: 'done' }, turn: 4, labels: { 'herdr.seen': 'x' } }))).toBe('done');
    expect(attentionOf(terminal({ status: { state: 'idle' }, turn: 0 }))).toBe('idle');
  });

  it('raises seen once per reached turn and never lowers it', () => {
    expect(seenRaise(terminal({ turn: 0 }), null)).toBe(0);
    expect(seenRaise(terminal({ turn: 3, labels: { 'herdr.seen': '2' } }), null)).toBe(3);
    expect(seenRaise(terminal({ turn: 3, labels: { 'herdr.seen': '3' } }), null)).toBeNull();
    expect(seenRaise(terminal({ turn: 3 }), 3)).toBeNull();
    expect(seenRaise(terminal({ state: 'finished', turn: 4 }), null)).toBeNull();
  });

  it('marks a seen terminal unread with the one lower write, and nothing that is already unread', () => {
    expect(seenMarkUnread(terminal({ turn: 4, labels: { 'herdr.seen': '4' } }))).toBe(3);
    expect(seenMarkUnread(terminal({ turn: 4, labels: { 'herdr.seen': '9' } }))).toBe(3);
    expect(seenMarkUnread(terminal({ turn: 4, labels: { 'herdr.seen': '2' } }))).toBeNull();
    expect(seenMarkUnread(terminal({ turn: 4 }))).toBeNull();
    expect(seenMarkUnread(terminal({ turn: 0, labels: { 'herdr.seen': '0' } }))).toBeNull();
    // After marking, the terminal reads as done (unread) and offers nothing more to mark.
    const marked = terminal({ status: { state: 'done' }, turn: 4, labels: { 'herdr.seen': '3' } });
    expect(attentionOf(marked)).toBe('done');
    expect(seenMarkUnread(marked)).toBeNull();
    expect(seenMarkUnread(terminal({ state: 'finished', turn: 3, labels: { 'herdr.seen': '3' } }))).toBeNull();
  });
});

describe('pins', () => {
  it('writes an empty string to unpin and any non-empty value means pinned', () => {
    expect(pinnedLabels(true)).toEqual({ 'herdr.pinned': '1' });
    expect(pinnedLabels(false)).toEqual({ 'herdr.pinned': '' });
    expect(isPinned(terminal({ labels: { 'herdr.pinned': '1' } }))).toBe(true);
    expect(isPinned(terminal({ labels: { 'herdr.pinned': 'agent' } }))).toBe(true);
    expect(isPinned(terminal({ labels: { 'herdr.pinned': '' } }))).toBe(false);
    expect(isPinned(terminal())).toBe(false);
  });

  it('sorts pinned, then attention order', () => {
    const pinned = terminal({ address: 'z', labels: { 'herdr.pinned': '1' }, status: { state: 'idle' } });
    const needs = terminal({ address: 'a', status: { state: 'blocked' } });
    const done = terminal({ address: 'b', status: { state: 'done' }, turn: 2, labels: { 'herdr.seen': '1' } });
    const working = terminal({ address: 'c', status: { state: 'working' } });
    const idle = terminal({ address: 'd', status: { state: 'idle' } });
    const list = [idle, working, done, needs, pinned].sort((x, y) => compareTerminals(x, y));
    expect(list.map((t) => t.address)).toEqual(['z', 'a', 'b', 'c', 'd']);
  });
});
