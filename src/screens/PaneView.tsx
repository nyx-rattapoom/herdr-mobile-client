import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { EMPTY_KEPT, keepScrolledOff, shownRows, type Kept } from '../live/scrollback';
import { TERM_BG, TERM_FG, TermRow, useCellMetrics } from './TermView';
import { ErrorBox, colors, styles } from './ui';

const FONT_SIZE = 12;
const HEADER_H = 36;

type ScrollMemory = { y: number; follow: boolean };
const scrollMemory = new WeakMap<LiveSession, Map<string, ScrollMemory>>();
const PAD = 8;
const rowKey = (_: GridLine, i: number) => String(i);
const keptRows = new WeakMap<LiveSession, Map<string, { agent: string; kept: Kept }>>();
const laidOut = new WeakMap<Line, GridLine>();
const layoutKept = (l: Line) => {
  let g = laidOut.get(l);
  if (!g) laidOut.set(l, (g = layoutLine(l, TERM_FG, TERM_BG)));
  return g;
};

export type History =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'failed'; message: string }
  | { kind: 'shown'; lines: GridLine[]; partial: boolean };

export type Header =
  | 'loading'
  | 'load-more'
  | 'start'
  | 'load-history'
  | 'history-busy'
  | 'history-loading'
  | 'history-none'
  | 'history-failed'
  | 'history-shown';

export function scrollbackHeader(output: PaneOutput | null, agent: boolean, history: History, busy = false): Header {
  if (history.kind === 'shown') return 'history-shown';
  if (!output) return 'loading';
  if (output.truncated) return 'load-more';
  if (!agent) return 'start';
  if (busy && (history.kind === 'idle' || history.kind === 'none')) return 'history-busy';
  return history.kind === 'idle' ? 'load-history' : `history-${history.kind}`;
}

function parseOutput(text: string): Line[] {
  const p = parseAnsi(text);
  if (p.length > 1 && p[p.length - 1].length === 0) p.pop();
  return p;
}

function contentRows(lines: Line[]): number {
  let n = lines.length;
  while (n > 0 && lines[n - 1].every((s) => !s.text.trim())) n--;
  return n;
}

type Props = {
  live: LiveSession;
  paneId: string;
  agent?: string;
  agentStatus?: string;
  footer?: (pokeNow: () => void, blank: boolean, screen: Line[]) => React.ReactNode;
  overlay?: (pokeNow: () => void) => React.ReactNode;
};

