import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { AGENT_GROUPS, agentRows, type AgentRow } from '../live/agentList';
import { useLive } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import { StatusDot } from './SessionsScreen';
import { colors, sheet, styles } from './ui';

/** Header button: the number of agents, amber while any of them needs the user. */
export function AgentsButton({ live, onPress }: { live: LiveSession; onPress: () => void }) {
  const st = useLive(live);
  const all = [...st.agents.values()];
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

/** Every agent in the session, grouped most urgent first; shared by the sheet and the side panel. */
export function AgentList({
  live,
  viewed,
  onOpen,
  onClosePane,
  current,
}: {
  live: LiveSession;
  viewed: Record<string, number>;
  onOpen: (r: AgentRow) => void;
  onClosePane: (r: AgentRow) => void;
  /** The pane on screen, highlighted in the side panel. */
  current?: string;
}) {
  const st = useLive(live);
  const rows = agentRows(st.tree, st.agents, st.since, viewed);
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
                onLongPress={() => onClosePane(r)}
                style={({ pressed }) => [
                  sheet.row,
                  r.paneId === current ? { backgroundColor: colors.bg } : null,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <StatusDot value={r.status} size={10} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.text, { fontWeight: r.unseen ? '700' : '400' }]} numberOfLines={1}>
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
    </ScrollView>
  );
}

/** The agent list as a bottom sheet. */
export function AgentsSheet({
  live,
  viewed,
  onOpen,
  onClosePane,
  onClose,
}: {
  live: LiveSession;
  viewed: Record<string, number>;
  onOpen: (r: AgentRow) => void;
  onClosePane: (r: AgentRow) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={sheet.backdrop} onPress={onClose} testID="sheet-backdrop">
        <Pressable style={[sheet.panel, { maxHeight: '80%' }]} testID="agents-sheet">
          <Text style={[styles.muted, { marginBottom: 4 }]}>Agents · tap to open, long-press to close</Text>
          <AgentList live={live} viewed={viewed} onOpen={onOpen} onClosePane={onClosePane} />
        </Pressable>
      </Pressable>
    </Modal>
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
