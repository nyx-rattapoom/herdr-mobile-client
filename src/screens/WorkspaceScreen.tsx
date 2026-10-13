import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, View } from 'react-native';

import type { ActionId, Target } from '../live/actions';
import type { Line } from '../live/ansi';
import { useLive } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import {
  paneName,
  paneStatus,
  resolveSelection,
  selectionForPane,
  tabName,
  tabStatus,
  workspaceName,
  workspaceSummary,
  type Selection,
} from '../live/workspace';
import { LiveBanner, LiveStatusLine } from './LiveBanner';
import { PaneView } from './PaneView';
import { StatusDot } from './SessionsScreen';
import { SlashButton } from './SlashPalette';
import { AgentsButton, AgentsSheet } from './AgentsSheet';
import { Button, colors, sheet, styles } from './ui';

type Props = {
  live: LiveSession;
  session: string;
  /** `user@host`, for the status line. */
  host: string;
  sel: Selection;
  onSelect: (s: Selection) => void;
  onBack: () => void;
  onReconnect?: () => void;
  /** Opens the action sheet for a long-pressed target. */
  onAction: (t: Target) => void;
  /** Runs one action directly (it still asks for a label or confirmation where needed). */
  onPick: (t: Target, id: ActionId) => void;
  /** When each pane was last opened, for "unseen" done agents. */
  viewed: Record<string, number>;
  /** Called when a pane is shown and when it stops being shown. */
  onViewPane: (paneId: string) => void;
  footer?: (paneId: string, pokeNow: () => void, blank: boolean, screen: Line[]) => ReactNode;
};

/**
 * The main screen for one Herdr session: one workspace at a time, its tabs as chips and the
 * selected tab's pane(s). Selecting only changes what the phone shows; it never focuses anything
 * in Herdr. Focusing is an explicit action in the long-press menus.
 */
