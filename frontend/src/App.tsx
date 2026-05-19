import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ExecutionTrace } from './components/ExecutionTrace';
import { StatsHeader } from './components/StatsHeader';
import { AgentConfigPanel } from './components/AgentConfigPanel';
import { ConversationsPanel } from './components/ConversationsPanel';
import { LlmCallsPanel } from './components/LlmCallsPanel';
import { PromptsPanel } from './components/PromptsPanel';
import { UnitsPanel } from './components/UnitsPanel';
import { IntegrationsPanel } from './components/IntegrationsPanel';
import { WizardPanel } from './components/WizardPanel';
import { AppSidebar, type AppTab } from './components/AppSidebar';
import { DashboardPanel } from './components/DashboardPanel';
import { UnitProvider, useUnit } from './context/UnitContext';
import { usePolling } from './hooks/usePolling';
import { api } from './lib/api';
import type { TraceDetail } from './types/api';

/**
 * App root — multi-tenant.
 *
 * Tabs:
 *  - "traces": dashboard de execuções (sidebar + console + stats)
 *  - "conversations": chat por lead
 *  - "llm": chamadas IA com tokens/custo (painel "ByteGPT")
 *  - "config": editor do AgentConfig (por unidade)
 *  - "units": CRUD de unidades + credenciais
 *
 * O dropdown UnitSelector no topo filtra todas as views por unidade.
 */
export function App() {
  return (
    <UnitProvider>
      <Shell />
    </UnitProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<AppTab>('dashboard');
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <AppSidebar tab={tab} onChange={setTab} />
      <main className="flex-1 flex flex-col overflow-hidden">
        {tab === 'dashboard' && <DashboardPanel />}
        {tab === 'traces' && <TracesView />}
        {tab === 'conversations' && <ConversationsPanel />}
        {tab === 'llm' && <LlmCallsPanel />}
        {tab === 'prompts' && <PromptsPanel />}
        {tab === 'integrations' && <IntegrationsPanel />}
        {tab === 'wizard' && <WizardPanel />}
        {tab === 'config' && <AgentConfigPanel />}
        {tab === 'units' && <UnitsPanel />}
      </main>
    </div>
  );
}


function TracesView() {
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
