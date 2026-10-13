import { FlatList, Pressable, Text, View } from 'react-native';

import { authOf, type ServerProfile } from '../store/servers';
import { Button, ErrorBox, Header, colors, styles } from './ui';

type Props = {
  servers: ServerProfile[];
  error: string | null;
  onAdd: () => void;
  onOpen: (s: ServerProfile) => void;
  onManage: (s: ServerProfile) => void;
  onSettings: () => void;
};

export function ServersScreen({ servers, error, onAdd, onOpen, onManage, onSettings }: Props) {
  return (
    <View style={styles.screen}>
      <Header
        title="Servers"
        right={
          <Pressable testID="open-settings" onPress={onSettings} hitSlop={12}>
            <Text style={[styles.text, { color: colors.accent }]}>Settings</Text>
          </Pressable>
        }
      />
      <View style={styles.body}>
        {error ? <ErrorBox message={error} /> : null}
        <FlatList
          data={servers}
          keyExtractor={(s) => s.id}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={<Text style={styles.muted}>No servers yet. Add one to connect to Herdr over SSH.</Text>}
          renderItem={({ item }) => (
            <Pressable
              testID={`server-${item.label}`}
              onPress={() => onOpen(item)}
              onLongPress={() => onManage(item)}
              style={({ pressed }) => [styles.card, { opacity: pressed ? 0.8 : 1 }]}
            >
              <Text style={styles.text}>{item.label}</Text>
              <Text style={styles.muted}>
                {item.username}@{item.host}:{item.port} · {authOf(item) === 'key' ? 'device key' : 'password'}
              </Text>
            </Pressable>
          )}
        />
        <Button testID="add-server" label="Add server" onPress={onAdd} />
        {servers.length > 0 ? (
          <Text style={[styles.muted, { color: colors.muted }]}>Long-press a server to edit it, forget its host key or remove it.</Text>
        ) : null}
      </View>
    </View>
  );
}
