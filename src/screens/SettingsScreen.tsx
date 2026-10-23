import { ScrollView, Switch, Text, View } from 'react-native';

import { MAX_ENTRIES, type AuditEntry } from '../store/audit';
import { Button, ErrorBox, Header, colors, styles } from './ui';

type Props = {
  publicKey: string | null;
  biometric: boolean;
  biometricAvailable: boolean;
  secureScreen: boolean;
  onToggleSecureScreen: (on: boolean) => void;
  error: string | null;
  notice: string | null;
  onBack: () => void;
  onCreateKey: () => void;
  onCopyKey: () => void;
  onShareKey: () => void;
  onRegenerateKey: () => void;
  onToggleBiometric: (on: boolean) => void;
  audit: AuditEntry[];
  onClearAudit: () => void;
};

const when = (t: number) => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function ActivityLog({ entries, onClear }: { entries: AuditEntry[]; onClear: () => void }) {
  return (
    <View style={styles.card} testID="audit-log">
      <Text style={styles.muted}>
        Closed panes, tabs and workspaces, quick answers and other approvals, kept on this device (last {MAX_ENTRIES}).
        Prompt text and secrets are never recorded.
      </Text>
      {entries.length === 0 ? (
        <Text testID="audit-empty" style={[styles.text, { marginTop: 8 }]}>
          Nothing recorded yet.
        </Text>
      ) : (
        entries.slice(0, 50).map((e, i) => (
          <View key={`${e.t}-${i}`} testID={`audit-${i}`} style={{ marginTop: 10 }}>
            <Text style={styles.text}>
              {e.action} · {e.target}
            </Text>
            <Text style={styles.muted}>
              {when(e.t)} · {e.server}
            </Text>
          </View>
        ))
      )}
      {entries.length > 50 ? <Text style={[styles.muted, { marginTop: 8 }]}>…and {entries.length - 50} older</Text> : null}
      {entries.length ? (
        <View style={{ marginTop: 12 }}>
          <Button testID="audit-clear" label="Clear activity log" kind="secondary" onPress={onClear} />
        </View>
      ) : null}
    </View>
  );
}

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

        <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.text}>Hide app content from screenshots</Text>
            <Text style={styles.muted}>Blocks screenshots, screen recording and the recent-apps preview (FLAG_SECURE).</Text>
          </View>
          <Switch testID="secure-screen-toggle" value={p.secureScreen} onValueChange={p.onToggleSecureScreen} />
        </View>

        <Text style={[styles.text, { fontWeight: '700', marginTop: 8 }]}>Activity log</Text>
        <ActivityLog entries={p.audit} onClear={p.onClearAudit} />

        <Text style={[styles.muted, { marginTop: 16 }]}>
          Herdr Client is an independent open-source app for Herdr servers. It talks to Herdr&apos;s public socket API over
          SSH and installs nothing on servers unless you ask it to.
        </Text>
      </ScrollView>
    </View>
  );
}
