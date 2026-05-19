import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Building2, Cable, Cpu, MessageCircle, Settings, Sparkles, Terminal, Wand2 } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ExecutionTrace } from './components/ExecutionTrace';
import { StatsHeader } from './components/StatsHeader';
import { AgentConfigPanel } from './components/AgentConfigPanel';
import { ConversationsPanel } from './components/ConversationsPanel';
import { LlmCallsPanel } from './components/LlmCallsPanel';
import { PromptsPanel } from './components/PromptsPanel';
import { UnitsPanel } from './components/UnitsPanel';
import { UnitSelector } from './components/UnitSelector';
import { IntegrationsPanel } from './components/IntegrationsPanel';
import { NotificationsBadge } from './components/NotificationsBadge';
import { WizardPanel } from './components/WizardPanel';
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
type Tab = 'traces' | 'conversations' | 'llm' | 'prompts' | 'integrations' | 'wizard' | 'config' | 'units';

export function App() {
  return (
    <UnitProvider>
      <Shell />
    </UnitProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('traces');
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <TopNav tab={tab} onChange={setTab} />
      {tab === 'traces' && <TracesView />}
      {tab === 'conversations' && <ConversationsPanel />}
      {tab === 'llm' && <LlmCallsPanel />}
      {tab === 'prompts' && <PromptsPanel />}
      {tab === 'integrations' && <IntegrationsPanel />}
      {tab === 'wizard' && <WizardPanel />}
      {tab === 'config' && <AgentConfigPanel />}
      {tab === 'units' && <UnitsPanel />}
    </div>
  );
}

function TopNav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string; icon: typeof Terminal }[] = [
    { id: 'traces', label: 'Execuções', icon: Terminal },
    { id: 'conversations', label: 'Conversas', icon: MessageCircle },
    { id: 'llm', label: 'Chamadas IA', icon: Cpu },
    { id: 'prompts', label: 'Prompts', icon: Sparkles },
    { id: 'integrations', label: 'Integrações', icon: Cable },
    { id: 'wizard', label: 'Configurar IA', icon: Wand2 },
    { id: 'config', label: 'Avançado', icon: Settings },
    { id: 'units', label: 'Unidades', icon: Building2 },
  ];

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur flex items-center px-4 py-2 gap-1 shrink-0">
      <div className="flex items-center gap-2 pr-3 mr-2 border-r border-zinc-800/60">
        <div className="w-2 h-2 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(124,77,255,0.6)]" />
        <span className="text-sm font-display font-semibold text-zinc-100 tracking-tight">Agente DT</span>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-display font-medium">v0.2</span>
      </div>

      <UnitSelector />

      <div className="ml-2 mr-1 h-5 w-px bg-zinc-800/80" />

      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md transition-colors ${
            tab === id
              ? 'bg-brand-500/15 text-brand-200 ring-1 ring-brand-500/30'
              : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60'
          }`}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}

      <div className="ml-auto flex items-center gap-1">
        <NotificationsBadge />
        <a
          href="/docs"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60"
        >
          <BookOpen size={14} />
          Documentação
        </a>
      </div>
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
