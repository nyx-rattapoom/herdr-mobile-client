import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import type { HerdrSession } from '../protocol/sessions';
import type { WorkspaceNode } from '../protocol/snapshot';
import { ErrorBox, Header, colors, styles } from './ui';

export type SessionView = {
  session: HerdrSession;
  tree?: WorkspaceNode[];
  version?: string;
  error?: string;
};

type Props = {
  title: string;
  views: SessionView[];
  herdrFound: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onBack: () => void;
};

const statusColor: Record<string, string> = {
  working: colors.accent,
  blocked: colors.warn,
  done: colors.ok,
  idle: colors.muted,
};

function Status({ value }: { value?: string }) {
  if (!value || value === 'unknown') return null;
  return <Text style={[styles.muted, { color: statusColor[value] ?? colors.muted }]}> ● {value}</Text>;
}

export function SessionsScreen({ title, views, herdrFound, refreshing, onRefresh, onBack }: Props) {
  return (
    <View style={styles.screen} testID="sessions">
      <Header title={title} onBack={onBack} />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {!herdrFound ? (
          <Text style={styles.muted}>`herdr` was not found on PATH; using the default socket location.</Text>
        ) : null}
        {views.length === 0 ? <Text style={styles.muted}>No Herdr sessions found on this server.</Text> : null}
        {views.map((v) => (
          <View key={v.session.name} style={styles.card} testID={`session-${v.session.name}`}>
            <Text style={[styles.text, { fontWeight: '700' }]}>
              {v.session.name}
              {v.session.isDefault ? ' (default)' : ''}
              {v.version ? <Text style={styles.muted}>  herdr {v.version}</Text> : null}
            </Text>
            {!v.session.running ? <Text style={styles.muted}>not running</Text> : null}
            {v.error ? <ErrorBox message={v.error} /> : null}
            {v.tree?.length === 0 ? <Text style={styles.muted}>No workspaces.</Text> : null}
            {v.tree?.map((w) => (
              <View key={w.workspace_id} style={{ marginTop: 10 }}>
                <Text style={styles.text}>
                  {w.number ?? ''} {w.label || w.workspace_id}
                  {w.focused ? <Text style={styles.muted}> (focused)</Text> : null}
                  <Status value={w.agent_status} />
                </Text>
                {w.tabs.map((t) => (
                  <View key={t.tab_id} style={{ marginLeft: 16, marginTop: 4 }}>
                    <Text style={styles.text}>
                      ▸ {t.label || `tab ${t.number ?? t.tab_id}`}
                      <Status value={t.agent_status} />
                    </Text>
                    {t.panes.map((p) => (
                      <Pressable key={p.pane_id} style={{ marginLeft: 16, marginTop: 2 }}>
                        <Text style={styles.muted} numberOfLines={1}>
                          {p.pane_id} · {p.agent ? `${p.agent} · ` : ''}
                          {p.terminal_title_stripped || p.cwd || ''}
                          <Status value={p.agent_status} />
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ))}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
