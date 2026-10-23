import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, PanResponder, Pressable, Text, View } from 'react-native';

import { SPECIAL_KEYS, describeActionError, keyRequest, keysOf } from '../live/actions';
import type { LiveSession } from '../live/LiveSession';
import { SlashMenu, type SlashCommand } from '../live/slash';
import { BottomSheet } from './Sheet';
import { colors, sheet, styles } from './ui';

const SIZE = 52;
const TAP_SLOP = 6;

export function SlashButton({
  live,
  paneId,
  agent,
  onSent,
}: {
  live: LiveSession;
  paneId: string;
  agent?: string;
  onSent: () => void;
}) {
  const [pos] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const [drag] = useState(
    () =>
      new DragTracker(
        pos,
        () => setKeys(true),
        () => setPalette(true),
      ),
  );
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => drag.start(),
        onPanResponderMove: (_, g) => drag.move(g.dx, g.dy),
        onPanResponderRelease: (_, g) => drag.end(g.dx, g.dy),
        onPanResponderTerminate: () => drag.cancel(),
      }),
    [drag],
  );

  return (
    <>
      <Animated.View
        testID="slash-button"
        accessibilityRole="button"
        accessibilityLabel={agent ? 'Slash commands (long-press for keys)' : 'No agent: slash commands unavailable'}
        {...responder.panHandlers}
        style={[fab.button, { opacity: agent ? 1 : 0.45, transform: pos.getTranslateTransform() }]}
      >
        <Text style={fab.label}>/</Text>
      </Animated.View>
      {palette ? (
        <SlashSheet live={live} paneId={paneId} agent={agent} onClose={() => setPalette(false)} onSent={onSent} />
      ) : null}
      {keys ? <KeysSheet live={live} paneId={paneId} onClose={() => setKeys(false)} onSent={onSent} /> : null}
    </>
  );
}

