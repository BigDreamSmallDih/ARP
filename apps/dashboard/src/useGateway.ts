import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from './api/client';
import { INITIAL_SNAPSHOT, loadSnapshot, type Snapshot } from './api/snapshot';
import type { Settings } from './settings';

export function useGateway(settings: Settings): { snapshot: Snapshot; refresh: () => void } {
  const client = useMemo(
    () => createClient({ baseUrl: settings.baseUrl, token: settings.token }),
    [settings.baseUrl, settings.token],
  );
  const [snapshot, setSnapshot] = useState<Snapshot>(INITIAL_SNAPSHOT);
  const [manualRefreshes, setManualRefreshes] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const next = await loadSnapshot(client);
      if (!cancelled) setSnapshot(next);
    }

    void run();
    const timer = window.setInterval(() => void run(), settings.refreshSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, settings.refreshSeconds, manualRefreshes]);

  const refresh = useCallback(() => {
    setManualRefreshes((count) => count + 1);
  }, []);

  return { snapshot, refresh };
}
