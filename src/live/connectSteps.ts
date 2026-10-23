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
  step: number;
  target: string;
  startedAt: number;
  notes: Partial<Record<number, string>>;
};

export const stepLabel = (step: number) => `Step ${step + 1} of ${CONNECT_STEPS.length} · ${CONNECT_STEPS[step]}`;

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

export const progressFraction = (step: number) => Math.min(1, (step + 0.5) / CONNECT_STEPS.length);

export function parseHerdrVersion(out: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(out);
  return m ? m[1] : null;
}
