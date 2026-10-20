import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

/**
 * Started and finished by the native module around background monitoring: while a headless task
 * runs, React Native keeps JS timers going in the background. Must match KEEP_ALIVE_TASK in
 * HerdrSshModule.kt.
 */
export const KEEP_ALIVE_TASK = 'HerdrKeepAlive';
AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => () => new Promise<void>(() => {}));
