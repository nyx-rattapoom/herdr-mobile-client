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
import type { PaneOutput } from '../live/PaneReader';
import { TERM_BG, TERM_FG, TermRow, useCellMetrics } from './TermView';
import { ErrorBox, colors, styles } from './ui';

const FONT_SIZE = 12;
/** Fixed height of the list header, so every row's offset is known without measuring. */
const HEADER_H = 36;

type ScrollMemory = { y: number; follow: boolean };
/** Where each pane was scrolled to, so switching back (or reconnecting) keeps the position. */
const scrollMemory = new WeakMap<LiveSession, Map<string, ScrollMemory>>();
const PAD = 8;

/** A one-off read of a full-screen agent's own transcript (see `PaneReader.loadHistory`). */
export type History =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** Herdr returned no more than the screen: the agent was busy, or keeps no history of its own. */
  | { kind: 'none' }
  | { kind: 'failed'; message: string }
  /** `partial`: Herdr stopped before the top of the transcript. */
  | { kind: 'shown'; lines: GridLine[]; partial: boolean };

export type Header =
  | 'loading'
  | 'load-more'
  | 'start'
  | 'load-history'
  | 'history-loading'
  | 'history-none'
  | 'history-failed'
  | 'history-shown';

/**
 * What the list header offers. A full-screen agent (Claude Code, OpenCode) draws on the alternate
 * screen, so an untruncated read is its screen, not the start of its history.
 */
export function scrollbackHeader(output: PaneOutput | null, agent: boolean, history: History): Header {
  if (history.kind === 'shown') return 'history-shown';
  if (!output) return 'loading';
  if (output.truncated) return 'load-more';
  if (!agent) return 'start';
  return history.kind === 'idle' ? 'load-history' : `history-${history.kind}`;
}

/** Parsed pane text; pane.read output ends with the cursor line, so a trailing empty line is dropped. */
function parseOutput(text: string): Line[] {
  const p = parseAnsi(text);
  if (p.length > 1 && p[p.length - 1].length === 0) p.pop();
  return p;
}

/** Rows up to the last one with text. Plain-text reads drop trailing blank rows that ANSI reads keep. */
function contentRows(lines: Line[]): number {
  let n = lines.length;
  while (n > 0 && lines[n - 1].every((s) => !s.text.trim())) n--;
  return n;
}

type Props = {
  live: LiveSession;
  paneId: string;
  /** The pane's agent, if any; full-screen agents keep history outside the terminal's scrollback. */
  agent?: string;
  /** Rendered under the output (M3 input bar). */
  /** `blank`: output was read and nothing is drawn yet. */
  /** `screen`: the parsed output lines, for reading what the agent asks. */
  footer?: (pokeNow: () => void, blank: boolean, screen: Line[]) => React.ReactNode;
  /** Floating controls drawn over the output (e.g. the / button). */
  overlay?: (pokeNow: () => void) => React.ReactNode;
};

