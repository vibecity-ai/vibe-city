import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveMessage } from '@vibe-city/shared';
import { ApiError, openLive } from './api.ts';

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** Data on screen is from an earlier successful load and the latest refresh failed. */
  stale: boolean;
  reload: () => void;
}

/** Loads data; on a failed refresh keeps the last good data and marks it stale (nothing is invented). */
export function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const tick = useRef(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!load) { setData(null); setError(null); return; }
    const mine = ++tick.current;
    setLoading(true);
    load().then(
      (d) => { if (mine === tick.current) { setData(d); setError(null); setLoading(false); } },
      (e) => { if (mine === tick.current) { setError(e instanceof ApiError ? e : new ApiError(0, 'error', String(e?.message ?? e))); setLoading(false); } },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  // when the department/quest changes, drop data from the previous one
  const key = JSON.stringify(deps);
  const lastKey = useRef(key);
  useEffect(() => { if (lastKey.current !== key) { lastKey.current = key; setData(null); } }, [key]);
  return { data, loading, error, stale: !!error && data !== null, reload };
}

export interface LiveState {
  link: boolean;
  hermes: Extract<LiveMessage, { type: 'connection' }>['state'] | null;
}

/** Subscribes to backend live events for a department; `onRefresh` is called (debounced) when data should be refetched. */
export function useLive(departmentId: string | null, onRefresh: () => void): LiveState {
  const [state, setState] = useState<LiveState>({ link: false, hermes: null });
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    if (!departmentId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => cb.current(), 400); };
    const close = openLive(
      departmentId,
      (m) => {
        if (m.type === 'connection') setState((s) => ({ ...s, hermes: m.state }));
        else refresh(); // hermes.event or resync: events are a hint, the REST snapshot is the truth
      },
      (up) => setState((s) => ({ link: up, hermes: up ? s.hermes : null })),
    );
    return () => { clearTimeout(timer); close(); };
  }, [departmentId]);
  return state;
}
