import { useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { corePlatformAvailable } from '../core/platform';
import { shortKey } from '../store/deviceKey';
import { authOf, backendOf, validateServer, type AuthMethod, type BackendKind, type JumpOption, type ServerInput, type ServerProfile } from '../store/servers';
import { Button, ErrorBox, Header, colors, styles } from './ui';

type Props = {
  initial?: ServerProfile;
  initialRoute?: string;
  hasSavedPassword?: boolean;
  devicePublicKey: string | null;
  jumpOptions: JumpOption[];
  onCancel: () => void;
  onSave: (input: ServerInput, opts: { clearPassword: boolean }) => Promise<void>;
  onShowKey: () => void;
};

export function ServerFormScreen({ initial, initialRoute, hasSavedPassword, devicePublicKey, jumpOptions, onCancel, onSave, onShowKey }: Props) {
  const editing = Boolean(initial);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? '');
  const [auth, setAuth] = useState<AuthMethod>(initial ? authOf(initial) : 'key');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [herdrPath, setHerdrPath] = useState(initial?.herdrPath ?? '');
  const [backend, setBackend] = useState<BackendKind>(initial ? backendOf(initial) : 'legacy');
  const [hcPath, setHcPath] = useState(initial?.hcPath ?? '');
  const [jumpId, setJumpId] = useState<string | undefined>(initial?.jumpId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canCore = corePlatformAvailable();

  const save = async () => {
    const input: ServerInput = { label, host, port: Number(port), username, auth, password, herdrPath, backend, hcPath, jumpId };
    const err = validateServer(input, { hasSavedPassword: hasSavedPassword && !clearPassword });
    if (err) return setError(err);
    setSaving(true);
    setPassword('');
    try {
      await onSave(input, { clearPassword });
    } catch (e) {
      setPassword(password);
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
        {jumpOptions.length > 0 || jumpId ? (
          <View>
            <Text style={styles.label}>Connect via</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {[{ id: undefined, label: 'Direct', route: [] as string[] }, ...jumpOptions].map((o) => {
                const on = jumpId === o.id;
                return (
                  <Pressable
                    key={o.id ?? 'direct'}
                    testID={`jump-${o.id ?? 'direct'}`}
                    onPress={() => setJumpId(o.id)}
                    style={[styles.card, { paddingVertical: 8, paddingHorizontal: 12, borderColor: on ? colors.accent : colors.border }]}
                  >
                    <Text style={[styles.text, { color: on ? colors.accent : colors.text }]}>
                      {o.route.length > 1 ? `${o.label} (via ${o.route.slice(0, -1).join(' → ')})` : o.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {jumpId ? (
              <Text style={styles.muted}>
                Route: {[...(jumpOptions.find((o) => o.id === jumpId)?.route ?? [initial?.jumpId === jumpId && initialRoute ? initialRoute : 'unavailable server']), 'this server'].join(' → ')}
                {'\n'}Hops through each server in turn (like ssh -J). Use the host as the last hop sees it, e.g. a LAN IP.
              </Text>
            ) : null}
          </View>
        ) : null}
        {field('host', 'Host', host, setHost, { placeholder: jumpId ? '192.168.1.20' : 'example.com', keyboardType: 'url' })}
        {field('port', 'Port', port, setPort, { keyboardType: 'number-pad' })}
        {field('user', 'User', username, setUsername)}

        <Text style={styles.label}>Server type</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['legacy', 'core'] as BackendKind[]).map((m) => {
            const on = backend === m;
            const disabled = m === 'core' && !canCore;
            return (
              <Pressable
                key={m}
                testID={`backend-${m}`}
                accessibilityRole="button"
                disabled={disabled}
                onPress={() => setBackend(m)}
                style={[
                  styles.card,
                  { flex: 1, paddingVertical: 10, borderColor: on ? colors.accent : colors.border, opacity: disabled ? 0.5 : 1 },
                ]}
              >
                <Text style={[styles.text, { textAlign: 'center', color: on ? colors.accent : colors.text }]}>
                  {m === 'legacy' ? 'Herdr TUI' : 'Herdr Core'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.muted}>
          {backend === 'core'
            ? canCore
              ? 'Herdr Core streams terminal output over `hc connect` and shares seen/pin state with the desktop.'
              : 'Herdr Core is Android-only for now. This profile will not connect on iOS; choose Herdr TUI to use it here.'
            : 'Herdr TUI uses the existing Herdr socket and polling. This stays the default for new and existing profiles.'}
        </Text>

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
          autoComplete: 'off',
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
        {backend === 'core' ? (
          <View>
            {field('hc', 'hc path on server (optional)', hcPath, setHcPath, { placeholder: '~/.local/bin/hc' })}
            <Text style={styles.muted}>
              Herdr Core needs `hc` on the server (the herdr-core package). The app runs `hc connect` over SSH; it never
              installs or upgrades hc. Herdr TUI keeps its own path above, so switching back does not lose either one.
            </Text>
          </View>
        ) : null}
        <Text style={styles.muted}>
          Only needed if herdr is not on the login shell&apos;s PATH. Credentials are kept in{' '}
          {Platform.OS === 'ios' ? 'the iOS Keychain' : 'Android Keystore-backed storage'} and are only sent after the
          host key is confirmed.
        </Text>
        <Button testID="save-server" label="Save" onPress={save} disabled={saving} />
      </ScrollView>
    </View>
  );
}
