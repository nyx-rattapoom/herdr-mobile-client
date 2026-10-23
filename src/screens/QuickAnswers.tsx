import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { describeActionError } from '../live/actions';
import type { Line } from '../live/ansi';
import { FALLBACK_KEYS, answerSteps, parseChoices, type InputStep } from '../live/choices';
import type { LiveSession } from '../live/LiveSession';
import { colors, styles } from './ui';

const STEP_GAP_MS = 150;

export function QuickAnswers({
  live,
  paneId,
  agent,
  screen,
  onSent,
  onAnswered,
}: {
  live: LiveSession;
  paneId: string;
  agent?: string;
  screen: Line[];
  onSent: () => void;
  onAnswered?: (label: string) => void;
}) {
  const set = useMemo(() => parseChoices(screen), [screen]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (steps: InputStep[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const [i, step] of steps.entries()) {
        if (i) await new Promise((r) => setTimeout(r, STEP_GAP_MS));
        if ('text' in step) await live.query('pane.send_text', { pane_id: paneId, text: step.text });
        else await live.query('pane.send_keys', { pane_id: paneId, keys: step.keys });
      }
      onSent();
      return true;
    } catch (e) {
      setError(describeActionError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const confirm = (index: number) => {
    if (!set) return;
    const label = set.choices[index].label;
    const context = set.context.length ? `\n\n${set.context.join('\n')}` : '';
    Alert.alert('Send this answer?', `“${label}” to ${agent ?? 'the agent'} in ${paneId}.${context}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send',
        onPress: () =>
          void run(answerSteps(set, index)).then((ok) => {
            if (ok) onAnswered?.(label);
          }),
      },
    ]);
  };

  return (
    <View style={qa.wrap} testID="quick-answers">
      <Text style={[styles.muted, { color: colors.warn, marginBottom: 6 }]} numberOfLines={2}>
        {agent ?? 'The agent'} needs you{set?.context.length ? ` · ${set.context[set.context.length - 1]}` : ''}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
        {set
          ? set.choices.map((c) => (
              <Pressable
                key={c.index}
                testID={`answer-${c.index}`}
                disabled={busy}
                onPress={() => confirm(c.index)}
                style={({ pressed }) => [
                  qa.button,
                  c.index === set.selected ? { borderColor: colors.warn } : null,
                  { opacity: pressed || busy ? 0.6 : 1 },
                ]}
              >
                <Text style={styles.text} numberOfLines={1}>
                  {c.key && set.layout === 'vertical' ? `${c.key}. ` : ''}
                  {c.label}
                </Text>
              </Pressable>
            ))
          : FALLBACK_KEYS.map((k) => (
              <Pressable
                key={k.key}
                testID={`answer-key-${k.key}`}
                disabled={busy}
                onPress={() => void run([{ keys: [k.key] }])}
                style={({ pressed }) => [qa.button, { opacity: pressed || busy ? 0.6 : 1 }]}
              >
                <Text style={styles.mono}>{k.label}</Text>
              </Pressable>
            ))}
      </ScrollView>
      {!set ? (
        <Text style={[styles.muted, { marginTop: 4 }]}>No options recognised on screen; answer with keys.</Text>
      ) : null}
      {error ? <Text style={[styles.muted, { color: colors.danger, marginTop: 4 }]}>{error}</Text> : null}
    </View>
  );
}

const qa = {
  wrap: {
    marginBottom: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#2a2210',
    borderWidth: 1,
    borderColor: '#5a4718',
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginRight: 8,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 260,
  },
};
