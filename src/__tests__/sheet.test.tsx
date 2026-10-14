import { Text, StyleSheet } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BottomSheet, CenteredDialog, overlayInsets } from '../screens/Sheet';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// A landscape phone with the navigation bar on the right, plus a status bar and gesture handle.
const metrics = {
  frame: { x: 0, y: 0, width: 891, height: 411 },
  insets: { top: 24, bottom: 16, left: 0, right: 48 },
};

function render(el: React.ReactElement) {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(<SafeAreaProvider initialMetrics={metrics}>{el}</SafeAreaProvider>);
  });
  return r!;
}

/** The style of the native view with this testID. */
const flat = (r: ReactTestRenderer, testID: string) =>
  StyleSheet.flatten(r.root.find((n) => n.props.testID === testID && typeof n.type === 'string').props.style);

describe('overlayInsets', () => {
  it('pads the backdrop for the top and side bars and the panel for the bottom bar', () => {
    expect(overlayInsets({ top: 24, bottom: 48, left: 0, right: 0 }, 28)).toEqual({
      backdrop: { paddingTop: 24, paddingLeft: 0, paddingRight: 0 },
      panel: { paddingBottom: 76 },
    });
    expect(overlayInsets({ top: 0, bottom: 0, left: 48, right: 0 }, 28).backdrop.paddingLeft).toBe(48);
  });
});

describe('BottomSheet', () => {
  it('keeps its rows above the navigation bar and away from the side bar', () => {
    const r = render(
      <BottomSheet onClose={() => {}} testID="panel" style={{ maxHeight: '80%' }}>
        <Text>last row</Text>
      </BottomSheet>,
    );
    const panel = flat(r, 'panel');
    expect(panel.paddingBottom).toBe(28 + 16);
    expect(panel.maxHeight).toBe('80%');
    const backdrop = flat(r, 'sheet-backdrop');
    expect(backdrop).toMatchObject({ paddingTop: 24, paddingRight: 48, paddingLeft: 0 });
  });

  it('opens its modal edge-to-edge so the insets above apply', () => {
    const r = render(
      <BottomSheet onClose={() => {}}>
        <Text>x</Text>
      </BottomSheet>,
    );
    const modal = r.root.find((n) => n.props.statusBarTranslucent !== undefined);
    expect(modal.props).toMatchObject({ statusBarTranslucent: true, navigationBarTranslucent: true });
  });
});

describe('CenteredDialog', () => {
  it('pads every edge outside the keyboard-avoiding view', () => {
    const r = render(
      <CenteredDialog onClose={() => {}}>
        <Text>dialog</Text>
      </CenteredDialog>,
    );
    const outer = r.root.findAll((n) => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.paddingRight === 64);
    expect(outer.length).toBeGreaterThan(0);
    expect(StyleSheet.flatten(outer[0].props.style)).toMatchObject({ paddingTop: 40, paddingBottom: 32, paddingLeft: 16 });
  });
});
