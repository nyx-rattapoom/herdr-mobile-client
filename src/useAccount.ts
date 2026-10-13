import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import HerdrSsh from '../modules/herdr-ssh';
import { PinStore, type KeyValueStore } from './ssh/pinning';
import { DEVICE_KEY_SECRET, DeviceKeyStore } from './store/deviceKey';
import { Secrets, loadSettings, saveSettings, type Settings } from './store/secrets';
import { ServerStore, authOf, passwordKey, type ServerProfile } from './store/servers';

const plainKv: KeyValueStore = {
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItem: (k) => SecureStore.deleteItemAsync(k),
};

const VAULT_OPTS: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  keychainService: 'herdr-client-vault',
  authenticationPrompt: 'Unlock saved server credentials',
};

const vaultKv: KeyValueStore = {
  getItem: (k) => SecureStore.getItemAsync(k, VAULT_OPTS),
  setItem: (k, v) => SecureStore.setItemAsync(k, v, VAULT_OPTS),
  deleteItem: (k) => SecureStore.deleteItemAsync(k, VAULT_OPTS),
};

export type Credentials = { password?: string; privateKey?: string };

// App-wide singletons: one settings object, one secrets store.
const current: Settings = { biometric: false, secureScreen: false };
const settingsReady = loadSettings(plainKv).then((s) => {
  Object.assign(current, s);
  HerdrSsh.setSecureScreen(current.secureScreen);
});
const secrets = new Secrets(plainKv, vaultKv, () => current.biometric, settingsReady);
const servers = new ServerStore(plainKv, undefined, secrets);
const pins = new PinStore(plainKv);
const deviceKey = new DeviceKeyStore(plainKv, secrets, (c) => HerdrSsh.generateEd25519(c));

const hasPassword = async (id: string) => (await servers.password(id).catch(() => null)) !== null;

export function useAccount() {
  const [settings, setSettings] = useState<Settings>({ ...current });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  useEffect(() => {
    void settingsReady.then(() => setSettings({ ...current }));
    void deviceKey.publicKey().then(setPublicKey);
    void (async () => {
      const ok =
        (await LocalAuthentication.hasHardwareAsync()) &&
        (await LocalAuthentication.isEnrolledAsync()) &&
        SecureStore.canUseBiometricAuthentication();
      setBiometricAvailable(ok);
    })();
    // Re-lock the biometric vault whenever the app leaves the foreground.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') secrets.lock();
    });
    return () => sub.remove();
  }, []);

  const keyComment = 'herdr-client';

  const createKey = useCallback(async () => setPublicKey(await deviceKey.ensure(keyComment)), []);
  const regenerateKey = useCallback(async () => setPublicKey(await deviceKey.regenerate(keyComment)), []);

  /** Credentials to try for a server: device key first when configured, saved password as fallback. */
  const credentialsFor = useCallback(
    async (server: ServerProfile): Promise<Credentials> => {
      const password = (await servers.password(server.id)) ?? undefined;
      if (authOf(server) === 'key') {
        const privateKey = (await deviceKey.privateKey()) ?? undefined;
        if (!privateKey && !password) throw new Error('No device key on this phone. Create one in Settings and add it to the server.');
        return { privateKey, password };
      }
      if (!password) throw new Error('No saved password for this server. Edit the server to enter it.');
      return { password };
    },
    [],
  );

  const setBiometric = useCallback(
    async (on: boolean) => {
      if (on === current.biometric) return;
      if (on) {
        const auth = await LocalAuthentication.authenticateAsync({ promptMessage: 'Protect saved credentials' });
        if (!auth.success) throw new Error('Biometric confirmation was cancelled.');
        const keys = [...(await servers.list()).map((s) => passwordKey(s.id)), DEVICE_KEY_SECRET];
        current.biometric = true;
        try {
          await secrets.enableBiometric(keys);
        } catch (e) {
          current.biometric = false;
          throw e;
        }
      } else {
        // Turning protection off must be re-authorised now, not ride on an earlier unlock.
        const auth = await LocalAuthentication.authenticateAsync({ promptMessage: 'Turn off credential protection' });
        if (!auth.success) throw new Error('Biometric confirmation was cancelled.');
        if (!(await secrets.disableBiometric())) {
          throw new Error('Could not unlock the protected credentials (biometrics may have changed).');
        }
        current.biometric = false;
      }
      await saveSettings(plainKv, current);
      setSettings({ ...current });
    },
    [],
  );

  const setSecureScreen = useCallback(async (on: boolean) => {
    current.secureScreen = on;
    HerdrSsh.setSecureScreen(on);
    await saveSettings(plainKv, current);
    setSettings({ ...current });
  }, []);

  return {
    setSecureScreen,
    servers,
    pins,
    settings,
    publicKey,
    biometricAvailable,
    createKey,
    regenerateKey,
    credentialsFor,
    setBiometric,
    hasPassword,
  };
}
