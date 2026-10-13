import { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { parseAnsi } from '../live/ansi';
import { layoutLine, type GridLine } from '../live/grid';
import { usePaneOutput } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import { TERM_BG, TERM_FG, TermRow, useCellMetrics } from './TermView';
import { ErrorBox, colors, styles } from './ui';

const FONT_SIZE = 12;
const PAD = 8;

type Props = {
  live: LiveSession;
  paneId: string;
  /** Rendered under the output (M3 input bar). */
  /** `blank`: output was read and nothing is drawn yet. */
  footer?: (pokeNow: () => void, blank: boolean) => React.ReactNode;
  /** Floating controls drawn over the output (e.g. the / button). */
  overlay?: (pokeNow: () => void) => React.ReactNode;
};

/** A pane's output, followed live, with an optional footer (the composer). */
export function PaneView({ live, paneId, footer, overlay }: Props) {
  const { output, error, reader } = usePaneOutput(live, paneId);
  const lines = useMemo(() => {
    const parsed = parseAnsi(output?.text ?? '');
    // pane.read output ends with the cursor line; drop a trailing empty line.
    if (parsed.length > 1 && parsed[parsed.length - 1].length === 0) parsed.pop();
    return parsed.map((l) => layoutLine(l, TERM_FG, TERM_BG));
  }, [output?.text]);
  const blank = output !== null && lines.every((l) => l.items.length === 0 && l.bg.length === 0);
  const cols = useMemo(() => lines.reduce((n, l) => Math.max(n, l.cols), 0), [lines]);
  const { metrics, probe } = useCellMetrics(FONT_SIZE);
  const { width: screenWidth } = useWindowDimensions();
  // Rows keep the pane's own width; a pane wider than the phone scrolls sideways instead of wrapping.
  const contentWidth = Math.max(screenWidth, Math.ceil(cols * metrics.w) + PAD * 2);
  const list = useRef<FlatList<GridLine>>(null);
  const [follow, setFollow] = useState(true);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    setFollow(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
  };

  return (
    <View style={{ flex: 1 }} testID="pane">
      {error ? (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorBox message={error} />
        </View>
      ) : null}
      {probe}
      <View style={{ flex: 1 }}>
        <ScrollView
          horizontal
          style={{ flex: 1, backgroundColor: TERM_BG }}
          contentContainerStyle={{ width: contentWidth }}
        >
          <FlatList
            ref={list}
            testID="pane-output"
            style={{ flex: 1, width: contentWidth }}
            contentContainerStyle={{ padding: PAD }}
            data={lines}
            keyExtractor={(_, i) => String(i)}
            renderItem={({ item }) => <TermRow g={item} m={metrics} />}
            onScroll={onScroll}
            scrollEventThrottle={100}
            onContentSizeChange={() => follow && list.current?.scrollToEnd({ animated: false })}
            initialNumToRender={60}
            windowSize={15}
            ListHeaderComponent={
              output?.truncated ? (
                <Pressable testID="load-more" onPress={() => reader?.loadMore()} style={{ paddingVertical: 8 }}>
                  <Text style={[styles.muted, { color: colors.accent, textAlign: 'center' }]}>
                    Load more scrollback (showing last {output.lines} lines)
                  </Text>
                </Pressable>
              ) : output ? (
                <Text style={[styles.muted, { textAlign: 'center', paddingVertical: 8 }]}>Start of scrollback</Text>
              ) : null
            }
            ListEmptyComponent={<Text style={styles.muted}>{output ? '' : 'Loading…'}</Text>}
          />
        </ScrollView>
        {!follow ? (
          <Pressable
            testID="jump-bottom"
            onPress={() => {
              setFollow(true);
              list.current?.scrollToEnd({ animated: true });
            }}
            style={{
              position: 'absolute',
              left: 16,
              bottom: 16,
              backgroundColor: colors.accent,
              borderRadius: 16,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: '#fff' }}>↓ Latest</Text>
          </Pressable>
        ) : null}
        {overlay?.(() => reader?.pokeNow())}
      </View>
      {footer?.(() => reader?.pokeNow(), blank)}
    </View>
  );
}
