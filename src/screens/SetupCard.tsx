import { ActivityIndicator, Text, View } from 'react-native';

import { Button, ErrorBox, colors, styles } from './ui';

export type SetupState =
  | { kind: 'install'; busy?: boolean; error?: string }
  | { kind: 'start'; busy?: boolean; error?: string };

type Props = { state: SetupState; host: string; user: string; onInstall: () => void; onStart: () => void };

export function SetupCard({ state, host, user, onInstall, onStart }: Props) {
  const install = state.kind === 'install';
  return (
    <View style={[styles.card, { borderColor: colors.warn, gap: 8 }]} testID={`setup-${state.kind}`}>
      <Text style={[styles.text, { fontWeight: '700' }]}>
        {install ? `Herdr is not installed on ${host}` : `Herdr is not running on ${host}`}
      </Text>
      <Text style={styles.muted}>
        {install
          ? `This downloads and runs https://herdr.dev/install.sh as ${user} on ${host}. The script installs the herdr binary into ~/.local/bin after checking its SHA-256 against Herdr's release manifest. Only run it if you trust herdr.dev; the script itself is trusted through HTTPS only. Afterwards a background Herdr server is started.`
          : 'Start a background Herdr server for the default session. It keeps running after you disconnect.'}
      </Text>
      {state.error ? <ErrorBox message={state.error} /> : null}
      {state.busy ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.muted}>{install ? 'Installing… this can take a minute.' : 'Starting…'}</Text>
        </View>
      ) : (
        <Button
          testID={install ? 'install-herdr' : 'start-herdr'}
          label={install ? (state.error ? 'Try again' : 'Install Herdr') : 'Start Herdr'}
          onPress={install ? onInstall : onStart}
        />
      )}
    </View>
  );
}
