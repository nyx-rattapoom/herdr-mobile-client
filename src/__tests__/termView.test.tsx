import { useState } from 'react';
import { Pressable } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useCellMetrics, type CellMetrics } from '../screens/TermView';

describe('useCellMetrics', () => {
  it('keeps one metrics object across renders, so memoized rows are not redrawn', () => {
    const seen: CellMetrics[] = [];
    function Probe() {
      const [n, setN] = useState(0);
      seen.push(useCellMetrics(12).metrics);
      return <Pressable testID="again" onPress={() => setN(n + 1)} />;
    }
    let r: ReactTestRenderer | undefined;
    act(() => {
      r = create(<Probe />);
    });
    const again = () => act(() => r!.root.findByProps({ testID: 'again' }).props.onPress());
    again();
    again();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
    act(() => r!.unmount());
  });
});
