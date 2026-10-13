import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { LiveSession, LiveState } from './LiveSession';
import { PaneReader, type PaneOutput } from './PaneReader';

export function useLive(live: LiveSession): LiveState {
  return useSyncExternalStore(
    (cb) => live.subscribe(cb),
    () => live.getState(),
  );
}

export function usePaneOutput(live: LiveSession, paneId: string) {
  const [output, setOutput] = useState<PaneOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reader = useMemo(
    () =>
      new PaneReader(
        (m, p) => live.query(m, p),
        paneId,
        (o) => {
          setOutput(o);
          setError(null);
        },
        (e) => setError((e as Error)?.message ?? String(e)),
      ),
    [live, paneId],
  );

  useEffect(() => {
    reader.start();
    return () => reader.stop();
  }, [reader]);

  return { output, error, reader };
}
