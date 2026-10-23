import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { CONNECT_STEPS, progressFraction, type ConnectProgress } from '../live/connectSteps';
import { Button, colors, styles } from './ui';

export function ConnectScreen({ progress, onCancel }: { progress: ConnectProgress; onCancel: () => void }) {
  const [now, setNow] = useState(progress.startedAt);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  return (
    <View style={[styles.center, { alignItems: 'stretch' }]} testID="connect-progress">
      <Text style={[styles.title, { flex: 0, textAlign: 'center' }]}>Connecting</Text>
      <Text style={[styles.muted, { textAlign: 'center', marginTop: 4 }]} testID="connect-target">
        {progress.target} · {elapsed}s
      </Text>
      <View style={bar.track}>
        <View style={[bar.fill, { width: `${Math.round(progressFraction(progress.step) * 100)}%` }]} />
      </View>
      <Text style={[styles.text, { textAlign: 'center', marginBottom: 16 }]} testID="connect-step">
        Step {progress.step + 1} of {CONNECT_STEPS.length}
      </Text>
      {CONNECT_STEPS.map((name, i) => {
        const done = i < progress.step;
        const current = i === progress.step;
        return (
          <View key={name} style={bar.row} testID={`connect-step-${i + 1}`}>
            <View style={bar.icon}>
              {current ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Text style={{ color: done ? colors.ok : colors.border, fontSize: 16 }}>{done ? '✓' : '○'}</Text>
              )}
            </View>
            <Text style={[styles.text, { flex: 1, color: done || current ? colors.text : colors.muted }]}>{name}</Text>
            {progress.notes[i] ? <Text style={styles.muted}>{progress.notes[i]}</Text> : null}
          </View>
        );
      })}
      <View style={{ marginTop: 24 }}>
        <Button testID="connect-cancel" label="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

const bar = {
  track: { height: 6, borderRadius: 3, backgroundColor: colors.card, marginVertical: 16, overflow: 'hidden' as const },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingVertical: 6 },
  icon: { width: 24, alignItems: 'center' as const },
};
