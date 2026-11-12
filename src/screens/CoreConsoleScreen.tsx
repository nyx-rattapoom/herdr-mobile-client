import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';

import { TERM_BG, TERM_FG, TermRow, useCellMetrics } from './TermView';
import { Header, colors, styles } from './ui';
import { draftKey, getDraft, setDraft } from '../live/drafts';
import { layoutLine, type GridLine } from '../live/grid';
import type { Line } from '../live/ansi';
import type { CorePane } from '../core/CorePane';
import type { CoreSession, CoreSessionSnapshot } from '../core/CoreSession';
import { attentionOf, compareTerminals, isPinned, seenMarkUnread, type Attention } from '../core/labels';
import { layoutBannerKind, unplacedTerminals } from '../core/layout';
import type { CoreTerminal } from '../core/types';
import type { ServerProfile } from '../store/servers';

const PAD = 8;
const FONT = 13;
const KEY_ROWS: { label: string; keys: string[] }[] = [
  { label: 'Enter', keys: ['enter'] },
  { label: 'Esc', keys: ['esc'] },
  { label: 'Tab', keys: ['tab'] },
  { label: '↑', keys: ['up'] },
  { label: '↓', keys: ['down'] },
  { label: '←', keys: ['left'] },
  { label: '→', keys: ['right'] },
  { label: '^C', keys: ['ctrl+c'] },
];

const attentionText: Record<Attention, string> = {
  needs: 'needs you',
  working: 'working',
  done: 'done',
  idle: 'idle',
  unknown: '',
  finished: 'finished',
};

const attentionColor: Record<Attention, string> = {
  needs: colors.danger,
  working: colors.warn,
  done: colors.ok,
  idle: colors.muted,
  unknown: colors.muted,
  finished: colors.border,
};

type Props = {
  server: ServerProfile;
  session: CoreSession;
  snapshot: CoreSessionSnapshot;
  onBack: () => void;
  onReconnect: () => void;
};

