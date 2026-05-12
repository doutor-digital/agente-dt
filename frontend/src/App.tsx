import { useEffect, useState } from 'react';
import { BookOpen, Settings, Terminal } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ExecutionTrace } from './components/ExecutionTrace';
import { StatsHeader } from './components/StatsHeader';
import { AgentConfigPanel } from './components/AgentConfigPanel';
import { usePolling } from './hooks/usePolling';
import { api } from './lib/api';
import type { TraceDetail } from './types/api';

/**
 * App root.
 *
 * Duas views principais alternadas por tabs:
 *  - "traces": dashboard de execuções (sidebar + console + stats)
 *  - "config": editor do AgentConfig (prompt, tools, sequências)
 *
 * Doc estática (docs/index.html servida pelo backend) abre em nova aba.
 */
type Tab = 'traces' | 'config';

export function App() {
  const [tab, setTab] = useState<Tab>('traces');

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <TopNav tab={tab} onChange={setTab} />
      {tab === 'traces' ? <TracesView /> : <AgentConfigPanel />}
    </div>
  );
}

function TopNav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string; icon: typeof Terminal }[] = [
    { id: 'traces', label: 'Execuções', icon: Terminal },
    { id: 'config', label: 'Configuração', icon: Settings },
  ];

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur flex items-center px-4 py-2 gap-1 shrink-0">
      <div className="flex items-center gap-2 pr-3 mr-2 border-r border-zinc-800/60">
        <div className="w-2 h-2 rounded-full bg-brand-400" />
        <span className="text-sm font-semibold text-zinc-100">Agente DT</span>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">MVP</span>
      </div>

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

      <a
        href="/docs"
        target="_blank"
        rel="noopener"
        className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60 ml-auto"
      >
        <BookOpen size={14} />
        Documentação
      </a>
    </div>
  );
}

function TracesView() {
  const { data: traces, loading } = usePolling(api.listTraces, 3000);
  const { data: stats } = usePolling(api.getStats, 5000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);

  useEffect(() => {
    if (!selectedId && traces && traces.length > 0) {
      setSelectedId(traces[0].id);
    }
  }, [traces, selectedId]);

  const detailInterval = detail?.status === 'RUNNING' ? 1000 : 4000;
  const { data: fetchedDetail } = usePolling(
    async () => (selectedId ? api.getTrace(selectedId) : null),
    detailInterval,
    [selectedId],
  );

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
