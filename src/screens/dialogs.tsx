import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { BottomSheet, CenteredDialog } from './Sheet';
import { Button, colors, sheet, styles } from './ui';

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
    <BottomSheet animation="fade" onClose={onClose} testID="action-sheet">
      <Text style={[styles.muted, { marginBottom: 8 }]}>{title}</Text>
      {/* Landscape phones can't fit every action at once. */}
      <ScrollView style={{ flexShrink: 1, flexGrow: 0 }} testID="action-list">
        {items.map((it) => (
          <Pressable
            key={it.id}
            testID={`action-${it.id}`}
            onPress={() => onPick(it.id)}
            style={({ pressed }) => [item, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.text, { fontSize: 17, color: it.destructive ? colors.danger : colors.text }]}>
              {it.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable testID="action-cancel" onPress={onClose} style={item}>
        <Text style={[styles.text, { fontSize: 17, color: colors.muted }]}>Cancel</Text>
      </Pressable>
    </BottomSheet>
  );
}

export function PromptDialog({
  title,
  placeholder,
  okLabel = 'Create',
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder?: string;
  okLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <CenteredDialog onClose={onClose}>
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
      <Button testID="prompt-ok" label={okLabel} onPress={() => onSubmit(value)} />
      <Button testID="prompt-cancel" label="Cancel" kind="secondary" onPress={onClose} />
    </View>
    </CenteredDialog>
  );
}

const item = { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border };
