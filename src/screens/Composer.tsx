import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SPECIAL_KEYS, describeActionError, inputRequest, keyRequest, keysOf } from '../live/actions';
import type { Line } from '../live/ansi';
import { getDraft, setDraft } from '../live/drafts';
import { appendedChar, cleanPaste, modifiedChar, modifiedKey, type Modifier } from '../live/keys';
import type { LiveSession } from '../live/LiveSession';
import type { PromptQueues } from '../live/promptQueue';
import { QueueList } from './QueueList';
import { QuickAnswers } from './QuickAnswers';
import { colors, styles } from './ui';

type Props = {
  live: LiveSession;
  paneId: string;
  /** Identifies this pane's draft (see drafts.ts). */
  draftKey: string;
  /** The pane runs a detected agent; enables the agent-prompt mode. */
  hasAgent: boolean;
  /** A blocked agent wants an answer typed into the pane, not a new prompt. */
  agentBlocked?: boolean;
  /** Re-read output right after input so the echo shows up quickly. */
  onSent: () => void;
  /** The pane has nothing on screen yet. */
  paneBlank?: boolean;
  /** The pane's parsed output, for answer options while the agent is blocked. */
  screen?: Line[];
  agentName?: string;
  /** Called after a quick answer was sent. */
  onAnswered?: (label: string) => void;
  /** The session's prompt queue: agent prompts wait here while the agent works. */
  queue?: PromptQueues;
  agentStatus?: string;
};

type Mode = 'submit' | 'type' | 'prompt';
const modeLabel: Record<Mode, string> = { submit: 'Line ⏎', type: 'Text only', prompt: 'Agent prompt' };

/**
 * Multi-line input for a pane: agent prompts, lines (with Enter) or raw text, plus special keys
 * behind the ⌨ button. The draft is kept per pane while the app runs; the expand button opens a
 * full-screen editor on the same draft.
 */
