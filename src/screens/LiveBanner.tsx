import { Text, View } from 'react-native';

import type { LiveSession, LiveState, LiveStatus } from '../live/LiveSession';
import { Button, ErrorBox, colors, styles } from './ui';

export const liveLabel: Record<LiveStatus, [string, string]> = {
  connecting: ['connecting…', colors.muted],
  live: ['● live', colors.ok],
  reconnecting: ['reconnecting…', colors.warn],
  offline: ['offline', colors.danger],
  unsupported: ['not supported', colors.danger],
};

/** "● live · herdr 0.9.3" plus anything after it, e.g. the host. */
export function LiveStatusLine({ st, testID, extra }: { st: LiveState; testID?: string; extra?: string }) {
  const [label, color] = liveLabel[st.status];
  const version = st.snapshot?.version ?? st.server?.version;
  return (
    <Text testID={testID} style={[styles.muted, { color }]} numberOfLines={1}>
      {label}
      {extra ? `  ·  ${extra}` : ''}
      {version ? `  ·  herdr ${version}` : ''}
    </Text>
  );
}

/** What to do when the live view isn't live: retry, reconnect SSH, or the too-old alert. */
export function LiveBanner({
  live,
  st,
  session,
  onReconnect,
}: {
  live: LiveSession;
  st: LiveState;
  session: string;
  onReconnect?: () => void;
}) {
  if (st.status === 'unsupported') {
    return (
      <View testID={`unsupported-${session}`}>
        <ErrorBox message={st.error ?? 'This server is not supported.'} />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <View style={{ flex: 1 }}>
            <Button testID={`recheck-${session}`} label="Check again" onPress={() => live.retryNow()} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              testID={`continue-${session}`}
              label="Continue anyway"
              kind="secondary"
              onPress={() => live.continueAnyway()}
            />
          </View>
        </View>
        <Text style={[styles.muted, { marginTop: 4 }]}>Continuing may leave some features broken.</Text>
      </View>
    );
  }
  return (
    <>
      {st.status !== 'live' && st.error ? <Text style={styles.muted}>{st.error}</Text> : null}
      {st.status === 'reconnecting' ? (
        <View style={{ marginTop: 8 }}>
          <Button testID={`retry-${session}`} label="Retry now" kind="secondary" onPress={() => live.retryNow()} />
        </View>
      ) : null}
      {st.status === 'offline' && onReconnect ? (
        <View style={{ marginTop: 8 }}>
          <Button testID="reconnect" label="Reconnect" onPress={onReconnect} />
        </View>
      ) : null}
    </>
  );
}