export function PaneView({ live, paneId, agent, agentStatus, footer, overlay }: Props) {
  const { output, error, reader } = usePaneOutput(live, paneId);
  const parsed = useMemo(() => parseOutput(output?.text ?? ''), [output?.text]);
  const parsedNow = useRef(parsed);
  useEffect(() => {
    parsedNow.current = parsed;
  }, [parsed]);
  const lines = useMemo(() => parsed.map((l) => layoutLine(l, TERM_FG, TERM_BG)), [parsed]);
  const blank = output !== null && lines.every((l) => l.items.length === 0 && l.bg.length === 0);
  const [saved] = useState(() => scrollMemory.get(live)?.get(paneId));
  const [follow, setFollow] = useState(saved?.follow ?? true);
  const tracking = !!agent && output !== null && !output.truncated;
  const kept = useMemo(() => {
    let m = keptRows.get(live);
    if (!m) keptRows.set(live, (m = new Map()));
    const was = m.get(paneId);
    const k = was && was.agent === agent ? was.kept : EMPTY_KEPT;
    if (!tracking || !agent) return k;
    const next = keepScrolledOff(k, parsed, !follow);
    m.set(paneId, { agent, kept: next });
    return next;
  }, [live, paneId, agent, tracking, parsed, follow]);
  const keptLines = useMemo(() => (tracking ? shownRows(kept).map(layoutKept) : []), [tracking, kept]);
  const [history, setHistory] = useState<History>({ kind: 'idle' });
  const shown = useMemo(
    () => (history.kind === 'shown' ? history.lines : keptLines.length ? [...keptLines, ...lines] : lines),
    [history, keptLines, lines],
  );
  const busy = agentStatus === 'working' || agentStatus === 'blocked';
  const header = scrollbackHeader(output, !!agent, history, busy);
  const cols = useMemo(() => shown.reduce((n, l) => Math.max(n, l.cols), 0), [shown]);
  const { metrics, probe } = useCellMetrics(FONT_SIZE);
  const { width: screenWidth } = useWindowDimensions();
  const contentWidth = Math.max(screenWidth, Math.ceil(cols * metrics.w) + PAD * 2);
  const list = useRef<FlatList<GridLine>>(null);
  const renderRow = useCallback(({ item }: { item: GridLine }) => <TermRow g={item} m={metrics} />, [metrics]);
  const rowLayout = useCallback(
    (_: unknown, index: number) => ({ length: metrics.h, offset: PAD + HEADER_H + index * metrics.h, index }),
    [metrics.h],
  );
  const restore = useRef(saved && !saved.follow ? saved.y : null);

  const viewport = useRef(0);
  const offsetY = useRef(0);
  const dragging = useRef(false);
  const flinging = useRef(false);
  const following = useRef(follow);
  useEffect(() => {
    following.current = follow;
  }, [follow]);
  const dropped = useRef(kept.dropped);
  useEffect(() => {
    const n = kept.dropped - dropped.current;
    dropped.current = kept.dropped;
    if (n <= 0 || follow || history.kind === 'shown') return;
    if (restore.current !== null) restore.current = Math.max(0, restore.current - n * metrics.h);
    else list.current?.scrollToOffset({ offset: Math.max(0, offsetY.current - n * metrics.h), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kept.dropped]);
  useEffect(() => {
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
      if (contentRows(rows) <= contentRows(parsedNow.current)) return setHistory({ kind: 'none' });
      restore.current = null;
      setFollow(true);
      setHistory({ kind: 'shown', lines: rows.map((l) => layoutLine(l, TERM_FG, TERM_BG)), partial: truncated });
    } catch (e) {
      setHistory({ kind: 'failed', message: (e as Error)?.message ?? String(e) });
    }
  };

  const backToLive = () => {
    restore.current = null;
    dragging.current = false;
    flinging.current = false;
    following.current = true;
    setFollow(true);
    if (history.kind === 'shown') setHistory({ kind: 'idle' });
    else list.current?.scrollToEnd({ animated: true });
  };
  const poke = () => {
    if (history.kind === 'shown') {
      setFollow(true);
      setHistory({ kind: 'idle' });
    }
    reader?.pokeNow();
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    offsetY.current = contentOffset.y;
    if (restore.current !== null) return;
    const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
    if (atEnd) flinging.current = false;
    const next = atEnd || (following.current && !dragging.current && !flinging.current);
    following.current = next;
    setFollow(next);
    if (history.kind === 'shown') return;
    let m = scrollMemory.get(live);
    if (!m) scrollMemory.set(live, (m = new Map()));
    m.set(paneId, { y: contentOffset.y, follow: next });
  };

  const onContentSizeChange = (_w: number, h: number) => {
    if (restore.current !== null) {
      if (h >= restore.current + viewport.current) {
        list.current?.scrollToOffset({ offset: restore.current, animated: false });
        restore.current = null;
      }
    } else if (follow && !dragging.current) {
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
            keyExtractor={rowKey}
            renderItem={renderRow}
            onScroll={onScroll}
            onScrollBeginDrag={() => {
              dragging.current = true;
              flinging.current = false;
            }}
            onScrollEndDrag={() => (dragging.current = false)}
            onMomentumScrollBegin={() => (flinging.current = true)}
            onMomentumScrollEnd={() => (flinging.current = false)}
            scrollEventThrottle={100}
            onContentSizeChange={onContentSizeChange}
            onLayout={(e) => (viewport.current = e.nativeEvent.layout.height)}
            initialNumToRender={60}
            windowSize={15}
            getItemLayout={rowLayout}
            ListHeaderComponent={
              <View style={{ height: HEADER_H, width: screenWidth - PAD * 2, justifyContent: 'center' }}>
                <ListHeader
                  header={header}
                  lines={output?.lines ?? 0}
                  kept={keptLines.length}
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
  kept: number;
  partial: boolean;
  onLoadMore: () => void;
  onLoadHistory: () => void;
  onBackToLive: () => void;
};

function ListHeader({ header, lines, kept, partial, onLoadMore, onLoadHistory, onBackToLive }: HeaderProps) {
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
              ? kept > 0
                ? 'Earlier output not loaded · '
                : 'Start of output · '
              : header === 'history-none'
                ? 'No older agent history · '
                : "Couldn't load history · "}
            <Text style={{ color: colors.accent }}>{header === 'load-history' ? 'Load agent history' : 'Retry'}</Text>
          </Text>
        </Pressable>
      );
    case 'history-busy':
      return (
        <Text testID="history-busy" style={muted} numberOfLines={1}>
          {kept > 0 ? 'Earlier output loads when the agent is idle' : 'Agent history loads when the agent is idle'}
        </Text>
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
