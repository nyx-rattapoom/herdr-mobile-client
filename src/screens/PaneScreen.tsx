import { memo, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { parseAnsi, type Line, type Style } from '../live/ansi';
import { usePaneOutput } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import { ErrorBox, Header, colors, styles } from './ui';

function spanStyle(s: Style) {
  const fg = s.inverse ? (s.bg ?? colors.bg) : s.fg;
  const bg = s.inverse ? (s.fg ?? colors.text) : s.bg;
  return {
    color: fg ?? colors.text,
    backgroundColor: bg,
    fontWeight: s.bold ? ('700' as const) : undefined,
    fontStyle: s.italic ? ('italic' as const) : undefined,
    textDecorationLine: s.underline ? ('underline' as const) : undefined,
    opacity: s.dim ? 0.6 : undefined,
  };
}

const TermLine = memo(function TermLine({ line }: { line: Line }) {
  return (
    <Text style={termStyle}>
      {line.length === 0 ? ' ' : line.map((sp, i) => <Text key={i} style={spanStyle(sp.style)}>{sp.text}</Text>)}
    </Text>
  );
});

const termStyle = { fontFamily: 'monospace', fontSize: 12, lineHeight: 16, color: colors.text };

type Props = {
  live: LiveSession;
  paneId: string;
  title: string;
  onBack: () => void;
  /** Rendered under the output (M3 input bar). */
  footer?: (pokeNow: () => void) => React.ReactNode;
};

export function PaneScreen({ live, paneId, title, onBack, footer }: Props) {
  const { output, error, reader } = usePaneOutput(live, paneId);
  const lines = useMemo(() => {
    const parsed = parseAnsi(output?.text ?? '');
    // pane.read output ends with the cursor line; drop a trailing empty line.
    if (parsed.length > 1 && parsed[parsed.length - 1].length === 0) parsed.pop();
    return parsed;
  }, [output?.text]);
  const list = useRef<FlatList<Line>>(null);
  const [follow, setFollow] = useState(true);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    setFollow(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
  };

  return (
    // Edge-to-edge Android doesn't resize the window for the keyboard; pad instead.
    <KeyboardAvoidingView style={styles.screen} behavior="padding" testID="pane">
      <Header title={title} onBack={onBack} />
      {error ? (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorBox message={error} />
        </View>
      ) : null}
      <FlatList
        ref={list}
        testID="pane-output"
        style={{ flex: 1, backgroundColor: '#000' }}
        contentContainerStyle={{ padding: 8 }}
        data={lines}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <TermLine line={item} />}
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
        ListEmptyComponent={<Text style={styles.muted}>Loading…</Text>}
      />
      {!follow ? (
        <Pressable
          testID="jump-bottom"
          onPress={() => {
            setFollow(true);
            list.current?.scrollToEnd({ animated: true });
          }}
          style={{ position: 'absolute', right: 16, bottom: footer ? 140 : 24, backgroundColor: colors.accent, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 }}
        >
          <Text style={{ color: '#fff' }}>↓ Latest</Text>
        </Pressable>
      ) : null}
      {footer?.(() => reader?.pokeNow())}
    </KeyboardAvoidingView>
  );
}
