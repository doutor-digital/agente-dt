// ============================================================================
// TracesView — aba "Execuções". Sidebar de traces + detalhe do selecionado.
//
// Extraído do App.tsx pra poder ser lazy-loaded junto com Sidebar/ExecutionTrace/
// StatsHeader (que só ele usa). Reduz o bundle inicial.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './Sidebar';
import { ExecutionTrace } from './ExecutionTrace';
import { StatsHeader } from './StatsHeader';
import { useUnit } from '../context/UnitContext';
import { usePolling } from '../hooks/usePolling';
import { api } from '../lib/api';
import type { TraceDetail } from '../types/api';

export function TracesView() {
  const { selectedUnitId } = useUnit();
  const tracesFetcher = useMemo(() => () => api.listTraces(selectedUnitId), [selectedUnitId]);
  const statsFetcher = useMemo(() => () => api.getStats(selectedUnitId), [selectedUnitId]);

  const { data: traces, loading } = usePolling(tracesFetcher, 3000, [selectedUnitId]);
  const { data: stats } = usePolling(statsFetcher, 5000, [selectedUnitId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);

  // Reset quando troca de unidade.
  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
  }, [selectedUnitId]);

  useEffect(() => {
    if (!selectedId && traces && traces.length > 0) {
      setSelectedId(traces[0].id);
    }
  }, [traces, selectedId]);

  const detailInterval = detail?.status === 'RUNNING' ? 1000 : 4000;
  const detailFetcher = useMemo(
    () => async () => (selectedId ? api.getTrace(selectedId) : null),
    [selectedId],
  );
  const { data: fetchedDetail } = usePolling(detailFetcher, detailInterval, [selectedId]);

  useEffect(() => {
    if (fetchedDetail) setDetail(fetchedDetail);
    if (!selectedId) setDetail(null);
  }, [fetchedDetail, selectedId]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar
        traces={traces ?? []}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={loading}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 pt-5">
          <StatsHeader stats={stats} />
        </div>
        <div className="flex-1 overflow-hidden flex flex-col">
          <ExecutionTrace trace={detail} />
        </div>
      </div>
    </div>
  );
}
