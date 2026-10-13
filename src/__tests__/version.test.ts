import {
  MIN_HERDR_VERSION,
  checkVersion,
  compareVersions,
  parseUnknownVariant,
  parseVersion,
} from '../protocol/version';

describe('Herdr version', () => {
  it('parses release strings', () => {
    expect(parseVersion('0.9.3')).toEqual([0, 9, 3]);
    expect(parseVersion('v0.10.0-rc.1')).toEqual([0, 10, 0]);
    expect(parseVersion('1.2')).toEqual([1, 2, 0]);
    expect(parseVersion('dev')).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.7.5', '0.8.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.3')).toBeGreaterThan(0);
    expect(compareVersions('0.8.0', MIN_HERDR_VERSION)).toBe(0);
    expect(compareVersions('x', '0.8.0')).toBeNull();
  });

  it('rejects only a known version below the minimum', () => {
    expect(() => checkVersion({ version: '0.7.5', protocol: 17 })).toThrow(
      expect.objectContaining({ code: 'unsupported_version', message: expect.stringContaining('Herdr 0.7.5') }),
    );
    expect(() => checkVersion({ version: '0.7.5' })).toThrow(/needs 0\.8\.0 or newer.*herdr update/);
    expect(() => checkVersion({ version: '0.8.0' })).not.toThrow();
    expect(() => checkVersion({ version: '0.9.3' })).not.toThrow();
    expect(() => checkVersion({})).not.toThrow();
    expect(() => checkVersion({ version: 'unknown' })).not.toThrow();
  });

  it('reads the unknown and accepted names from a serde rejection', () => {
    const msg =
      'invalid request: unknown variant `workspace.reordered`, expected one of `workspace.created`, `pane.agent_status_changed`';
    expect(parseUnknownVariant(msg)).toEqual({
      unknown: 'workspace.reordered',
      expected: ['workspace.created', 'pane.agent_status_changed'],
    });
    expect(parseUnknownVariant('invalid request: missing field `pane_id`')).toBeNull();
  });
});
