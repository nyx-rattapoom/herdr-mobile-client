import { Pressable, ScrollView, Text, View } from 'react-native';

import { useLive } from '../live/hooks';
import type { LiveSession, LiveStatus } from '../live/LiveSession';
import type { HerdrSession } from '../protocol/sessions';
import type { PaneNode, TabNode, WorkspaceNode } from '../protocol/snapshot';
import { Button, ErrorBox, Header, colors, styles } from './ui';

export type SessionEntry = { session: HerdrSession; live?: LiveSession; error?: string };

export type TreeTarget =
  | { kind: 'session'; session: string }
  | { kind: 'workspace'; session: string; node: WorkspaceNode }
  | { kind: 'tab'; session: string; node: TabNode }
  | { kind: 'pane'; session: string; node: PaneNode };

type Props = {
  title: string;
  entries: SessionEntry[];
  herdrFound: boolean;
  onOpenPane: (session: string, pane: PaneNode) => void;
  onAction?: (t: TreeTarget) => void;
  onBack: () => void;
  /** Re-establishes the SSH connection when a session reports it is gone. */
  onReconnect?: () => void;
  banner?: React.ReactNode;
};

export const statusColor: Record<string, string> = {
  working: colors.accent,
  blocked: colors.warn,
  done: colors.ok,
  idle: colors.muted,
};

export function Status({ value }: { value?: string }) {
  if (!value || value === 'unknown') return null;
  return (
    <Text testID={`status-${value}`} style={[styles.muted, { color: statusColor[value] ?? colors.muted }]}>
      {' '}
      ● {value}
    </Text>
  );
}

const liveLabel: Record<LiveStatus, [string, string]> = {
  connecting: ['connecting…', colors.muted],
  live: ['● live', colors.ok],
  reconnecting: ['reconnecting…', colors.warn],
  offline: ['offline', colors.danger],
};

type TreeProps = Pick<Props, 'onOpenPane' | 'onAction' | 'onReconnect'>;

function SessionCard({ entry, onOpenPane, onAction, onReconnect }: { entry: SessionEntry } & TreeProps) {
  const { session } = entry;
  return (
    <Pressable
      style={styles.card}
      testID={`session-${session.name}`}
      onLongPress={onAction && entry.live ? () => onAction({ kind: 'session', session: session.name }) : undefined}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[styles.text, { fontWeight: '700', flex: 1 }]}>
          {session.name}
          {session.isDefault ? ' (default)' : ''}
        </Text>
        {onAction && entry.live ? (
          <Pressable
            testID={`new-workspace-${session.name}`}
            hitSlop={8}
            onPress={() => onAction({ kind: 'session', session: session.name })}
          >
            <Text style={[styles.text, { color: colors.accent }]}>+ Workspace</Text>
          </Pressable>
        ) : null}
      </View>
      {!session.running ? <Text style={styles.muted}>not running</Text> : null}
      {entry.error ? <ErrorBox message={entry.error} /> : null}
      {entry.live ? (
        <LiveTree live={entry.live} session={session.name} onOpenPane={onOpenPane} onAction={onAction} onReconnect={onReconnect} />
      ) : null}
    </Pressable>
  );
}

function LiveTree({ live, session, onOpenPane, onAction, onReconnect }: { live: LiveSession; session: string } & TreeProps) {
  const st = useLive(live);
  const [label, color] = liveLabel[st.status];
  const agentOf = (p: PaneNode) => st.agents.get(p.pane_id);
  return (
    <View>
      <Text testID={`live-${session}`} style={[styles.muted, { color }]}>
        {label}
        {st.snapshot?.version ? `  ·  herdr ${st.snapshot.version}` : ''}
      </Text>
      {st.status !== 'live' && st.error ? <Text style={styles.muted}>{st.error}</Text> : null}
      {st.status === 'reconnecting' ? (
        <View style={{ marginTop: 8 }}>
          <Button testID={`retry-${session}`} label="Retry now" kind="secondary" onPress={() => live.retryNow()} />
        </View>
      ) : null}
      {st.status === 'offline' && onReconnect ? (
        <View style={{ marginTop: 8 }}>
          <Button testID="reconnect" label="Reconnect" onPress={onReconnect} />
        </View>
      ) : null}
      {st.snapshot && st.tree.length === 0 ? <Text style={styles.muted}>No workspaces.</Text> : null}
      {st.tree.map((w) => (
        <View key={w.workspace_id} style={{ marginTop: 10 }}>
          <Pressable
            testID={`ws-${w.workspace_id}`}
            onLongPress={onAction ? () => onAction({ kind: 'workspace', session, node: w }) : undefined}
          >
            <Text style={styles.text}>
              {w.number ?? ''} {w.label || w.workspace_id}
              {w.focused ? <Text style={styles.muted}> (focused)</Text> : null}
              <Status value={w.agent_status} />
            </Text>
          </Pressable>
          {w.tabs.map((t) => (
            <View key={t.tab_id} style={{ marginLeft: 16, marginTop: 4 }}>
              <Pressable
                testID={`tab-${t.tab_id}`}
                onLongPress={onAction ? () => onAction({ kind: 'tab', session, node: t }) : undefined}
              >
                <Text style={styles.text}>
                  ▸ {t.label || `tab ${t.number ?? t.tab_id}`}
                  {t.focused ? <Text style={styles.muted}> (focused)</Text> : null}
                  <Status value={t.agent_status} />
                </Text>
              </Pressable>
              {t.panes.map((p) => {
                const a = agentOf(p);
                return (
                  <Pressable
                    key={p.pane_id}
                    testID={`pane-${p.pane_id}`}
                    onPress={() => onOpenPane(session, p)}
                    onLongPress={onAction ? () => onAction({ kind: 'pane', session, node: p }) : undefined}
                    style={({ pressed }) => ({ marginLeft: 16, marginTop: 2, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}
                  >
                    <Text style={[styles.text, { fontSize: 14 }]} numberOfLines={1}>
                      {p.pane_id}
                      {a?.agent ? ` · ${a.agent}` : ''}
                      {p.focused ? ' ◆' : ''}
                      <Status value={a?.status ?? p.agent_status} />
                    </Text>
                    <Text style={styles.muted} numberOfLines={1}>
                      {p.terminal_title_stripped || p.cwd || ''}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function SessionsScreen({ title, entries, herdrFound, onOpenPane, onAction, onBack, onReconnect, banner }: Props) {
  return (
    <View style={styles.screen} testID="sessions">
      <Header title={title} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {banner}
        {!herdrFound ? (
          <Text style={styles.muted}>`herdr` was not found on the server; using the default socket location.</Text>
        ) : null}
        {entries.length === 0 ? <Text style={styles.muted}>No Herdr sessions found on this server.</Text> : null}
        {entries.map((e) => (
          <SessionCard key={e.session.name} entry={e} onOpenPane={onOpenPane} onAction={onAction} onReconnect={onReconnect} />
        ))}
        <Text style={styles.muted}>Tap a pane to view its output.{onAction ? ' Long-press for actions.' : ''}</Text>
      </ScrollView>
    </View>
  );
}