export function WorkspaceScreen(p: Props) {
  const st = useLive(p.live);
  const [switcher, setSwitcher] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const { ws, tab, pane } = resolveSelection(st.tree, p.sel);
  const select = (s: Selection) => p.onSelect(s);
  const paneId = pane?.pane_id;
  const { onViewPane } = p;
  useEffect(() => {
    if (!paneId) return;
    onViewPane(paneId);
    return () => onViewPane(paneId);
  }, [paneId, onViewPane]);

  return (
    // Edge-to-edge Android doesn't resize the window for the keyboard; pad instead.
    <KeyboardAvoidingView style={styles.screen} behavior="padding" testID="workspace">
      <View style={ui.header}>
        <Pressable testID="back" onPress={p.onBack} hitSlop={12}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Pressable
          testID="ws-switcher"
          style={{ flex: 1 }}
          onPress={() => setSwitcher(true)}
          onLongPress={ws ? () => p.onAction({ kind: 'workspace', node: ws }) : undefined}
        >
          <Text style={[styles.title, { flex: 0 }]} numberOfLines={1}>
            {ws ? workspaceName(ws) : st.snapshot ? 'No workspaces' : 'Loading…'} <Text style={styles.muted}>▾</Text>
          </Text>
          <LiveStatusLine st={st} testID={`live-${p.session}`} extra={p.host} />
        </Pressable>
        <AgentsButton live={p.live} onPress={() => setAgentsOpen(true)} />
      </View>
      {st.status !== 'live' ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <LiveBanner live={p.live} st={st} session={p.session} onReconnect={p.onReconnect} />
        </View>
      ) : null}
      {ws ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={ui.chips}
        >
          {ws.tabs.map((t) => {
            const on = t.tab_id === tab?.tab_id;
            return (
              <Pressable
                key={t.tab_id}
                testID={`tab-${t.tab_id}`}
                onPress={() => select({ workspaceId: ws.workspace_id, tabId: t.tab_id })}
                onLongPress={() => p.onAction({ kind: 'tab', node: t })}
                style={[ui.chip, on && ui.chipOn]}
              >
                <StatusDot value={tabStatus(t, st.agents)} />
                <Text style={[styles.text, { color: on ? '#fff' : colors.text }]} numberOfLines={1}>
                  {tabName(t)}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            testID="new-tab"
            accessibilityLabel="New tab"
            onPress={() => p.onPick({ kind: 'workspace', node: ws }, 'tab.create')}
            style={ui.chip}
          >
            <Text style={[styles.text, { color: colors.accent }]}>＋</Text>
          </Pressable>
        </ScrollView>
      ) : null}
      {tab && tab.panes.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={ui.chips}
        >
          {tab.panes.map((x) => {
            const on = x.pane_id === pane?.pane_id;
            return (
              <Pressable
                key={x.pane_id}
                testID={`pane-${x.pane_id}`}
                onPress={() => select({ workspaceId: ws?.workspace_id, tabId: tab.tab_id, paneId: x.pane_id })}
                onLongPress={() => p.onAction({ kind: 'pane', node: x })}
                style={[ui.paneChip, on && { borderColor: colors.accent }]}
              >
                <StatusDot value={paneStatus(x, st.agents)} size={6} />
                <Text style={[styles.muted, { color: on ? colors.text : colors.muted }]} numberOfLines={1}>
                  {paneName(x, st.agents)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {pane ? (
        <PaneView
          key={pane.pane_id}
          live={p.live}
          paneId={pane.pane_id}
          footer={p.footer ? (poke, blank, screen) => p.footer?.(pane.pane_id, poke, blank, screen) : undefined}
          overlay={(poke) => (
            <SlashButton
              live={p.live}
              paneId={pane.pane_id}
              agent={st.agents.get(pane.pane_id)?.agent ?? pane.agent}
              onSent={poke}
            />
          )}
        />
      ) : (
        <View style={styles.center}>
          {st.snapshot && !ws ? (
            <View style={{ alignSelf: 'stretch', gap: 12 }}>
              <Text style={[styles.muted, { textAlign: 'center' }]}>This session has no workspaces.</Text>
              <Button
                testID="empty-new-workspace"
                label="New workspace"
                onPress={() => p.onPick({ kind: 'session' }, 'workspace.create')}
              />
            </View>
          ) : st.snapshot ? (
            <Text style={styles.muted}>This tab has no panes.</Text>
          ) : null}
        </View>
      )}
      {agentsOpen ? (
        <AgentsSheet
          live={p.live}
          viewed={p.viewed}
          onClose={() => setAgentsOpen(false)}
          onOpen={(r) => {
            setAgentsOpen(false);
            const s = selectionForPane(st.tree, r.paneId);
            if (s) select(s);
          }}
          onClosePane={(r) => {
            const node = st.tree.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((x) => x.pane_id === r.paneId);
            if (!node) return;
            setAgentsOpen(false);
            p.onPick({ kind: 'pane', node }, 'pane.close');
          }}
        />
      ) : null}
      {switcher ? (
        <WorkspaceSheet
          live={p.live}
          current={ws?.workspace_id}
          onClose={() => setSwitcher(false)}
          onSelect={(id) => {
            setSwitcher(false);
            select({ workspaceId: id });
          }}
          onCloseWorkspace={(node) => {
            setSwitcher(false);
            p.onPick({ kind: 'workspace', node }, 'workspace.close');
          }}
          onNew={() => {
            setSwitcher(false);
            p.onPick({ kind: 'session' }, 'workspace.create');
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

/** Bottom sheet listing every workspace with its rolled-up status. */
function WorkspaceSheet({
  live,
  current,
  onClose,
  onSelect,
  onCloseWorkspace,
  onNew,
}: {
  live: LiveSession;
  current?: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCloseWorkspace: (node: import('../protocol/snapshot').WorkspaceNode) => void;
  onNew: () => void;
}) {
  const st = useLive(live);
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={sheet.backdrop} onPress={onClose} testID="sheet-backdrop">
        <Pressable style={sheet.panel} testID="ws-sheet">
          <Text style={[styles.muted, { marginBottom: 8 }]}>Workspaces · long-press to close</Text>
          <ScrollView style={{ maxHeight: 420 }}>
            {st.tree.map((w) => {
              const sum = workspaceSummary(w, st.agents);
              const on = w.workspace_id === current;
              return (
                <Pressable
                  key={w.workspace_id}
                  testID={`ws-${w.workspace_id}`}
                  onPress={() => onSelect(w.workspace_id)}
                  onLongPress={() => onCloseWorkspace(w)}
                  style={({ pressed }) => [sheet.row, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <StatusDot value={sum.status} size={10} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.text, { fontSize: 17, fontWeight: on ? '700' : '400' }]} numberOfLines={1}>
                      {workspaceName(w)}
                    </Text>
                    <Text style={styles.muted}>
                      {sum.agents} agent{sum.agents === 1 ? '' : 's'} · {sum.tabs} tab{sum.tabs === 1 ? '' : 's'}
                      {sum.status ? ` · ${sum.status === 'blocked' ? 'needs you' : sum.status}` : ''}
                    </Text>
                  </View>
                  {on ? <Text style={{ color: colors.accent, fontSize: 18 }}>✓</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable testID="ws-new" onPress={onNew} style={sheet.row}>
            <Text style={[styles.text, { fontSize: 17, color: colors.accent }]}>＋ New workspace</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const ui = {
  header: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  chips: { paddingHorizontal: 12, paddingBottom: 8, gap: 8, alignItems: 'center' as const },
  chip: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 200,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  paneChip: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 220,
  },
};
