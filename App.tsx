import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { fetchSnapshot, buildTree } from './src/protocol/snapshot';
import { AddServerScreen } from './src/screens/AddServerScreen';
import { HostKeyScreen } from './src/screens/HostKeyScreen';
import { SessionsScreen, type SessionView } from './src/screens/SessionsScreen';
import { ServersScreen } from './src/screens/ServersScreen';
import { Busy, colors } from './src/screens/ui';
import { ServerConnection, describeSshError, probeHostKey } from './src/ssh/connection';
import { PinStore, decidePin, type HostKeyPin, type KeyValueStore, type PinDecision } from './src/ssh/pinning';
import { ServerStore, type ServerProfile } from './src/store/servers';

const secureKv: KeyValueStore = {
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItem: (k) => SecureStore.deleteItemAsync(k),
};

type Route =
  | { name: 'servers' }
  | { name: 'add' }
  | { name: 'busy'; label: string }
  | { name: 'hostkey'; server: ServerProfile; decision: Extract<PinDecision, { kind: 'unpinned' | 'mismatch' }> }
  | { name: 'sessions'; server: ServerProfile; views: SessionView[]; herdrFound: boolean };

export default function App() {
  const servers = useMemo(() => new ServerStore(secureKv), []);
  const pins = useMemo(() => new PinStore(secureKv), []);
  const [list, setList] = useState<ServerProfile[]>([]);
  const [route, setRoute] = useState<Route>({ name: 'servers' });
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const conn = useRef<ServerConnection | null>(null);

  const reload = useCallback(() => servers.list().then(setList), [servers]);
  useEffect(() => {
    reload();
  }, [reload]);

  const home = useCallback(() => {
    conn.current?.close();
    conn.current = null;
    setRoute({ name: 'servers' });
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'servers') return false;
      home();
      return true;
    });
    return () => sub.remove();
  }, [route.name, home]);

  const loadSessions = useCallback(async (server: ServerProfile, c: ServerConnection) => {
    const discovery = await c.discoverSessions();
    const views = await Promise.all(
      discovery.sessions.map(async (session): Promise<SessionView> => {
        if (!session.running) return { session };
        try {
          const client = await c.openHerdr(session.socketPath);
          try {
            const snap = await fetchSnapshot(client);
            return { session, tree: buildTree(snap), version: snap.version };
          } finally {
            client.close();
          }
        } catch (e) {
          return { session, error: describeSshError(e) };
        }
      }),
    );
    setRoute({ name: 'sessions', server, views, herdrFound: discovery.herdrFound });
  }, []);

  const connectPinned = useCallback(
    async (server: ServerProfile, pin: HostKeyPin) => {
      setRoute({ name: 'busy', label: 'Authenticating…' });
      const password = await servers.password(server.id);
      if (!password) throw new Error('No saved password for this server');
      const c = await ServerConnection.open({ ...server, password }, pin);
      conn.current = c;
      setRoute({ name: 'busy', label: 'Loading Herdr sessions…' });
      await loadSessions(server, c);
    },
    [servers, loadSessions],
  );

  const fail = useCallback((e: unknown) => {
    conn.current?.close();
    conn.current = null;
    setError(describeSshError(e));
    setRoute({ name: 'servers' });
  }, []);

  const open = useCallback(
    async (server: ServerProfile) => {
      setError(null);
      setRoute({ name: 'busy', label: `Checking host key of ${server.host}…` });
      try {
        const presented = await probeHostKey(server.host, server.port);
        const decision = decidePin(await pins.get(server.host, server.port), presented);
        if (decision.kind === 'match') return await connectPinned(server, decision.pin);
        setRoute({ name: 'hostkey', server, decision });
      } catch (e) {
        fail(e);
      }
    },
    [pins, connectPinned, fail],
  );

  const trust = useCallback(
    async (server: ServerProfile, decision: PinDecision) => {
      if (decision.kind !== 'unpinned') return;
      try {
        const pin = await pins.pin(server.host, server.port, decision.presented);
        await connectPinned(server, pin);
      } catch (e) {
        fail(e);
      }
    },
    [pins, connectPinned, fail],
  );

  const refresh = useCallback(async () => {
    if (route.name !== 'sessions' || !conn.current) return;
    setRefreshing(true);
    try {
      await loadSessions(route.server, conn.current);
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  }, [route, loadSessions, fail]);

  const manage = useCallback(
    (server: ServerProfile) => {
      Alert.alert(server.label, `${server.username}@${server.host}:${server.port}`, [
        {
          text: 'Forget host key',
          onPress: () => pins.forget(server.host, server.port),
        },
        {
          text: 'Remove server',
          style: 'destructive',
          onPress: async () => {
            await servers.remove(server.id);
            await pins.forget(server.host, server.port);
            reload();
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [pins, servers, reload],
  );

  let screen;
  switch (route.name) {
    case 'servers':
      screen = (
        <ServersScreen servers={list} error={error} onAdd={() => setRoute({ name: 'add' })} onOpen={open} onManage={manage} />
      );
      break;
    case 'add':
      screen = (
        <AddServerScreen
          onCancel={home}
          onSave={async (input) => {
            await servers.add(input);
            await reload();
            setRoute({ name: 'servers' });
          }}
        />
      );
      break;
    case 'busy':
      screen = <Busy label={route.label} />;
      break;
    case 'hostkey':
      screen = (
        <HostKeyScreen
          server={route.server}
          decision={route.decision}
          onCancel={home}
          onTrust={() => trust(route.server, route.decision)}
        />
      );
      break;
    case 'sessions':
      screen = (
        <SessionsScreen
          title={route.server.label}
          views={route.views}
          herdrFound={route.herdrFound}
          refreshing={refreshing}
          onRefresh={refresh}
          onBack={home}
        />
      );
      break;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="light" />
        {screen}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
