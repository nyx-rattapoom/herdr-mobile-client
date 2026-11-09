import { Platform } from 'react-native';

/**
 * Core v1 ships with an Android byte stream. iOS keeps its legacy path; a
 * saved Core profile must show this explanation before any native call.
 */
export const corePlatformAvailable = (os: string = Platform.OS): boolean => os === 'android';

export const CORE_PLATFORM_MESSAGE =
  'Herdr Core is available on Android in this version. This profile will not connect on iOS; choose Herdr TUI to use it here.';
