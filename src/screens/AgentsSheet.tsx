import { useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { AGENT_GROUPS, agentRows, type AgentRow } from '../live/agentList';
import { useLive } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import { formatUntil, type PaneFlags } from '../store/paneFlags';
import { BottomSheet } from './Sheet';
import { StatusDot } from './SessionsScreen';
import { colors, sheet, styles } from './ui';

/** Header button: the number of agents, amber while any of them needs the user. */
export function AgentsButton({ live, flags, onPress }: { live: LiveSession; flags?: PaneFlags; onPress: () => void }) {
  const st = useLive(live);
  useFlags(flags);
  const all = [...st.agents.entries()].filter(([paneId]) => !flags?.isSnoozed(paneId)).map(([, a]) => a);
  const blocked = all.some((a) => a.status === 'blocked');
  return (
    <Pressable
      testID="agents-button"
      accessibilityLabel={`Agents: ${all.length}`}
      onPress={onPress}
      hitSlop={8}
      style={btn.wrap}
    >
      <Text style={[styles.text, { color: colors.accent }]}>Agents</Text>
      <View
        style={[btn.badge, { backgroundColor: blocked ? colors.warn : all.length ? colors.accent : colors.border }]}
      >
        <Text testID="agents-count" style={btn.badgeText}>
          {all.length}
        </Text>
      </View>
    </Pressable>
  );
}

const noop = () => () => {};
const zero = () => 0;
/** Re-renders when pin/mute/snooze marks change (including a snooze running out). */
function useFlags(flags?: PaneFlags) {
  useSyncExternalStore(flags ? (cb) => flags.subscribe(cb) : noop, flags ? flags.getVersion : zero);
}

/** Every agent in the session, grouped most urgent first; shared by the sheet and the side panel. */
export function AgentList({
  live,
  viewed,
  flags,
  onOpen,
  onLongPress,
  current,
}: {
  live: LiveSession;
  viewed: Record<string, number>;
  flags?: PaneFlags;
  onOpen: (r: AgentRow) => void;
  /** Pane actions: pin, mute, snooze, close… */
  onLongPress: (r: AgentRow) => void;
  /** The pane on screen, highlighted in the side panel. */
  current?: string;
}) {
  const st = useLive(live);
  useFlags(flags);
  const rows = agentRows(st.tree, st.agents, st.since, viewed, flags);
  const snoozed = flags ? [...st.agents.keys()].filter((p) => flags.isSnoozed(p)) : [];
  const [openedAt] = useState(() => Date.now());
  // A long-press acts when the finger lifts: closing this sheet mid-gesture would leave the touch
  // responder on a removed view, and the next sheet would lose its first tap.
  const longPressed = useRef<AgentRow | null>(null);
  return (
    <ScrollView>
      {rows.length === 0 ? (
        <Text style={[styles.text, { paddingVertical: 16 }]}>No agents in this session.</Text>
      ) : null}
      {AGENT_GROUPS.map((g) => {
        const items = rows.filter((r) => r.group === g.id);
        if (!items.length) return null;
        return (
          <View key={g.id} testID={`agents-group-${g.id}`}>
            <Text style={[styles.label, { marginTop: 12 }]}>
              {g.title} · {items.length}
            </Text>
            {items.map((r) => (
              <Pressable
                key={r.paneId}
                testID={`agent-${r.paneId}`}
                onPress={() => onOpen(r)}
                onLongPress={() => (longPressed.current = r)}
                onPressOut={() => {
                  if (longPressed.current?.paneId !== r.paneId) return;
                  longPressed.current = null;
                  onLongPress(r);
                }}
                style={({ pressed }) => [
                  sheet.row,
                  r.paneId === current ? { backgroundColor: colors.bg } : null,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <StatusDot value={r.status} size={10} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.text, { fontWeight: r.unseen ? '700' : '400' }]} numberOfLines={1}>
                    {r.pinned ? '📌 ' : ''}
                    {r.muted ? '🔕 ' : ''}
                    {r.name}
                  </Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {r.agent} · {r.workspace} · {r.tab}
                  </Text>
                </View>
                {r.unseen ? (
                  <Text testID={`unseen-${r.paneId}`} style={[styles.muted, { color: colors.ok }]}>
                    new
                  </Text>
                ) : (
                  <Text style={styles.muted}>{r.status === 'blocked' ? 'needs you' : r.status}</Text>
                )}
              </Pressable>
            ))}
          </View>
        );
      })}
      {snoozed.length ? (
        <View testID="agents-snoozed">
          <Text style={[styles.label, { marginTop: 12 }]}>Snoozed · {snoozed.length}</Text>
          {snoozed.map((paneId) => (
            <Pressable
              key={paneId}
              testID={`unsnooze-${paneId}`}
              onPress={() => void flags?.unsnooze(paneId)}
              style={({ pressed }) => [sheet.row, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.muted, { flex: 1 }]}>
                💤 {paneId} until {formatUntil(flags?.get(paneId).snoozeUntil ?? 0, openedAt)}
              </Text>
              <Text style={[styles.muted, { color: colors.accent }]}>Un-snooze</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

/** The agent list as a bottom sheet. */
export function AgentsSheet({
  live,
  viewed,
  flags,
  onOpen,
  onLongPress,
  onClose,
}: {
  live: LiveSession;
  viewed: Record<string, number>;
  flags?: PaneFlags;
  onOpen: (r: AgentRow) => void;
  onLongPress: (r: AgentRow) => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet onClose={onClose} testID="agents-sheet" style={{ maxHeight: '80%' }}>
      <Text style={[styles.muted, { marginBottom: 4 }]}>
        Agents · tap to open, long-press for pin, mute, snooze, close
      </Text>
      <AgentList live={live} viewed={viewed} flags={flags} onOpen={onOpen} onLongPress={onLongPress} />
    </BottomSheet>
  );
}

const btn = {
  wrap: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: 6,
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' as const },
};