class DragTracker {
  private offset = { x: 0, y: 0 };
  private longPressed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly pos: Animated.ValueXY,
    private readonly onLongPress: () => void,
    private readonly onTap: () => void,
  ) {}

  private moved = (dx: number, dy: number) => Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP;

  start() {
    this.longPressed = false;
    this.timer = setTimeout(() => {
      this.longPressed = true;
      this.onLongPress();
    }, 450);
  }

  move(dx: number, dy: number) {
    if (!this.moved(dx, dy)) return;
    this.cancel();
    this.pos.setValue({ x: this.offset.x + dx, y: this.offset.y + dy });
  }

  end(dx: number, dy: number) {
    this.cancel();
    if (this.moved(dx, dy)) this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
    else if (!this.longPressed) this.onTap();
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'disabled';

function SlashSheet({
  live,
  paneId,
  agent,
  onClose,
  onSent,
}: {
  live: LiveSession;
  paneId: string;
  agent?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const menu = useMemo(() => new SlashMenu((m, p) => live.query(m, p), paneId), [live, paneId]);
  const [phase, setPhase] = useState<Phase>(agent ? 'loading' : 'disabled');
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!agent || started.current) return;
    started.current = true;
    menu
      .open()
      .then((c) => {
        setCommands(c);
        setPhase(c.length ? 'ready' : 'empty');
        onSent();
      })
      .catch((e) => {
        setError(describeActionError(e));
        setPhase('error');
      });
  }, [agent, menu, onSent]);

  const close = () => {
    onClose();
    void menu
      .cancel()
      .then(onSent)
      .catch(() => {});
  };

  const loadMore = async () => {
    setBusy(true);
    try {
      setCommands([...(await menu.more(10, 5))]);
    } catch (e) {
      setError(describeActionError(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (c: SlashCommand) => {
    setBusy(true);
    try {
      await menu.choose(c.name);
      onSent();
      onClose();
    } catch (e) {
      setError(describeActionError(e));
      setBusy(false);
    }
  };

  return (
    <BottomSheet onClose={close} testID="slash-sheet" backdropTestID="slash-backdrop" style={{ maxHeight: '75%' }}>
      <Text style={[styles.muted, { marginBottom: 4 }]}>
        {agent ? `Slash commands · ${agent} · read from its screen` : 'Slash commands'}
      </Text>
      {phase === 'disabled' ? (
        <Text testID="slash-disabled" style={[styles.text, { paddingVertical: 16 }]}>
          No agent detected in this pane, so there is no slash-command menu to read. Long-press the / button for
          special keys.
        </Text>
      ) : phase === 'loading' ? (
        <View style={{ paddingVertical: 24, alignItems: 'center', gap: 8 }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.muted}>Typed / in the pane; reading the menu…</Text>
        </View>
      ) : phase === 'error' ? (
        <Text testID="slash-error" style={[styles.text, { color: colors.danger, paddingVertical: 16 }]}>
          Couldn&apos;t send input to the pane: {error}
        </Text>
      ) : phase === 'empty' ? (
        <Text testID="slash-empty" style={[styles.text, { paddingVertical: 16 }]}>
          The agent didn&apos;t show a slash-command menu. Closing this sends Esc to clear the /.
        </Text>
      ) : (
        <FlatList
          testID="slash-list"
          data={commands}
          keyExtractor={(c) => c.name}
          renderItem={({ item }) => (
            <Pressable
              testID={`slash-${item.name.slice(1)}`}
              disabled={busy}
              onPress={() => void choose(item)}
              style={({ pressed }) => [sheet.row, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.mono, { color: colors.accent, minWidth: 110 }]}>{item.name}</Text>
              <Text style={[styles.muted, { flex: 1 }]} numberOfLines={2}>
                {item.description}
              </Text>
            </Pressable>
          )}
          ListFooterComponent={
            <View>
              {error ? <Text style={[styles.muted, { color: colors.danger, marginTop: 8 }]}>{error}</Text> : null}
              {menu.complete ? (
                <Text testID="slash-complete" style={[styles.muted, { paddingVertical: 12 }]}>
                  All {commands.length} commands shown.
                </Text>
              ) : (
                <Pressable testID="slash-more" disabled={busy} onPress={() => void loadMore()} style={sheet.row}>
                  <Text style={[styles.text, { color: colors.accent }]}>
                    {busy ? 'Loading…' : `Load more (scrolls the agent's menu) · ${commands.length} so far`}
                  </Text>
                </Pressable>
              )}
            </View>
          }
        />
      )}
      <Pressable testID="slash-close" onPress={close} style={[sheet.row, { borderBottomWidth: 0 }]}>
        <Text style={[styles.text, { color: colors.muted }]}>Close (sends Esc)</Text>
      </Pressable>
    </BottomSheet>
  );
}

function KeysSheet({
  live,
  paneId,
  onClose,
  onSent,
}: {
  live: LiveSession;
  paneId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <BottomSheet animation="fade" onClose={onClose} testID="keys-sheet" backdropTestID="keys-backdrop">
      <Text style={[styles.muted, { marginBottom: 8 }]}>Special keys · tap to send</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {SPECIAL_KEYS.map((k) => (
          <Pressable
            key={k.key}
            testID={`sheet-key-${k.key}`}
            onPress={() =>
              void live
                .query(keyRequest(paneId, keysOf(k)).method, keyRequest(paneId, keysOf(k)).params)
                .then(onSent)
                .catch((e) => setError(describeActionError(e)))
            }
            style={({ pressed }) => [fab.key, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={styles.mono}>{k.label}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={[styles.muted, { color: colors.danger, marginTop: 8 }]}>{error}</Text> : null}
    </BottomSheet>
  );
}

const fab = {
  button: {
    position: 'absolute' as const,
    right: 16,
    bottom: 16,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.accent,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    elevation: 6,
  },
  label: { color: '#fff', fontSize: 24, fontWeight: '700' as const, fontFamily: 'monospace' },
  key: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
};
