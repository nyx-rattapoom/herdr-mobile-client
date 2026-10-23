import { useState, useSyncExternalStore } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { describeActionError } from '../live/actions';
import type { PromptQueues, QueueItem } from '../live/promptQueue';
import { colors, styles } from './ui';

export function QueueList({ queue, paneId, onSent }: { queue: PromptQueues; paneId: string; onSent: () => void }) {
  const items = useSyncExternalStore(
    (cb) => queue.subscribe(cb),
    () => queue.items(paneId),
  );
  const paused = useSyncExternalStore(
    (cb) => queue.subscribe(cb),
    () => queue.pausedReason(paneId),
  );
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!items.length) return null;

  const run = (fn: () => Promise<void>) =>
    void fn()
      .then(() => setError(null))
      .catch((e) => setError(describeActionError(e)));

  const row = (item: QueueItem, index: number) =>
    editing?.id === item.id ? (
      <View key={item.id} style={q.row} testID={`queue-edit-${index}`}>
        <TextInput
          testID="queue-edit-text"
          multiline
          autoFocus
          style={[styles.input, { flex: 1, fontFamily: 'monospace', fontSize: 13, maxHeight: 120 }]}
          value={editing.text}
          onChangeText={(text) => setEditing({ id: item.id, text })}
        />
        <Pressable
          testID="queue-save"
          onPress={() => {
            const text = editing.text.trim();
            setEditing(null);
            if (text) run(() => queue.update(paneId, item.id, text));
          }}
          style={q.btn}
        >
          <Text style={{ color: colors.accent }}>Save</Text>
        </Pressable>
      </View>
    ) : (
      <View key={item.id} style={q.row} testID={`queue-${index}`}>
        <Text style={[styles.muted, { width: 18 }]}>{index + 1}.</Text>
        <Text style={[styles.text, { flex: 1, fontSize: 13 }]} numberOfLines={2}>
          {item.text}
        </Text>
        <Pressable
          testID={`queue-up-${index}`}
          disabled={index === 0}
          onPress={() => run(() => queue.move(paneId, item.id, -1))}
          style={q.btn}
        >
          <Text style={{ color: index === 0 ? colors.border : colors.muted }}>↑</Text>
        </Pressable>
        <Pressable
          testID={`queue-down-${index}`}
          disabled={index === items.length - 1}
          onPress={() => run(() => queue.move(paneId, item.id, 1))}
          style={q.btn}
        >
          <Text style={{ color: index === items.length - 1 ? colors.border : colors.muted }}>↓</Text>
        </Pressable>
        <Pressable
          testID={`queue-edit-${index}`}
          onPress={() => setEditing({ id: item.id, text: item.text })}
          style={q.btn}
        >
          <Text style={{ color: colors.muted }}>✎</Text>
        </Pressable>
        <Pressable
          testID={`queue-delete-${index}`}
          onPress={() => run(() => queue.remove(paneId, item.id))}
          style={q.btn}
        >
          <Text style={{ color: colors.danger }}>✕</Text>
        </Pressable>
        <Pressable
          testID={`queue-send-${index}`}
          accessibilityLabel="Send now"
          onPress={() => run(() => queue.sendNow(paneId, item.id).then(onSent))}
          style={q.btn}
        >
          <Text style={{ color: colors.accent }}>➤</Text>
        </Pressable>
      </View>
    );

  return (
    <View style={q.wrap} testID="queue">
      <Text style={styles.muted}>
        Queued for when the agent finishes · {items.length}
        {paused ? ` · ${paused}` : ''}
      </Text>
      {items.map(row)}
      {error ? <Text style={[styles.muted, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

const q = {
  wrap: { marginTop: 8, gap: 4 },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  btn: { paddingHorizontal: 7, paddingVertical: 4 },
};