export function CoreConsoleScreen({ server, session, snapshot, onBack, onReconnect }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const closeTerminal = useCallback(() => setSelected(null), []);
  const terminals = useMemo(() => [...snapshot.state.terminals.values()], [snapshot.state]);
  const current = selected ? snapshot.state.terminals.get(selected) : undefined;

  if (current && current.state === 'live') {
    return (
      <CoreTerminalView
        key={`${server.id}|${snapshot.hello?.core.id ?? ''}|${current.address}`}
        server={server}
        session={session}
        terminal={current}
        onBack={closeTerminal}
      />
    );
  }

  const sorted = [...terminals].sort((a, b) => compareTerminals(a, b));
  const layout = snapshot.layout;
  const banner = layoutBannerKind(snapshot.docError, layout);
  // A failed refresh keeps the previous layout, but the error banner replaces
  // the grouping; filtering against the stale layout would hide its terminals.
  const unplaced = unplacedTerminals(banner === 'error' ? null : layout, sorted);
  const liveUnplaced = unplaced.filter((t) => t.state === 'live');
  const byAddress = (address: string) => snapshot.state.terminals.get(address);

  const row = (t: CoreTerminal) => {
    const attention = attentionOf(t);
    const pinned = isPinned(t);
    return (
      <Pressable
        key={t.address}
        testID={`core-terminal-${t.address}`}
        accessibilityRole="button"
        onPress={() => setSelected(t.address)}
        style={[styles.card, { marginHorizontal: 12, marginBottom: 8, gap: 4 }]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[styles.mono, { flex: 1 }]} numberOfLines={1}>
            {pinned ? '★ ' : ''}
            {t.name || t.title || t.address}
          </Text>
          {attention !== 'unknown' ? (
            <Text style={{ color: attentionColor[attention], fontSize: 12, fontWeight: '600' }}>
              {attentionText[attention]}
            </Text>
          ) : null}
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {t.address}
          {t.foreground ? ` · ${t.foreground.name}` : ''}
          {t.title && t.title !== t.name ? ` · ${t.title}` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <SmallButton
            label={pinned ? 'Unpin' : 'Pin'}
            onPress={() => void togglePin(session, t)}
          />
          {seenMarkUnread(t) !== null ? <SmallButton label="Mark unread" onPress={() => void markUnread(session, t)} /> : null}
        </View>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <Header
        title={snapshot.hello ? `${snapshot.hello.core.name} · Core` : server.label}
        onBack={onBack}
        right={
          <Pressable onPress={onReconnect} hitSlop={12}>
            <Text style={{ color: colors.accent }}>Reconnect</Text>
          </Pressable>
        }
      />
      <StatusBanner snapshot={snapshot} onReconnect={onReconnect} />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {banner === 'ok' && layout ? (
          layout.spaces.map((space) => (
            <View key={space.id} style={{ marginTop: 12 }}>
              <Text style={[styles.label, { paddingHorizontal: 16, marginBottom: 6 }]}>
                {space.name || space.id}
                {space.folder ? ` · ${space.folder}` : ''}
              </Text>
              {space.tabs.map((tab) => {
                const placed = tab.terminals.map(byAddress).filter((t): t is CoreTerminal => !!t);
                if (!placed.length && !tab.name) return null;
                return (
                  <View key={tab.id} style={{ marginBottom: 8 }}>
                    {tab.name ? (
                      <Text style={[styles.muted, { paddingHorizontal: 16, marginBottom: 4 }]}>{tab.name}</Text>
                    ) : null}
                    {placed.filter((t) => t.state === 'live').map(row)}
                  </View>
                );
              })}
            </View>
          ))
        ) : (
          <Text style={[styles.muted, { padding: 16 }]}>
            {banner === 'error'
              ? `Desktop layout is unavailable (${snapshot.docError}). Terminals are listed below and still open normally.`
              : banner === 'empty'
                ? 'Desktop layout is saved, but no terminals are placed in it yet. Terminals are listed below.'
                : 'The desktop has not saved a layout yet, so terminals are listed below. They still open normally.'}
          </Text>
        )}
        {liveUnplaced.length ? (
          <>
            <Text style={[styles.label, { paddingHorizontal: 16, marginTop: 16, marginBottom: 6 }]}>Unplaced terminals</Text>
            {liveUnplaced.map(row)}
          </>
        ) : null}
        {terminals.some((t) => t.state !== 'live') ? (
          <Text style={[styles.label, { paddingHorizontal: 16, marginTop: 16, marginBottom: 6 }]}>Finished</Text>
        ) : null}
        {sorted.filter((t) => t.state !== 'live').map(row)}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

async function togglePin(session: CoreSession, t: CoreTerminal): Promise<void> {
  try {
    await session.setPinned(t.address, !isPinned(t));
  } catch (e) {
    Alert.alert('Pin failed', e instanceof Error ? e.message : String(e));
  }
}

async function markUnread(session: CoreSession, t: CoreTerminal): Promise<void> {
  try {
    await session.markUnread(t.address);
  } catch (e) {
    Alert.alert('Mark unread failed', e instanceof Error ? e.message : String(e));
  }
}

function StatusBanner({ snapshot, onReconnect }: { snapshot: CoreSessionSnapshot; onReconnect: () => void }) {
  if (snapshot.status === 'live' && !snapshot.error) return null;
  const text =
    snapshot.status === 'connecting'
      ? 'Connecting to Herdr Core…'
      : snapshot.status === 'reconnecting'
        ? 'Reconnecting…'
        : snapshot.error ?? 'Herdr Core is not connected.';
  return (
    <View style={[styles.card, { margin: 12, borderColor: colors.warn }]}>
      <Text style={styles.text}>{text}</Text>
      {snapshot.status === 'error' || snapshot.status === 'reconnecting' ? (
        <Pressable onPress={onReconnect} style={{ marginTop: 8 }}>
          <Text style={{ color: colors.accent }}>Reconnect</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SmallButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}>
      <Text style={{ color: colors.accent, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function CoreTerminalView({
  server,
  session,
  terminal,
  onBack,
}: {
  server: ServerProfile;
  session: CoreSession;
  terminal: CoreTerminal;
  onBack: () => void;
}) {
  const [pane] = useState<CorePane>(() => session.pane(terminal.address, 80, 24, true));
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [text, setTextState] = useState(() => getDraft(draftKey(server.id, 'core', terminal.address)));
  const [follow, setFollow] = useState(true);
  const list = useRef<FlatList<GridLine>>(null);
  const [historyLayout] = useState(() => new WeakMap<Line, GridLine>());
  const { metrics } = useCellMetrics(FONT);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const key = draftKey(server.id, 'core', terminal.address);

  const setText = (v: string) => {
    setTextState(v);
    setDraft(key, v);
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  useEffect(() => {
    void pane
      .open()
      .then(() => setTick((n) => n + 1))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      session.releasePane(pane);
    };
  }, [session, pane]);

  // Batch repaints at <=30/s while credits keep flowing independently.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = pane.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setTick((n) => n + 1);
      }, 50);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [pane]);

  // Mark seen only while this terminal is the foreground, visible screen.
  useEffect(() => {
    const mark = () => {
      if (AppState.currentState === 'active') {
        session.setVisible(terminal.address);
        pane?.focus(true);
      } else {
        session.setVisible(null);
        pane?.focus(false);
      }
    };
    mark();
    const sub = AppState.addEventListener('change', mark);
    return () => {
      sub.remove();
      session.setVisible(null);
    };
  }, [session, terminal.address, pane]);

  const cols = Math.max(10, Math.floor((box.w - PAD * 2) / Math.max(1, metrics.w)));
  const rows = Math.max(4, Math.floor((box.h - PAD * 2) / Math.max(1, metrics.h)));
  useEffect(() => {
    if (!pane || box.w === 0 || box.h === 0) return;
    void pane.resize(cols, rows).catch(() => {});
  }, [pane, cols, rows, box.w, box.h]);

  const lines = useMemo(() => {
    void tick;
    if (!pane) return [];
    const history = pane.buffer.historyLength;
    return pane.buffer.allLines().map((l, i) => {
      if (i >= history) return layoutLine(l, TERM_FG, TERM_BG);
      let laid = historyLayout.get(l);
      if (!laid) {
        laid = layoutLine(l, TERM_FG, TERM_BG);
        historyLayout.set(l, laid);
      }
      return laid;
    });
  }, [pane, tick, historyLayout]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    setFollow(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
  };

  const sendText = async () => {
    if (!text.trim()) return;
    try {
      await pane?.write(text);
      setText('');
      setFollow(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async () => {
    if (!text.trim()) return;
    try {
      await session.submit(terminal.address, text);
      setText('');
      setFollow(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sendKeys = async (keys: string[]) => {
    try {
      await session.sendKeys(terminal.address, keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <View style={styles.screen}>
      <Header
        title={terminal.name || terminal.title || terminal.address}
        onBack={onBack}
        right={
          <Pressable onPress={() => void togglePin(session, terminal)} hitSlop={12}>
            <Text style={{ color: colors.accent }}>{isPinned(terminal) ? '★ Pinned' : 'Pin'}</Text>
          </Pressable>
        }
      />
      {pane?.observe ? (
        <Text style={[styles.muted, { paddingHorizontal: 12, paddingBottom: 4 }]}>
          Watching. Typing claims control of this terminal and sets its size.
        </Text>
      ) : null}
      {error || pane?.closedReason ? (
        <View style={[styles.card, { marginHorizontal: 12, borderColor: colors.warn }]}>
          <Text style={styles.text}>{error ?? `Stream closed: ${pane?.closedReason}`}</Text>
        </View>
      ) : null}
      <View
        style={{ flex: 1, backgroundColor: TERM_BG, marginHorizontal: 8, borderRadius: 6, overflow: 'hidden' }}
        onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      >
        <FlatList
          ref={list}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => <TermRow g={item} m={metrics} />}
          onScroll={onScroll}
          scrollEventThrottle={50}
          onContentSizeChange={() => {
            if (follow) list.current?.scrollToEnd({ animated: false });
          }}
          contentContainerStyle={{ padding: PAD }}
          windowSize={11}
          removeClippedSubviews
        />
      </View>
      <View style={{ padding: 10, gap: 8 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {KEY_ROWS.map((k) => (
            <SmallButton key={k.label} label={k.label} onPress={() => void sendKeys(k.keys)} />
          ))}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Type to the terminal, or submit a prompt"
            placeholderTextColor={colors.muted}
            style={[styles.input, { flex: 1, maxHeight: 120 }]}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <SmallButton label="Type text" onPress={() => void sendText()} />
          </View>
          <View style={{ flex: 1 }}>
            <SmallButton label="Submit prompt" onPress={() => void submit()} />
          </View>
        </View>
      </View>
    </View>
  );
}
