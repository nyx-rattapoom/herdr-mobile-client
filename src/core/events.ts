import { isObj, parseEventParams, parseMissed, parseStatus, parseTerminal, safeUint, type CoreTerminal } from './types';

export type CoreDocStamp = { name: string; machine: string | null; version: number };

export type CoreState = {
  seq: number;
  /** Keyed by the machine-qualified address the core reports (`t7`, `rohan/t7`). */
  terminals: Map<string, CoreTerminal>;
};

export const emptyCoreState = (): CoreState => ({ seq: 0, terminals: new Map() });

export type CoreReduction = {
  state: CoreState;
  /** Documents whose version changed; read them again with doc.get (never doc.set). */
  docs: CoreDocStamp[];
  missed: boolean;
};

function copy(t: CoreTerminal): CoreTerminal {
  return { ...t, labels: { ...t.labels } };
}

function withTerminal(state: CoreState, terminal: CoreTerminal): CoreState {
  const terminals = new Map(state.terminals);
  terminals.set(terminal.address, terminal);
  return { ...state, terminals };
}

function patch(state: CoreState, address: string, fn: (t: CoreTerminal) => CoreTerminal): CoreState {
  const t = state.terminals.get(address);
  if (!t) return state;
  return withTerminal(state, fn(copy(t)));
}

/**
 * Apply one `events.subscribe` notification.
 *
 * `seq` is monotonic per core process. Repeated or older events are ignored;
 * `missed` replaces the snapshot instead of merging it.
 */
export function reduceNotification(state: CoreState, method: string, params: Record<string, unknown>): CoreReduction {
  if (method === 'heartbeat') {
    const seq = safeUint(params.seq, 'heartbeat.seq');
    return { state: seq > state.seq ? { ...state, seq } : state, docs: [], missed: false };
  }
  if (method === 'missed') {
    const missed = parseMissed(params);
    const terminals = new Map<string, CoreTerminal>();
    for (const t of missed.terminals) terminals.set(t.address, t);
    return { state: { seq: missed.seq, terminals }, docs: [], missed: true };
  }
  if (method !== 'event') return { state, docs: [], missed: false };

  const ev = parseEventParams(params);
  if (ev.seq <= state.seq) return { state, docs: [], missed: false };
  const base: CoreState = { ...state, seq: ev.seq };
  if (!ev.type || !ev.terminal) {
    // A doc event (or an event without a terminal) only advances the sequence.
    const docs: CoreDocStamp[] = [];
    if (ev.type === 'doc' && isObj(ev.data) && typeof ev.data.name === 'string') {
      docs.push({ name: ev.data.name, machine: ev.machine ?? null, version: typeof ev.data.version === 'number' ? ev.data.version : 0 });
    }
    return { state: base, docs, missed: false };
  }

  const address = ev.terminal;
  const data = isObj(ev.data) ? ev.data : {};
  switch (ev.type) {
    case 'created':
    case 'restarted':
      return { state: withTerminal(base, parseTerminal(data)), docs: [], missed: false };
    case 'lost':
      return {
        state: patch(base, address, (t) => ({
          ...t,
          state: 'live',
          reason: typeof data.reason === 'string' ? data.reason : t.reason,
          exitCode: typeof data.exit_code === 'number' ? data.exit_code : t.exitCode,
          signal: typeof data.signal === 'number' ? data.signal : t.signal,
          finishedMs: null,
          foreground: null,
        })),
        docs: [],
        missed: false,
      };
    case 'keep':
      return { state: patch(base, address, (t) => ({ ...t, keep: data.keep === true })), docs: [], missed: false };
    case 'finished':
      return {
        state: patch(base, address, (t) => ({
          ...t,
          state: 'finished',
          reason: typeof data.reason === 'string' ? data.reason : t.reason,
          exitCode: typeof data.exit_code === 'number' ? data.exit_code : t.exitCode,
          signal: typeof data.signal === 'number' ? data.signal : t.signal,
          finishedMs: typeof data.finished_ms === 'number' ? data.finished_ms : Date.now(),
          foreground: null,
          status: null,
        })),
        docs: [],
        missed: false,
      };
    case 'status':
      return {
        state: patch(base, address, (t) => ({
          ...t,
          status: parseStatus(data.status),
          reported: data.reported === true,
        })),
        docs: [],
        missed: false,
      };
    case 'turn':
      return {
        state: patch(base, address, (t) => ({ ...t, turn: safeUint(data.turn, 'turn.turn') })),
        docs: [],
        missed: false,
      };
    case 'title':
      return {
        state: patch(base, address, (t) => ({ ...t, title: typeof data.title === 'string' ? data.title : t.title })),
        docs: [],
        missed: false,
      };
    case 'labels': {
      const labels: Record<string, string> = {};
      if (isObj(data.labels)) {
        for (const [k, v] of Object.entries(data.labels)) if (typeof v === 'string') labels[k] = v;
      }
      if (isObj(data.record)) {
        const record = parseTerminal(data.record);
        return { state: withTerminal(base, { ...record, labels }), docs: [], missed: false };
      }
      return { state: patch(base, address, (t) => ({ ...t, labels })), docs: [], missed: false };
    }
    case 'size':
      return {
        state: patch(base, address, (t) => ({
          ...t,
          cols: typeof data.cols === 'number' ? data.cols : t.cols,
          rows: typeof data.rows === 'number' ? data.rows : t.rows,
        })),
        docs: [],
        missed: false,
      };
    case 'foreground':
      return {
        state: patch(base, address, (t) => ({
          ...t,
          foreground:
            isObj(data) && typeof data.pid === 'number'
              ? {
                  pid: data.pid,
                  name: typeof data.name === 'string' ? data.name : '',
                  argv: Array.isArray(data.argv) ? data.argv.filter((x): x is string => typeof x === 'string') : [],
                  cwd: typeof data.cwd === 'string' ? data.cwd : '',
                }
              : null,
        })),
        docs: [],
        missed: false,
      };
    case 'removed': {
      const terminals = new Map(base.terminals);
      terminals.delete(address);
      return { state: { ...base, terminals }, docs: [], missed: false };
    }
    case 'doc': {
      const docs: CoreDocStamp[] = [];
      if (typeof data.name === 'string') {
        docs.push({ name: data.name, machine: ev.machine ?? null, version: typeof data.version === 'number' ? data.version : 0 });
      }
      return { state: base, docs, missed: false };
    }
    default:
      // Unknown event types advance the sequence but never mutate the model.
      return { state: base, docs: [], missed: false };
  }
}