/** A pane's output, followed live, with an optional footer (the composer). */
export function PaneView({ live, paneId, agent, footer, overlay }: Props) {
  const { output, error, reader } = usePaneOutput(live, paneId);
  const parsed = useMemo(() => parseOutput(output?.text ?? ''), [output?.text]);
  /** The latest screen, for a history read that finishes renders after it was requested. */
  const parsedNow = useRef(parsed);
  useEffect(() => {
    parsedNow.current = parsed;
  }, [parsed]);
  const lines = useMemo(() => parsed.map((l) => layoutLine(l, TERM_FG, TERM_BG)), [parsed]);
  const blank = output !== null && lines.every((l) => l.items.length === 0 && l.bg.length === 0);
  const [history, setHistory] = useState<History>({ kind: 'idle' });
  const shown = history.kind === 'shown' ? history.lines : lines;
  const header = scrollbackHeader(output, !!agent, history);
  const cols = useMemo(() => shown.reduce((n, l) => Math.max(n, l.cols), 0), [shown]);
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

  const loadHistory = async () => {
    if (!reader || history.kind === 'loading') return;
    setHistory({ kind: 'loading' });
    try {
      const { text, truncated } = await reader.loadHistory();
      const rows = parseOutput(text);
      // Herdr returns just the screen when it can't scroll the agent: busy, or not full-screen.
      if (contentRows(rows) <= contentRows(parsedNow.current)) return setHistory({ kind: 'none' });
      // A saved live position doesn't apply to the snapshot.
      restore.current = null;
      setFollow(true);
      setHistory({ kind: 'shown', lines: rows.map((l) => layoutLine(l, TERM_FG, TERM_BG)), partial: truncated });
    } catch (e) {
      setHistory({ kind: 'failed', message: (e as Error)?.message ?? String(e) });
    }
  };

  const backToLive = () => {
    restore.current = null;
    setFollow(true);
    // Leaving the snapshot changes the content; onContentSizeChange then follows to the end.
    if (history.kind === 'shown') setHistory({ kind: 'idle' });
    else list.current?.scrollToEnd({ animated: true });
  };
  /** Sending input shows its effect live, not over a stale snapshot. */
  const poke = () => {
    if (history.kind === 'shown') {
      setFollow(true);
      setHistory({ kind: 'idle' });
    }
    reader?.pokeNow();
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Until a saved position is restored, scroll events come from the list growing.
    if (restore.current !== null) return;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
    setFollow(atEnd);
    // A history snapshot isn't restored on return, so its position isn't remembered.
    if (history.kind === 'shown') return;
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
      {error || history.kind === 'failed' ? (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorBox message={error ?? `Couldn't load agent history: ${history.kind === 'failed' ? history.message : ''}`} />
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
            data={shown}
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
              // Screen-wide, so a pane wider than the phone doesn't push the header off to the right.
              <View style={{ height: HEADER_H, width: screenWidth - PAD * 2, justifyContent: 'center' }}>
                <ListHeader
                  header={header}
                  lines={output?.lines ?? 0}
                  partial={history.kind === 'shown' && history.partial}
                  onLoadMore={() => reader?.loadMore()}
                  onLoadHistory={() => void loadHistory()}
                  onBackToLive={backToLive}
                />
              </View>
            }
            ListEmptyComponent={<Text style={styles.muted}>{output ? '' : 'Loading…'}</Text>}
          />
        </ScrollView>
        {!follow || history.kind === 'shown' ? (
          <Pressable
            testID="jump-bottom"
            onPress={backToLive}
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
            <Text style={{ color: '#fff' }}>{history.kind === 'shown' ? '↓ Back to live' : '↓ Latest'}</Text>
          </Pressable>
        ) : null}
        {overlay?.(poke)}
      </View>
      {footer?.(poke, blank, parsed)}
    </View>
  );
}

type HeaderProps = {
  header: Header;
  lines: number;
  partial: boolean;
  onLoadMore: () => void;
  onLoadHistory: () => void;
  onBackToLive: () => void;
};

/** One line, so it fits the fixed header height at any font scale. */
function ListHeader({ header, lines, partial, onLoadMore, onLoadHistory, onBackToLive }: HeaderProps) {
  const muted = [styles.muted, { textAlign: 'center' as const }];
  const link = [styles.muted, { color: colors.accent, textAlign: 'center' as const }];
  switch (header) {
    case 'loading':
      return null;
    case 'load-more':
      return (
        <Pressable testID="load-more" onPress={onLoadMore}>
          <Text style={link}>Load more scrollback (showing last {lines} lines)</Text>
        </Pressable>
      );
    case 'start':
      return <Text style={muted}>Start of scrollback</Text>;
    case 'load-history':
    case 'history-none':
    case 'history-failed':
      return (
        <Pressable testID="load-history" onPress={onLoadHistory}>
          <Text style={muted} numberOfLines={1}>
            {header === 'load-history'
              ? 'Start of output · '
              : header === 'history-none'
                ? 'No older agent history · '
                : "Couldn't load history · "}
            <Text style={{ color: colors.accent }}>{header === 'load-history' ? 'Load agent history' : 'Retry'}</Text>
          </Text>
        </Pressable>
      );
    case 'history-loading':
      return <Text style={muted}>Loading agent history…</Text>;
    case 'history-shown':
      return (
        <Pressable testID="history-back" onPress={onBackToLive}>
          <Text style={muted} numberOfLines={1}>
            {partial ? 'Agent history, partial (plain text) · ' : 'Agent history (plain text) · '}
            <Text style={{ color: colors.accent }}>Back to live</Text>
          </Text>
        </Pressable>
      );
  }
}
