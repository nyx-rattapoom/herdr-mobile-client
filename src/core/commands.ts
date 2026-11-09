import { validateHerdrPath } from '../protocol/sessions';
import { CoreCommandError } from './types';

/** Distinct remote exit code so "no hc" is never mistaken for a protocol loss. */
export const CORE_EXIT_NO_HC = 97;

const hcExpr = (p: string) => (p.startsWith('~/') ? `"$HOME"/${p.slice(2)}` : p);

/**
 * Resolve `hc` on the server and replace the shell with `hc connect`.
 *
 * The stream is a no-PTY exec channel: stdin and stdout are the protocol.
 * `hcPath` is checked with the same validator as the profile form, so stored
 * data can never add shell syntax. Nothing is installed or upgraded remotely.
 */
export function coreConnectCommand(hcPath?: string): string {
  const pathErr = validateHerdrPath(hcPath ?? '');
  if (pathErr) throw new CoreCommandError('hc_path_invalid', `hc path: ${pathErr}`);
  const configured = hcPath?.trim() ? hcExpr(hcPath.trim()) : '';
  const script = [
    'H=""',
    configured ? `[ -x ${configured} ] && H=${configured}` : ':',
    '[ -z "$H" ] && H="$(command -v hc 2>/dev/null || true)"',
    '[ -z "$H" ] && [ -n "${SHELL:-}" ] && H="$("$SHELL" -lc "command -v hc" </dev/null 2>/dev/null | tail -n 1 | grep "^/" || true)"',
    '[ -z "$H" ] && [ -x "$HOME/.local/bin/hc" ] && H="$HOME/.local/bin/hc"',
    `[ -z "$H" ] && exit ${CORE_EXIT_NO_HC}`,
    'exec "$H" connect',
  ].join('; ');
  if (/['\n]/.test(script)) throw new Error('hc connect command must not contain single quotes or newlines');
  return `sh -c '${script}'`;
}

export type CoreCloseInfo = { reason: string; exitCode: number | null; stderr: string };

const NO_HC =
  'Herdr Core needs `hc` on the server, but it was not found. Install the herdr-core package there (the app never installs or upgrades it), or set the hc path on this profile.';
const NOT_EXEC = 'The configured hc path is not executable on the server. Check the hc path on this profile.';

/** Turn a closed exec channel into a backend-specific, actionable error. */
export function explainCoreClose(info: CoreCloseInfo): CoreCommandError {
  const err = info.stderr.trim();
  if (info.exitCode === CORE_EXIT_NO_HC || info.exitCode === 127 || /hc: (not found|No such file)/i.test(err)) {
    return new CoreCommandError('hc_missing', NO_HC);
  }
  if (info.exitCode === 126 || /Permission denied/i.test(err)) return new CoreCommandError('hc_not_executable', NOT_EXEC);
  const detail = err.split('\n').filter(Boolean).slice(-2).join(' ');
  return new CoreCommandError(
    'core_closed',
    detail ? `Herdr Core closed the connection: ${detail}` : `Herdr Core closed the connection (${info.reason}).`,
  );
}

/** A protocol banner or shell noise is a Core error, never a legacy fallback. */
export function explainStrayStdout(text: string): CoreCommandError {
  const first = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return new CoreCommandError(
    'hc_stdout',
    `Herdr Core sent something other than protocol JSON${first ? ` (starts with "${first}")` : ''}. Check that hc on the server is the herdr-core CLI and that your shell startup files do not print to stdout.`,
  );
}
