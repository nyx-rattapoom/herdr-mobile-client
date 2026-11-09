/**
 * Defensive parsers for the herdr-core protocol (generation 1).
 *
 * The core's OpenRPC schema is the authority. Anything we do not understand is
 * kept out of the model instead of being coerced; unsafe uint64 values are an
 * explicit protocol error because JavaScript cannot round-trip them.
 */

export const CORE_GENERATION = 1;

export class CoreProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoreProtocolError';
  }
}

export class CoreUnsupportedError extends CoreProtocolError {
  constructor(
    code: string,
    message: string,
  ) {
    super(code, message);
    this.name = 'CoreUnsupportedError';
  }
}

export class CoreCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoreCommandError';
  }
}

type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export function safeUint(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new CoreProtocolError('unsafe_integer', `${what} is not a safe unsigned integer`);
  }
  return v;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function optCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
}

export type CoreStatus = {
  state: string;
  app?: string;
  title?: string;
  msg?: string;
  kind?: string | null;
  progress?: number | null;
};

export type CoreForeground = { pid: number; name: string; argv: string[]; cwd: string };

export type CoreTerminal = {
  address: string;
  name: string | null;
  title: string;
  labels: Record<string, string>;
  state: string;
  turn: number;
  status: CoreStatus | null;
  cols: number;
  rows: number;
  createdMs: number;
  finishedMs: number | null;
  exitCode: number | null;
  signal: number | null;
  reason: string | null;
  screen: string;
  keep: boolean;
  parent: string | null;
  foreground: CoreForeground | null;
  reported: boolean;
};

export type CoreHello = {
  generation: number;
  version: string;
  framed: boolean;
  methods: string[];
  features: string[];
  core: { id: string; name: string };
};

export type CoreAttach = {
  channel: number;
  terminal: CoreTerminal;
  resizeNotifications: boolean;
  automaticInput: boolean;
};

export type CoreSubscribe = {
  seq: number;
  terminals: CoreTerminal[];
  channel: number | null;
};

export function parseStatus(v: unknown): CoreStatus | null {
  if (!isObj(v)) return null;
  const state = str(v.state);
  if (!state) return null;
  return {
    state,
    ...(str(v.app) !== undefined ? { app: str(v.app) } : {}),
    ...(str(v.title) !== undefined ? { title: str(v.title) } : {}),
    ...(str(v.msg) !== undefined ? { msg: str(v.msg) } : {}),
    kind: str(v.kind) ?? null,
    progress: optCount(v.progress),
  };
}

function parseLabels(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

function parseForeground(v: unknown): CoreForeground | null {
  if (!isObj(v)) return null;
  const pid = optCount(v.pid);
  if (pid === null) return null;
  return {
    pid,
    name: str(v.name) ?? '',
    argv: Array.isArray(v.argv) ? v.argv.filter((x): x is string => typeof x === 'string') : [],
    cwd: str(v.cwd) ?? '',
  };
}

export function parseTerminal(v: unknown): CoreTerminal {
  if (!isObj(v)) throw new CoreProtocolError('record', 'terminal record is not an object');
  const address = str(v.address);
  if (!address) throw new CoreProtocolError('record', 'terminal record has no address');
  const state = str(v.state) ?? 'live';
  return {
    address,
    name: str(v.name) ?? null,
    title: str(v.title) ?? '',
    labels: parseLabels(v.labels),
    state,
    turn: v.turn === undefined ? 0 : safeUint(v.turn, 'terminal.turn'),
    status: parseStatus(v.status),
    cols: count(v.cols),
    rows: count(v.rows),
    createdMs: count(v.created_ms),
    finishedMs: optCount(v.finished_ms),
    exitCode: optCount(v.exit_code),
    signal: optCount(v.signal),
    reason: str(v.reason) ?? null,
    screen: str(v.screen) ?? 'exact',
    keep: bool(v.keep) === true,
    parent: str(v.parent) ?? null,
    foreground: parseForeground(v.foreground),
    reported: bool(v.reported) === true,
  };
}

export function parseHello(v: unknown): CoreHello {
  if (!isObj(v)) throw new CoreProtocolError('hello', 'hello result is not an object');
  const generation = safeUint(v.generation, 'hello.generation');
  const version = str(v.version);
  const core = v.core;
  const framed = bool(v.framed);
  const methods = v.methods;
  const features = v.features;
  if (!version) throw new CoreProtocolError('hello', 'hello result has no version');
  if (!isObj(core) || !str(core.id) || !str(core.name)) throw new CoreProtocolError('hello', 'hello result has no core identity');
  if (framed === undefined) throw new CoreProtocolError('hello', 'hello result has no framed flag');
  if (!Array.isArray(methods) || !methods.every((m) => typeof m === 'string')) {
    throw new CoreProtocolError('hello', 'hello result has no method list');
  }
  if (!Array.isArray(features) || !features.every((f) => typeof f === 'string')) {
    throw new CoreProtocolError('hello', 'hello result has no feature list');
  }
  return {
    generation,
    version,
    framed,
    methods: methods as string[],
    features: features as string[],
    core: { id: core.id as string, name: core.name as string },
  };
}

export function parseAttach(v: unknown): CoreAttach {
  if (!isObj(v)) throw new CoreProtocolError('attach', 'attach result is not an object');
  const channel = safeUint(v.channel, 'attach.channel');
  return {
    channel,
    terminal: parseTerminal(v.terminal),
    resizeNotifications: v.resize_notifications === true,
    automaticInput: v.automatic_input === true,
  };
}

export function parseSubscribe(v: unknown): CoreSubscribe {
  if (!isObj(v)) throw new CoreProtocolError('subscribe', 'subscribe result is not an object');
  const seq = safeUint(v.seq, 'subscribe.seq');
  const terminals = Array.isArray(v.terminals) ? v.terminals.map(parseTerminal) : [];
  const channel = typeof v.channel === 'number' ? safeUint(v.channel, 'subscribe.channel') : null;
  return { seq, terminals, channel };
}

export type CoreEventParams = {
  seq: number;
  type?: string;
  terminal?: string;
  machine?: string;
  data: unknown;
};

/** `event`, `heartbeat` and `missed` all carry a monotonic sequence. */
export function parseEventParams(v: unknown): CoreEventParams {
  if (!isObj(v)) throw new CoreProtocolError('event', 'event params are not an object');
  const seq = safeUint(v.seq, 'event.seq');
  return {
    seq,
    type: str(v.type),
    terminal: str(v.terminal),
    machine: str(v.machine),
    data: v.data,
  };
}

export function parseMissed(v: unknown): { seq: number; terminals: CoreTerminal[] } {
  if (!isObj(v)) throw new CoreProtocolError('missed', 'missed params are not an object');
  return {
    seq: safeUint(v.seq, 'missed.seq'),
    terminals: Array.isArray(v.terminals) ? v.terminals.map(parseTerminal) : [],
  };
}

export function parseDocGet(v: unknown): { value: unknown; version: number } {
  if (!isObj(v)) throw new CoreProtocolError('doc', 'doc.get result is not an object');
  return { value: v.value, version: safeUint(v.version, 'doc.version') };
}
