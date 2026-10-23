import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';

import App from './App';

registerRootComponent(App);

export const KEEP_ALIVE_TASK = 'HerdrKeepAlive';
AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => () => new Promise<void>(() => {}));