export function Composer({
  live,
  paneId,
  draftKey,
  hasAgent,
  agentBlocked,
  onSent,
  paneBlank,
  screen,
  agentName,
  onAnswered,
  queue,
  agentStatus,
}: Props) {
  const [text, setTextState] = useState(() => getDraft(draftKey));
  const [mode, setMode] = useState<Mode>(hasAgent && !agentBlocked ? 'prompt' : 'submit');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // For sudo/password prompts: hide what is typed, keep it out of suggestions and out of drafts.
  const [hidden, setHidden] = useState(false);
  /** One-shot Ctrl/Alt: applies to the next key or typed character, then resets. */
  const [armed, setArmed] = useState<Modifier | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const modes: Mode[] = hasAgent ? ['prompt', 'submit', 'type'] : ['submit', 'type'];
  // Landscape phones: keep the input short so the pane stays visible.
  const short = useWindowDimensions().height < 500;
  const insets = useSafeAreaInsets();

  const setText = (t: string) => {
    if (armed) {
      setArmed(null);
      const ch = appendedChar(text, t);
      const key = ch ? modifiedChar(armed, ch) : null;
      if (key) {
        // The character goes to the pane as a key combination instead of into the input.
        void send(keyRequest(paneId, key), false);
        return;
      }
    }
    setTextState(t);
    setDraft(draftKey, hidden ? '' : t);
  };

  const pressKey = (k: (typeof SPECIAL_KEYS)[number]) => {
    const keys = keysOf(k);
    const mod = armed;
    setArmed(null);
    void send(keyRequest(paneId, mod && keys.length === 1 ? modifiedKey(mod, keys[0]) : keys), false);
  };

  const paste = async () => {
    setNote(null);
    const { text: clean, removed, truncated } = cleanPaste(await Clipboard.getStringAsync());
    if (!clean) {
      setNote('The clipboard has no text to paste.');
      return;
    }
    if (await send({ method: 'pane.send_text', params: { pane_id: paneId, text: clean } }, false)) {
      const notes = [
        removed ? `removed ${removed} control character${removed === 1 ? '' : 's'}` : '',
        truncated ? `cut to the first ${Math.round(clean.length / 1024)} KB` : '',
      ].filter(Boolean);
      setNote(`Pasted ${clean.length} characters${notes.length ? ` (${notes.join(', ')})` : ''}.`);
    }
  };

  const send = async (req: { method: string; params: Record<string, unknown> }, clear: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await live.query(req.method, req.params);
      if (clear) setText('');
      onSent();
      return true;
    } catch (e) {
      setError(describeActionError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!text && mode !== 'submit') return;
    // While the agent works or waits for an answer (or earlier prompts still wait), agent prompts
    // join the queue. A blocked agent's queue stays paused, so this never answers its question.
    const busyAgent = agentStatus === 'working' || agentStatus === 'blocked';
    if (mode === 'prompt' && queue && (busyAgent || queue.items(paneId).length > 0)) {
      try {
        await queue.add(paneId, text);
        setText('');
        setNote('Queued: sends when the agent finishes.');
        if (expanded) setExpanded(false);
      } catch (e) {
        setError(describeActionError(e));
      }
      return;
    }
    if ((await send(inputRequest(paneId, text, mode), true)) && expanded) setExpanded(false);
  };

  const placeholder = hidden
    ? 'Hidden input (e.g. password)…'
    : mode === 'prompt'
      ? 'Prompt the agent…'
      : 'Type a command…';
  const modeButton = (
    <Pressable
      testID="input-mode"
      onPress={() => setMode(modes[(modes.indexOf(mode) + 1) % modes.length])}
      style={bar.mode}
    >
      <Text style={[styles.muted, { color: mode === 'prompt' ? colors.accent : colors.muted }]}>{modeLabel[mode]}</Text>
    </Pressable>
  );

  return (
    <View style={bar.wrap} testID="input-bar">
      {agentBlocked && screen ? (
        <QuickAnswers
          live={live}
          paneId={paneId}
          agent={agentName}
          screen={screen}
          onSent={onSent}
          onAnswered={onAnswered}
        />
      ) : null}
      {error ? (
        <Text testID="input-error" style={[styles.muted, { color: colors.danger, marginBottom: 6 }]}>
          {error}
        </Text>
      ) : note ? (
        <Text testID="input-note" style={[styles.muted, { marginBottom: 6 }]}>
          {note}
        </Text>
      ) : mode === 'prompt' && paneBlank ? (
        // Herdr can report an agent as idle before its UI is drawn; a prompt sent then is lost.
        <Text testID="input-not-ready" style={[styles.muted, { marginBottom: 6 }]}>
          The agent hasn&apos;t drawn anything yet. A prompt sent now may be lost; wait for its screen to appear.
        </Text>
      ) : null}
      {keysOpen ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          style={{ marginBottom: 8 }}
          testID="key-row"
        >
          {(['ctrl', 'alt'] as const).map((m) => (
            <Pressable
              key={m}
              testID={`mod-${m}`}
              accessibilityLabel={`${m === 'ctrl' ? 'Ctrl' : 'Alt'} for the next key${armed === m ? ' (armed)' : ''}`}
              onPress={() => setArmed((a) => (a === m ? null : m))}
              style={[bar.key, armed === m ? { backgroundColor: colors.accent, borderColor: colors.accent } : null]}
            >
              <Text style={[bar.keyText, { color: armed === m ? '#fff' : colors.text }]}>
                {m === 'ctrl' ? 'Ctrl' : 'Alt'}
              </Text>
            </Pressable>
          ))}
          <Pressable
            testID="key-paste"
            accessibilityLabel="Paste clipboard into the pane"
            disabled={busy}
            onPress={() => void paste()}
            style={({ pressed }) => [bar.key, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={bar.keyText}>Paste</Text>
          </Pressable>
          <Pressable
            testID="input-hidden"
            accessibilityLabel={hidden ? 'Show typed text' : 'Hide typed text'}
            onPress={() => {
              setHidden((h) => !h);
              setDraft(draftKey, '');
            }}
            style={[bar.key, hidden ? { backgroundColor: colors.accent } : null]}
          >
            <Text style={[bar.keyText, { color: hidden ? '#fff' : colors.text }]}>{hidden ? '●●' : 'Aa'}</Text>
          </Pressable>
          {SPECIAL_KEYS.map((k) => (
            <Pressable
              key={k.key}
              testID={`key-${k.key}`}
              disabled={busy}
              onPress={() => pressKey(k)}
              style={({ pressed }) => [bar.key, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={bar.keyText}>{k.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>
        <View style={{ gap: 6 }}>
          {modeButton}
          <Pressable
            testID="input-keys"
            accessibilityLabel={keysOpen ? 'Hide special keys' : 'Show special keys'}
            onPress={() => setKeysOpen((o) => !o)}
            style={[bar.mode, keysOpen ? { borderColor: colors.accent } : null]}
          >
            <Text style={[styles.muted, { textAlign: 'center' }]}>⌨ keys</Text>
          </Pressable>
        </View>
        <TextInput
          testID="input-text"
          secureTextEntry={hidden}
          multiline={!hidden}
          style={[styles.input, bar.input, short ? { minHeight: 40, maxHeight: 80 } : null]}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          // Single-line hidden input submits on Enter; multi-line Enter adds a newline.
          onSubmitEditing={hidden ? () => void submit() : undefined}
          blurOnSubmit={false}
        />
        <View style={{ gap: 6 }}>
          <Pressable
            testID="input-expand"
            accessibilityLabel="Open full-screen editor"
            disabled={hidden}
            onPress={() => setExpanded(true)}
            style={[bar.mode, { alignItems: 'center', opacity: hidden ? 0.4 : 1 }]}
          >
            <Text style={styles.muted}>Expand</Text>
          </Pressable>
          <Pressable
            testID="input-send"
            disabled={busy}
            onPress={() => void submit()}
            style={[bar.send, { opacity: busy ? 0.5 : 1 }]}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>Send</Text>
          </Pressable>
        </View>
      </View>
      {queue ? <QueueList queue={queue} paneId={paneId} onSent={onSent} /> : null}
      {expanded ? (
        <Modal statusBarTranslucent navigationBarTranslucent animationType="slide" onRequestClose={() => setExpanded(false)}>
          {/* The modal window is edge-to-edge and outside the root SafeAreaView: pad for the system
              bars here, outside the KeyboardAvoidingView, which overwrites its own paddingBottom. */}
          <View
            style={[
              styles.screen,
              {
                paddingTop: insets.top + 12,
                paddingBottom: insets.bottom + 12,
                paddingLeft: insets.left + 12,
                paddingRight: insets.right + 12,
              },
            ]}
          >
            <KeyboardAvoidingView behavior="padding" style={[styles.screen, { gap: 8 }]} testID="editor">
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable testID="editor-collapse" onPress={() => setExpanded(false)} hitSlop={8}>
                  <Text style={styles.backText}>
                    <Text style={{ fontSize: 20 }}>⤡</Text> Collapse
                  </Text>
                </Pressable>
                <View style={{ flex: 1 }} />
                {modeButton}
              </View>
              {error ? <Text style={[styles.muted, { color: colors.danger }]}>{error}</Text> : null}
              <TextInput
                testID="editor-text"
                autoFocus
                multiline
                textAlignVertical="top"
                style={[styles.input, { flex: 1, fontFamily: 'monospace', fontSize: 15 }]}
                value={text}
                onChangeText={setText}
                placeholder={placeholder}
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                testID="editor-send"
                disabled={busy}
                onPress={() => void submit()}
                style={[bar.send, { alignItems: 'center', paddingVertical: 14, opacity: busy ? 0.5 : 1 }]}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>Send</Text>
              </Pressable>
            </KeyboardAvoidingView>
          </View>
        </Modal>
      ) : null}
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
  mode: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.card,
  },
  input: {
    flex: 1,
    paddingVertical: 8,
    fontFamily: 'monospace',
    fontSize: 14,
    minHeight: 76,
    maxHeight: 140,
    textAlignVertical: 'top' as const,
  },
  send: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
};
