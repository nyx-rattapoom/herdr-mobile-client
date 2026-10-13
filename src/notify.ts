import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import HerdrSsh from '../modules/herdr-ssh';

export const AGENT_CHANNEL = 'agents';

export type AlertTarget = { serverId: string; session: string; paneId: string };

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Creates the channel (needed before Android 13 shows the permission prompt) and asks once. */
export async function setupNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(AGENT_CHANNEL, {
      name: 'Agent status',
      description: 'An agent is blocked waiting for you, or finished its work',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).status === 'granted';
}

export function postAgentNotification(title: string, body: string, target: AlertTarget) {
  return Notifications.scheduleNotificationAsync({
    content: { title, body, data: target },
    // Immediate delivery; on Android the channel is chosen through the trigger.
    trigger: Platform.OS === 'android' ? { channelId: AGENT_CHANNEL } : null,
  });
}

function isTarget(d: unknown): d is AlertTarget {
  const t = d as AlertTarget;
  return typeof t?.serverId === 'string' && typeof t.session === 'string' && typeof t.paneId === 'string';
}

const handled = new Set<string>();

/** Calls `onOpen` once per tapped agent notification (also for a cold start). */
export function onNotificationTap(onOpen: (t: AlertTarget) => void): () => void {
  const handle = (r: Notifications.NotificationResponse | null) => {
    if (!r) return;
    const id = r.notification.request.identifier;
    const d = r.notification.request.content.data;
    if (handled.has(id) || !isTarget(d)) return;
    handled.add(id);
    onOpen(d);
  };
  void Notifications.getLastNotificationResponseAsync().then(handle);
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  return () => sub.remove();
}

export const startBackgroundMonitoring = (text: string) => HerdrSsh.startMonitoring(text);
export const stopBackgroundMonitoring = () => HerdrSsh.stopMonitoring();
