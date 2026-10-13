import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { SPECIAL_KEYS, describeActionError, inputRequest, keyRequest } from '../live/actions';
import type { LiveSession } from '../live/LiveSession';
import { colors, styles } from './ui';

type Props = {
  live: LiveSession;
  paneId: string;
  /** The pane runs a detected agent; enables the agent-prompt mode. */
  hasAgent: boolean;
  /** Re-read output right after input so the echo shows up quickly. */
  onSent: () => void;
};

type Mode = 'submit' | 'type' | 'prompt';
const modeLabel: Record<Mode, string> = { submit: 'Line ⏎', type: 'Text only', prompt: 'Agent prompt' };

export function InputBar({ live, paneId, hasAgent, onSent }: Props) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>(hasAgent ? 'prompt' : 'submit');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const modes: Mode[] = hasAgent ? ['prompt', 'submit', 'type'] : ['submit', 'type'];

  const send = async (req: { method: string; params: Record<string, unknown> }, clear: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await live.query(req.method, req.params);
      if (clear) setText('');
      onSent();
    } catch (e) {
      setError(describeActionError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!text && mode !== 'submit') return;
    void send(inputRequest(paneId, text, mode), true);
  };

  return (
    <View style={bar.wrap} testID="input-bar">
      {error ? (
        <Text testID="input-error" style={[styles.muted, { color: colors.danger, marginBottom: 6 }]}>
          {error}
        </Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
        {SPECIAL_KEYS.map((k) => (
          <Pressable
            key={k.key}
            testID={`key-${k.key}`}
            disabled={busy}
            onPress={() => void send(keyRequest(paneId, k.key), false)}
            style={({ pressed }) => [bar.key, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={bar.keyText}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <Pressable
          testID="input-mode"
          onPress={() => setMode(modes[(modes.indexOf(mode) + 1) % modes.length])}
          style={bar.mode}
        >
          <Text style={[styles.muted, { color: mode === 'prompt' ? colors.accent : colors.muted }]}>{modeLabel[mode]}</Text>
        </Pressable>
        <TextInput
          testID="input-text"
          style={[styles.input, { flex: 1, paddingVertical: 8, fontFamily: 'monospace', fontSize: 14 }]}
          value={text}
          onChangeText={setText}
          placeholder={mode === 'prompt' ? 'Prompt the agent…' : 'Type a command…'}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        <Pressable testID="input-send" disabled={busy} onPress={submit} style={[bar.send, { opacity: busy ? 0.5 : 1 }]}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const bar = {
  wrap: { padding: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg },
  key: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 6,
    borderRadius: 6,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyText: { color: colors.text, fontFamily: 'monospace', fontSize: 14 },
  mode: { paddingHorizontal: 8, paddingVertical: 10, borderRadius: 6, backgroundColor: colors.card },
  send: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
};
