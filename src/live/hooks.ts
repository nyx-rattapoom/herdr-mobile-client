import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { LiveSession, LiveState } from './LiveSession';
import { PaneReader, type PaneOutput } from './PaneReader';

export function useLive(live: LiveSession): LiveState {
  return useSyncExternalStore(
    (cb) => live.subscribe(cb),
    () => live.getState(),
  );
}

/** Last output per pane, so a pane shown again (or after a reconnect) starts from its last screen. */
const lastOutput = new WeakMap<LiveSession, Map<string, PaneOutput>>();

export function cachedOutput(live: LiveSession, paneId: string): PaneOutput | null {
  return lastOutput.get(live)?.get(paneId) ?? null;
}

export function usePaneOutput(live: LiveSession, paneId: string) {
  const [output, setOutput] = useState<PaneOutput | null>(() => cachedOutput(live, paneId));
  const [error, setError] = useState<string | null>(null);

  const reader = useMemo(
    () =>
      new PaneReader(
        (m, p, t) => live.query(m, p, t),
        paneId,
        (o) => {
          let m = lastOutput.get(live);
          if (!m) lastOutput.set(live, (m = new Map()));
          m.set(paneId, o);
          setOutput(o);
          setError(null);
        },
        (e) => setError((e as Error)?.message ?? String(e)),
      ),
    [live, paneId],
  );

  // Polling is for the screen. Timers keep running in the background while monitoring, so pause
  // there instead of reading the pane every second for nobody.
  useEffect(() => {
    const sync = (s: AppStateStatus) => (s === 'background' ? reader.stop() : reader.start());
    sync(AppState.currentState);
    const sub = AppState.addEventListener('change', sync);
    return () => {
      sub.remove();
      reader.stop();
    };
  }, [reader]);

  return { output, error, reader };
}
