import { useEffect, useMemo, useRef, useState } from 'react';
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

import { parseAnsi, type Line } from '../live/ansi';
import { layoutLine, type GridLine } from '../live/grid';
import { usePaneOutput } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import { TERM_BG, TERM_FG, TermRow, useCellMetrics } from './TermView';
import { ErrorBox, colors, styles } from './ui';

const FONT_SIZE = 12;
/** Fixed height of the list header, so every row's offset is known without measuring. */
const HEADER_H = 36;

type ScrollMemory = { y: number; follow: boolean };
/** Where each pane was scrolled to, so switching back (or reconnecting) keeps the position. */
const scrollMemory = new WeakMap<LiveSession, Map<string, ScrollMemory>>();
const PAD = 8;

type Props = {
  live: LiveSession;
  paneId: string;
  /** Rendered under the output (M3 input bar). */
  /** `blank`: output was read and nothing is drawn yet. */
  /** `screen`: the parsed output lines, for reading what the agent asks. */
  footer?: (pokeNow: () => void, blank: boolean, screen: Line[]) => React.ReactNode;
  /** Floating controls drawn over the output (e.g. the / button). */
  overlay?: (pokeNow: () => void) => React.ReactNode;
};

/** A pane's output, followed live, with an optional footer (the composer). */
export function PaneView({ live, paneId, footer, overlay }: Props) {
  const { output, error, reader } = usePaneOutput(live, paneId);
  const parsed = useMemo(() => {
    const p = parseAnsi(output?.text ?? '');
    // pane.read output ends with the cursor line; drop a trailing empty line.
    if (p.length > 1 && p[p.length - 1].length === 0) p.pop();
    return p;
  }, [output?.text]);
  const lines = useMemo(() => parsed.map((l) => layoutLine(l, TERM_FG, TERM_BG)), [parsed]);
  const blank = output !== null && lines.every((l) => l.items.length === 0 && l.bg.length === 0);
  const cols = useMemo(() => lines.reduce((n, l) => Math.max(n, l.cols), 0), [lines]);
  const { metrics, probe } = useCellMetrics(FONT_SIZE);
  const { width: screenWidth } = useWindowDimensions();
  // Rows keep the pane's own width; a pane wider than the phone scrolls sideways instead of wrapping.
  const contentWidth = Math.max(screenWidth, Math.ceil(cols * metrics.w) + PAD * 2);
  const list = useRef<FlatList<GridLine>>(null);
  const [saved] = useState(() => scrollMemory.get(live)?.get(paneId));
  const [follow, setFollow] = useState(saved?.follow ?? true);
  /** A saved position still to restore once the list has laid out. */
  const restore = useRef(saved && !saved.follow ? saved.y : null);

  const viewport = useRef(0);
  useEffect(() => {
    // Give up waiting for the list to grow; restore as far as it goes.
    const t = setTimeout(() => {
      if (restore.current === null) return;
      list.current?.scrollToOffset({ offset: restore.current, animated: false });
      restore.current = null;
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Until a saved position is restored, scroll events come from the list growing.
    if (restore.current !== null) return;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
    setFollow(atEnd);
    let m = scrollMemory.get(live);
    if (!m) scrollMemory.set(live, (m = new Map()));
    m.set(paneId, { y: contentOffset.y, follow: atEnd });
  };

  const onContentSizeChange = (_w: number, h: number) => {
    if (restore.current !== null) {
      // The list renders in batches; restore once it is tall enough to scroll that far.
      if (h >= restore.current + viewport.current) {
        list.current?.scrollToOffset({ offset: restore.current, animated: false });
        restore.current = null;
      }
    } else if (follow) {
      list.current?.scrollToEnd({ animated: false });
    }
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
            onContentSizeChange={onContentSizeChange}
            onLayout={(e) => (viewport.current = e.nativeEvent.layout.height)}
            initialNumToRender={60}
            windowSize={15}
            // Fixed row heights let the list jump straight to a saved offset.
            getItemLayout={(_, index) => ({ length: metrics.h, offset: PAD + HEADER_H + index * metrics.h, index })}
            ListHeaderComponent={
              <View style={{ height: HEADER_H, justifyContent: 'center' }}>
                {output?.truncated ? (
                  <Pressable testID="load-more" onPress={() => reader?.loadMore()}>
                    <Text style={[styles.muted, { color: colors.accent, textAlign: 'center' }]}>
                      Load more scrollback (showing last {output.lines} lines)
                    </Text>
                  </Pressable>
                ) : output ? (
                  <Text style={[styles.muted, { textAlign: 'center' }]}>Start of scrollback</Text>
                ) : null}
              </View>
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
      {footer?.(() => reader?.pokeNow(), blank, parsed)}
    </View>
  );
}
