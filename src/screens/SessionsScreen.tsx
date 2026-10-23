import { Pressable, ScrollView, Text, View } from 'react-native';

import { useLive } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import type { HerdrSession } from '../protocol/sessions';
import type { PaneNode, TabNode, WorkspaceNode } from '../protocol/snapshot';
import { LiveBanner, LiveStatusLine } from './LiveBanner';
import { ErrorBox, Header, colors, styles } from './ui';

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
  onOpenSession: (session: string) => void;
  onAction?: (t: TreeTarget) => void;
  onBack: () => void;
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

export function StatusDot({ value: raw, size = 8 }: { value?: string; size?: number }) {
  const value = raw === 'unknown' ? undefined : raw;
  const color = value ? (statusColor[value] ?? colors.muted) : 'transparent';
  return (
    <View
      testID={value ? `dot-${value}` : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderWidth: value ? 0 : 1,
        borderColor: colors.border,
      }}
    />
  );
}

function SessionSummary({
  live,
  session,
  onReconnect,
}: {
  live: LiveSession;
  session: string;
  onReconnect?: () => void;
}) {
  const st = useLive(live);
  const agents = [...st.agents.values()];
  const blocked = agents.filter((a) => a.status === 'blocked').length;
  const working = agents.filter((a) => a.status === 'working').length;
  return (
    <View>
      <LiveStatusLine st={st} testID={`live-${session}`} />
      <LiveBanner live={live} st={st} session={session} onReconnect={onReconnect} />
      {st.snapshot ? (
        <Text style={[styles.muted, { marginTop: 4 }]} testID={`summary-${session}`}>
          {st.tree.length} workspace{st.tree.length === 1 ? '' : 's'} · {agents.length} agent
          {agents.length === 1 ? '' : 's'}
          {working ? ` · ${working} working` : ''}
          {blocked ? ` · ${blocked} need${blocked === 1 ? 's' : ''} you` : ''}
        </Text>
      ) : null}
    </View>
  );
}

export function SessionsScreen({
  title,
  entries,
  herdrFound,
  onOpenSession,
  onAction,
  onBack,
  onReconnect,
  banner,
}: Props) {
  return (
    <View style={styles.screen} testID="sessions">
      <Header title={title} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {banner}
        {herdrFound && entries.length === 0 ? (
          <Text style={styles.muted}>No Herdr sessions found on this server.</Text>
        ) : null}
        {entries.map(({ session, live, error }) => (
          <Pressable
            key={session.name}
            style={({ pressed }) => [styles.card, { opacity: pressed && live ? 0.7 : 1 }]}
            testID={`session-${session.name}`}
            disabled={!live}
            onPress={() => onOpenSession(session.name)}
            onLongPress={onAction && live ? () => onAction({ kind: 'session', session: session.name }) : undefined}
          >
            <Text style={[styles.text, { fontWeight: '700' }]}>
              {session.name}
              {session.isDefault ? ' (default)' : ''}
            </Text>
            {!session.running ? <Text style={styles.muted}>not running</Text> : null}
            {error ? <ErrorBox message={error} /> : null}
            {live ? <SessionSummary live={live} session={session.name} onReconnect={onReconnect} /> : null}
          </Pressable>
        ))}
        <Text style={styles.muted}>
          Tap a session to open its workspaces.{onAction ? ' Long-press for actions.' : ''}
        </Text>
      </ScrollView>
    </View>
  );
}
