/** The steps of opening a server, in order. Shown as "Step n of 6". */
export const CONNECT_STEPS = [
  'SSH handshake',
  'Host key check',
  'Authenticating',
  'Checking Herdr',
  'Listing sessions',
  'Loading snapshot',
] as const;

export type ConnectStep = (typeof CONNECT_STEPS)[number];

export type ConnectProgress = {
  /** Index into CONNECT_STEPS of the step in progress. */
  step: number;
  /** `user@host:port`. */
  target: string;
  /** Date.now() when the connection attempt began. */
  startedAt: number;
  /** Short result notes for finished steps, e.g. `herdr 0.9.3`. */
  notes: Partial<Record<number, string>>;
};

export const stepLabel = (step: number) => `Step ${step + 1} of ${CONNECT_STEPS.length} · ${CONNECT_STEPS[step]}`;

/** A failure during one connect step; the message names the step. */
export class ConnectStepError extends Error {
  readonly code?: string;
  constructor(
    readonly step: number,
    readonly cause: unknown,
    detail: string,
  ) {
    super(`${stepLabel(step)} failed: ${detail}`);
    this.name = 'ConnectStepError';
    this.code = (cause as { code?: string })?.code;
  }
}

/** Fraction of the bar to fill: finished steps plus half of the current one. */
export const progressFraction = (step: number) => Math.min(1, (step + 0.5) / CONNECT_STEPS.length);

/** `herdr 0.9.3` → `0.9.3`; null when the output has no version. */
export function parseHerdrVersion(out: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(out);
  return m ? m[1] : null;
}
