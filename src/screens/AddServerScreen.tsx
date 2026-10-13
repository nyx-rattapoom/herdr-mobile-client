import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { validateServer, type ServerInput } from '../store/servers';
import { Button, ErrorBox, Header, colors, styles } from './ui';

type Props = { onCancel: () => void; onSave: (input: ServerInput) => Promise<void> };

export function AddServerScreen({ onCancel, onSave }: Props) {
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const input: ServerInput = { label, host, port: Number(port), username, password };
    const err = validateServer(input);
    if (err) return setError(err);
    setSaving(true);
    try {
      await onSave(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const field = (name: string, value: string, set: (v: string) => void, extra: object = {}) => (
    <View>
      <Text style={styles.label}>{name}</Text>
      <TextInput
        testID={`field-${name.toLowerCase().split(' ')[0]}`}
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

  return (
    <View style={styles.screen}>
      <Header title="Add server" onBack={onCancel} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {error ? <ErrorBox message={error} /> : null}
        {field('Name (optional)', label, setLabel, { placeholder: 'dev box' })}
        {field('Host', host, setHost, { placeholder: 'example.com', keyboardType: 'url' })}
        {field('Port', port, setPort, { keyboardType: 'number-pad' })}
        {field('User', username, setUsername)}
        {field('Password', password, setPassword, { secureTextEntry: true })}
        <Text style={styles.muted}>
          The password is stored in Android Keystore-backed storage and is sent only after you have confirmed the
          server's host key.
        </Text>
        <Button testID="save-server" label="Save" onPress={save} disabled={saving} />
      </ScrollView>
    </View>
  );
}
