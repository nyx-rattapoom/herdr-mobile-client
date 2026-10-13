import { ScrollView, Text, View } from 'react-native';

import type { PinDecision } from '../ssh/pinning';
import type { ServerProfile } from '../store/servers';
import { Button, Header, colors, styles } from './ui';

type Props = {
  server: ServerProfile;
  decision: Extract<PinDecision, { kind: 'unpinned' | 'mismatch' }>;
  onTrust: () => void;
  onCancel: () => void;
};

export function HostKeyScreen({ server, decision, onTrust, onCancel }: Props) {
  const endpoint = `${server.host}:${server.port}`;
  if (decision.kind === 'mismatch') {
    return (
      <View style={styles.screen} testID="hostkey-mismatch">
        <Header title="Host key changed" onBack={onCancel} />
        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.card, { borderColor: colors.danger }]}>
            <Text style={[styles.text, { color: colors.danger, fontWeight: '700' }]}>Connection blocked</Text>
            <Text style={[styles.text, { marginTop: 8 }]}>
              {endpoint} presented a different host key than the one you pinned. Someone may be intercepting the
              connection, or the server was reinstalled. No credentials were sent.
            </Text>
          </View>
          <Text style={styles.label}>Pinned</Text>
          <Text testID="pinned-fingerprint" style={styles.mono} selectable>
            {decision.pin.algorithm} {decision.pin.fingerprint}
          </Text>
          <Text style={styles.label}>Presented now</Text>
          <Text testID="presented-fingerprint" style={[styles.mono, { color: colors.danger }]} selectable>
            {decision.presented.algorithm} {decision.presented.fingerprint}
          </Text>
          <Text style={styles.muted}>
            If you verified the change with the server's administrator, long-press the server in the list and choose
            "Forget host key", then connect again.
          </Text>
          <Button testID="hostkey-back" label="Back to servers" kind="secondary" onPress={onCancel} />
        </ScrollView>
      </View>
    );
  }

  const k = decision.presented;
  return (
    <View style={styles.screen} testID="hostkey-confirm">
      <Header title="Verify host key" onBack={onCancel} />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.text}>
          First connection to <Text style={{ fontWeight: '700' }}>{endpoint}</Text>. Check that this fingerprint
          matches the server before trusting it. Nothing has been sent to the server yet.
        </Text>
        <View style={styles.card}>
          <Text style={styles.label}>{k.algorithm}</Text>
          <Text testID="fingerprint" style={styles.mono} selectable>
            {k.fingerprint}
          </Text>
        </View>
        <Text style={styles.muted}>On the server: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</Text>
        <Button testID="trust-hostkey" label="Trust and connect" onPress={onTrust} />
        <Button testID="reject-hostkey" label="Cancel" kind="secondary" onPress={onCancel} />
      </ScrollView>
    </View>
  );
}
