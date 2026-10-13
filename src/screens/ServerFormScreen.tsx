import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { shortKey } from '../store/deviceKey';
import { authOf, validateServer, type AuthMethod, type ServerInput, type ServerProfile } from '../store/servers';
import { Button, ErrorBox, Header, colors, styles } from './ui';

type Props = {
  /** Present when editing. */
  initial?: ServerProfile;
  hasSavedPassword?: boolean;
  devicePublicKey: string | null;
  onCancel: () => void;
  onSave: (input: ServerInput, opts: { clearPassword: boolean }) => Promise<void>;
  onShowKey: () => void;
};

export function ServerFormScreen({ initial, hasSavedPassword, devicePublicKey, onCancel, onSave, onShowKey }: Props) {
  const editing = Boolean(initial);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? '');
  const [auth, setAuth] = useState<AuthMethod>(initial ? authOf(initial) : 'key');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [herdrPath, setHerdrPath] = useState(initial?.herdrPath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const input: ServerInput = { label, host, port: Number(port), username, auth, password, herdrPath };
    const err = validateServer(input, { hasSavedPassword: hasSavedPassword && !clearPassword });
    if (err) return setError(err);
    setSaving(true);
    try {
      await onSave(input, { clearPassword });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const field = (id: string, name: string, value: string, set: (v: string) => void, extra: object = {}) => (
    <View>
      <Text style={styles.label}>{name}</Text>
      <TextInput
        testID={`field-${id}`}
        style={styles.input}
        value={value}
        onChangeText={set}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.muted}
        {...extra}
      />
    </View>
  );

  const passwordHint =
    auth === 'key'
      ? 'Optional fallback, used only if the server rejects the device key.'
      : editing && hasSavedPassword
        ? 'Leave empty to keep the saved password.'
        : '';

  return (
    <View style={styles.screen}>
      <Header title={editing ? 'Edit server' : 'Add server'} onBack={onCancel} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {error ? <ErrorBox message={error} /> : null}
        {field('name', 'Name (optional)', label, setLabel, { placeholder: 'dev box' })}
        {field('host', 'Host', host, setHost, { placeholder: 'example.com', keyboardType: 'url' })}
        {field('port', 'Port', port, setPort, { keyboardType: 'number-pad' })}
        {field('user', 'User', username, setUsername)}

        <Text style={styles.label}>Authentication</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['key', 'password'] as AuthMethod[]).map((m) => (
            <Pressable
              key={m}
              testID={`auth-${m}`}
              onPress={() => setAuth(m)}
              style={[styles.card, { flex: 1, paddingVertical: 10, borderColor: auth === m ? colors.accent : colors.border }]}
            >
              <Text style={[styles.text, { textAlign: 'center', color: auth === m ? colors.accent : colors.text }]}>
                {m === 'key' ? 'Device key' : 'Password'}
              </Text>
            </Pressable>
          ))}
        </View>
        {auth === 'key' ? (
          <View style={styles.card}>
            <Text style={styles.muted}>Add this device&apos;s public key to ~/.ssh/authorized_keys on the server:</Text>
            <Text style={[styles.mono, { marginTop: 6, fontSize: 12 }]} numberOfLines={2}>
              {devicePublicKey ? shortKey(devicePublicKey) : 'No device key yet'}
            </Text>
            <Pressable testID="show-device-key" onPress={onShowKey} style={{ marginTop: 8 }}>
              <Text style={[styles.text, { color: colors.accent }]}>{devicePublicKey ? 'Copy / share public key' : 'Create device key'}</Text>
            </Pressable>
          </View>
        ) : null}

        {field('password', auth === 'key' ? 'Password (fallback)' : 'Password', password, setPassword, {
          secureTextEntry: true,
          placeholder: editing && hasSavedPassword && !clearPassword ? '••••••' : '',
        })}
        {passwordHint ? <Text style={styles.muted}>{passwordHint}</Text> : null}
        {editing && hasSavedPassword && auth === 'key' ? (
          <Pressable testID="clear-password" onPress={() => setClearPassword((v) => !v)}>
            <Text style={[styles.muted, { color: clearPassword ? colors.danger : colors.accent }]}>
              {clearPassword ? '✓ Saved password will be removed' : 'Remove saved password'}
            </Text>
          </Pressable>
        ) : null}

        {field('herdr', 'Herdr path on server (optional)', herdrPath, setHerdrPath, { placeholder: '~/.local/bin/herdr' })}
        <Text style={styles.muted}>
          Only needed if herdr is not on the login shell&apos;s PATH. Credentials are kept in Android Keystore-backed
          storage and are only sent after the host key is confirmed.
        </Text>
        <Button testID="save-server" label="Save" onPress={save} disabled={saving} />
      </ScrollView>
    </View>
  );
}
