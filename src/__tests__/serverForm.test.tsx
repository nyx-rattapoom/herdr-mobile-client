import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ServerFormScreen } from '../screens/ServerFormScreen';
import type { ServerProfile } from '../store/servers';

const base: Omit<React.ComponentProps<typeof ServerFormScreen>, 'initial'> = {
  devicePublicKey: null,
  jumpOptions: [],
  onCancel: () => {},
  onSave: async () => {},
  onShowKey: () => {},
};

const coreProfile: ServerProfile = {
  id: 'c1',
  label: 'core',
  host: 'box',
  port: 22,
  username: 'u',
  auth: 'key',
  backend: 'core',
  herdrPath: '~/bin/herdr',
  hcPath: '~/bin/hc',
};

function render(el: React.ReactElement): ReactTestRenderer {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(el);
  });
  return r!;
}

function texts(r: ReactTestRenderer): string {
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    const node = n as { children?: unknown[] };
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  r.root.children.forEach(visit);
  return out.join('\n');
}

describe('ServerFormScreen backend selection', () => {
  const original = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  });

  const setOs = (os: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

  it('keeps Herdr TUI as the default for a new profile', () => {
    setOs('android');
    const r = render(<ServerFormScreen {...base} />);
    expect(r.root.findByProps({ testID: 'backend-legacy' })).toBeTruthy();
    expect(r.root.findByProps({ testID: 'backend-core' }).props.disabled).toBe(false);
    expect(texts(r)).toContain('This stays the default for new and existing profiles.');
  });

  it('gates Core on iOS before any native Core call and explains the Android-only limitation', () => {
    setOs('ios');
    const r = render(<ServerFormScreen {...base} initial={coreProfile} />);
    expect(r.root.findByProps({ testID: 'backend-core' }).props.disabled).toBe(true);
    expect(texts(r)).toContain('Herdr Core is Android-only for now.');
    expect(texts(r)).toContain('choose Herdr TUI to use it here.');
    expect(r.root.findAll((n) => n.props.testID === 'field-hc' && typeof n.type === 'string')).toHaveLength(1);
  });

  it('shows the Core transport explanation and an independent hc path on Android', () => {
    setOs('android');
    const r = render(<ServerFormScreen {...base} initial={coreProfile} />);
    expect(r.root.findByProps({ testID: 'backend-core' }).props.disabled).toBe(false);
    expect(r.root.findAll((n) => n.props.testID === 'field-hc' && typeof n.type === 'string')).toHaveLength(1);
    expect(r.root.findByProps({ testID: 'field-hc' }).props.value).toBe('~/bin/hc');
    expect(r.root.findByProps({ testID: 'field-herdr' }).props.value).toBe('~/bin/herdr');
    expect(texts(r)).toContain('streams terminal output');
  });
});
