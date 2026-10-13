import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, Text, TextInput, View } from 'react-native';

import { Button, colors, styles } from './ui';

export type SheetItem = { id: string; label: string; destructive?: boolean };

export function ActionSheet({
  title,
  items,
  onPick,
  onClose,
}: {
  title: string;
  items: SheetItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={sheet.backdrop} onPress={onClose} testID="sheet-backdrop">
        <View style={sheet.panel} testID="action-sheet">
          <Text style={[styles.muted, { marginBottom: 8 }]}>{title}</Text>
          {items.map((it) => (
            <Pressable
              key={it.id}
              testID={`action-${it.id}`}
              onPress={() => onPick(it.id)}
              style={({ pressed }) => [sheet.item, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.text, { fontSize: 17, color: it.destructive ? colors.danger : colors.text }]}>{it.label}</Text>
            </Pressable>
          ))}
          <Pressable testID="action-cancel" onPress={onClose} style={sheet.item}>
            <Text style={[styles.text, { fontSize: 17, color: colors.muted }]}>Cancel</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

export function PromptDialog({
  title,
  placeholder,
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={[sheet.backdrop, { justifyContent: 'center', padding: 16 }]}>
        <View style={[sheet.panel, { gap: 12, borderRadius: 16, paddingBottom: 16 }]} testID="prompt-dialog">
          <Text style={styles.text}>{title}</Text>
          <TextInput
            testID="prompt-input"
            autoFocus
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => onSubmit(value)}
          />
          <Button testID="prompt-ok" label="Create" onPress={() => onSubmit(value)} />
          <Button testID="prompt-cancel" label="Cancel" kind="secondary" onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const sheet = {
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' as const },
  panel: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
  },
  item: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
};
