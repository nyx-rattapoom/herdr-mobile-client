import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { useLive } from '../live/hooks';
import type { LiveSession } from '../live/LiveSession';
import { pillFor, type PillKind } from '../live/pill';
import { colors } from './ui';

const tone: Record<PillKind, { bg: string; fg: string }> = {
  working: { bg: '#16243f', fg: colors.accent },
  blocked: { bg: '#3a2c0c', fg: colors.warn },
  reconnecting: { bg: '#3a2c0c', fg: colors.warn },
  offline: { bg: '#3a1518', fg: '#ffd6d7' },
};

/**
 * A pill floating at the top of the pane output: working (with elapsed time), needs you,
 * reconnecting or offline. Connection states retry on tap. It sits top-centre so it never
 * covers the / button, which starts bottom-right.
 */
export function StatusPill({
  live,
  paneId,
  onReconnect,
}: {
  live: LiveSession;
  paneId: string;
  onReconnect?: () => void;
}) {
  const st = useLive(live);
  const agent = st.agents.get(paneId)?.status;
  const since = st.since.get(paneId);
  const [now, setNow] = useState(() => Date.now());
  const ticking = st.status === 'live' && agent === 'working' && Boolean(since);
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [ticking]);
  const pill = pillFor(st.status, agent, since, now);
  if (!pill) return null;
  const c = tone[pill.kind];
  return (
    <Pressable
      testID={`pill-${pill.kind}`}
      accessibilityRole={pill.retry ? 'button' : 'text'}
      disabled={!pill.retry}
      onPress={() => (st.status === 'offline' && onReconnect ? onReconnect() : live.retryNow())}
      style={{
        position: 'absolute',
        top: 8,
        alignSelf: 'center',
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: 14,
        backgroundColor: c.bg,
        borderWidth: 1,
        borderColor: c.fg,
        elevation: 4,
      }}
    >
      <Text style={{ color: c.fg, fontSize: 13, fontWeight: '600' }}>{pill.text}</Text>
    </Pressable>
  );
}
