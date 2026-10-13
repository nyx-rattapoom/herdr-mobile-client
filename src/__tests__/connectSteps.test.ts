import { CONNECT_STEPS, ConnectStepError, parseHerdrVersion, progressFraction, stepLabel } from '../live/connectSteps';
import { versionCommand } from '../protocol/sessions';

describe('connect steps', () => {
  it('has the six steps in order', () => {
    expect(CONNECT_STEPS).toEqual([
      'SSH handshake',
      'Host key check',
      'Authenticating',
      'Checking Herdr',
      'Listing sessions',
      'Loading snapshot',
    ]);
  });

  it('names the failed step in the error and keeps the native code', () => {
    const cause = Object.assign(new Error('auth fail'), { code: 'ERR_AUTH' });
    const e = new ConnectStepError(2, cause, 'Authentication failed.');
    expect(e.message).toBe('Step 3 of 6 · Authenticating failed: Authentication failed.');
    expect(e.code).toBe('ERR_AUTH');
    expect(stepLabel(5)).toBe('Step 6 of 6 · Loading snapshot');
  });

  it('fills the bar by finished steps plus half the current one', () => {
    expect(progressFraction(0)).toBeCloseTo(0.5 / 6);
    expect(progressFraction(5)).toBeCloseTo(5.5 / 6);
  });

  it('reads the version from herdr --version output', () => {
    expect(parseHerdrVersion('herdr 0.9.3\n')).toBe('0.9.3');
    expect(parseHerdrVersion('herdr 0.10.0-rc.1')).toBe('0.10.0-rc.1');
    expect(parseHerdrVersion('')).toBeNull();
  });

  it('builds a version command that is safe to wrap in sh -c', () => {
    const cmd = versionCommand('~/bin/herdr');
    expect(cmd.startsWith("sh -c '")).toBe(true);
    expect(cmd.slice(7, -1)).not.toMatch(/['\n]/);
    expect(cmd).toContain('--version');
  });
});
