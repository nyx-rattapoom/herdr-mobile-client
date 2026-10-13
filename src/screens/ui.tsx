import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export const colors = {
  bg: '#0f1115',
  card: '#1a1d24',
  border: '#2a2e38',
  text: '#e8eaf0',
  muted: '#9aa1b2',
  accent: '#4f8cff',
  danger: '#ff5a5f',
  warn: '#f5b041',
  ok: '#3ecf8e',
};

export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable testID="back" onPress={onBack} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
      ) : null}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {right}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  testID?: string;
}) {
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? colors.danger : colors.card;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.muted, { marginTop: 12 }]}>{label}</Text>
    </View>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <View style={styles.errorBox} testID="error">
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  back: { paddingRight: 4 },
  backText: { color: colors.accent, fontSize: 16 },
  title: { color: colors.text, fontSize: 20, fontWeight: '600', flex: 1 },
  body: { padding: 16, gap: 12 },
  card: { backgroundColor: colors.card, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: colors.border },
  text: { color: colors.text, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  mono: { color: colors.text, fontFamily: 'monospace', fontSize: 14 },
  label: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: { borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorBox: { backgroundColor: '#3a1518', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: colors.danger },
  errorText: { color: '#ffd6d7', fontSize: 14 },
});

/** Bottom-sheet styles shared by the workspace and agents sheets. */
export const sheet = {
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' as const },
  panel: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
};
