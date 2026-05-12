import { useEffect, useState, useRef, useCallback } from 'react';

/**
 * Hook genérico de polling. Mantém o resultado em state, expõe `refresh`
 * manual e auto-pausa quando a aba está em background (visibilitychange).
 *
 * Por que polling e não SSE/websockets no MVP?
 * - Simplicidade. SSE exigiria server.headersTimeout, keepalive, etc.
 * - O dashboard é interno e baixa frequência (1 op/s no máximo).
 * - Trivial de migrar para SSE depois — basta trocar este hook.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: ReadonlyArray<unknown> = [],
): { data: T | null; error: Error | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const tick = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      void tick();
      timer = setInterval(() => {
        if (active) void tick();
      }, intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, refresh: tick };
}
