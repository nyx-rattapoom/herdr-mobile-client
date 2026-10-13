import { ScrollView, Switch, Text, View } from 'react-native';

import { Button, ErrorBox, Header, colors, styles } from './ui';

type Props = {
  publicKey: string | null;
  biometric: boolean;
  biometricAvailable: boolean;
  error: string | null;
  notice: string | null;
  onBack: () => void;
  onCreateKey: () => void;
  onCopyKey: () => void;
  onShareKey: () => void;
  onRegenerateKey: () => void;
  onToggleBiometric: (on: boolean) => void;
};

export function SettingsScreen(p: Props) {
  return (
    <View style={styles.screen} testID="settings">
      <Header title="Settings" onBack={p.onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {p.error ? <ErrorBox message={p.error} /> : null}
        {p.notice ? (
          <Text testID="notice" style={[styles.muted, { color: colors.ok }]}>
            {p.notice}
          </Text>
        ) : null}

        <Text style={[styles.text, { fontWeight: '700' }]}>Device key</Text>
        <View style={styles.card}>
          {p.publicKey ? (
            <>
              <Text style={styles.muted}>Ed25519 key generated on this device. Add the public key to ~/.ssh/authorized_keys on each server:</Text>
              <Text testID="public-key" selectable style={[styles.mono, { fontSize: 12, marginTop: 8 }]}>
                {p.publicKey}
              </Text>
              <View style={{ gap: 8, marginTop: 12 }}>
                <Button testID="copy-key" label="Copy public key" onPress={p.onCopyKey} />
                <Button testID="share-key" label="Share…" kind="secondary" onPress={p.onShareKey} />
                <Button testID="regenerate-key" label="Regenerate key" kind="danger" onPress={p.onRegenerateKey} />
              </View>
            </>
          ) : (
            <>
              <Text style={styles.muted}>No device key yet. The private key is created on this device and never leaves it.</Text>
              <View style={{ marginTop: 12 }}>
                <Button testID="create-key" label="Create device key" onPress={p.onCreateKey} />
              </View>
            </>
          )}
        </View>

        <Text style={[styles.text, { fontWeight: '700', marginTop: 8 }]}>Security</Text>
        <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.text}>Require biometrics to use saved credentials</Text>
            <Text style={styles.muted}>
              {p.biometricAvailable
                ? 'Passwords and the device private key are unlocked with your fingerprint or face when connecting.'
                : 'Unavailable: enroll a fingerprint or face in Android settings first.'}
            </Text>
          </View>
          <Switch
            testID="biometric-toggle"
            value={p.biometric}
            disabled={!p.biometricAvailable && !p.biometric}
            onValueChange={p.onToggleBiometric}
          />
        </View>

        <Text style={[styles.muted, { marginTop: 16 }]}>
          Herdr Client is an independent open-source app for Herdr servers. It talks to Herdr&apos;s public socket API over
          SSH and installs nothing on servers unless you ask it to.
        </Text>
      </ScrollView>
    </View>
  );
}
