import { Bot, Circle, Loader2, ZapOff } from 'lucide-react';
import clsx from 'clsx';
import type { TraceSummary } from '../types/api';

interface Props {
  traces: TraceSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

const statusIcon = {
  RUNNING: <Loader2 className="animate-spin text-amber-400" size={14} />,
  SUCCESS: <Circle className="text-emerald-400 fill-emerald-400" size={10} />,
  FAILED: <ZapOff className="text-rose-400" size={14} />,
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/**
 * Sidebar escura com histórico de webhooks.
 * Layout inspirado em ChatGPT/AgentGPT: lista densa, item ativo destacado
 * com borda esquerda + bg ligeiramente mais claro.
 */
export function Sidebar({ traces, selectedId, onSelect, loading }: Props) {
  return (
    <aside className="w-72 shrink-0 bg-ink-900 border-r border-zinc-800/80 flex flex-col h-screen">
      <div className="px-4 py-4 border-b border-zinc-800/80 flex items-center gap-2">
        <div className="bg-brand-600/20 text-brand-300 ring-1 ring-brand-500/40 rounded-md p-1.5">
          <Bot size={18} />
        </div>
        <div>
          <div className="text-sm font-semibold text-zinc-100 leading-none">Agente DT</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">Kommo Automation Console</div>
        </div>
      </div>

      <div className="px-4 py-3 text-[11px] uppercase tracking-wider text-zinc-500 flex items-center justify-between">
        <span>Histórico de webhooks</span>
        {loading && <Loader2 size={12} className="animate-spin text-zinc-500" />}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {traces.length === 0 && !loading && (
          <div className="px-3 py-8 text-center text-xs text-zinc-600">
            Nenhuma execução ainda.
            <br />
            Dispare um webhook em<br />
            <code className="text-brand-400">/api/webhooks/{'{slug}'}/kommo</code>
          </div>
        )}

        <ul className="space-y-1">
          {traces.map((t) => {
            const active = t.id === selectedId;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  className={clsx(
                    'w-full text-left rounded-md px-3 py-2.5 transition border-l-2',
                    active
                      ? 'bg-zinc-800/70 border-brand-500 glow-brand'
                      : 'border-transparent hover:bg-zinc-800/40',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {statusIcon[t.status]}
                    <span className="text-xs font-medium text-zinc-200 truncate">
                      Lead #{t.leadId}
                    </span>
                    <span className="ml-auto text-[10px] text-zinc-500 shrink-0">
                      {timeAgo(t.createdAt)}
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-500 truncate flex items-center gap-1.5">
                    {t.channel && (
                      <span className="px-1 py-0.5 rounded bg-zinc-800/60 text-[9px] text-zinc-400 uppercase">
                        {t.channel}
                      </span>
                    )}
                    <span className="truncate">
                      {t.latencyMs ? `${t.latencyMs}ms · ` : ''}
                      {t.status === 'RUNNING' ? 'Executando…' : (
                        typeof t.iaDecision === 'string'
                          ? t.iaDecision
                          : t.status === 'SUCCESS' ? 'Concluído' : 'Falha'
                      )}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="px-4 py-3 border-t border-zinc-800/80 text-[10px] text-zinc-600">
        <div className="flex items-center justify-between">
          <span>v0.1.0 · MVP</span>
          <span className="text-brand-500">●</span>
        </div>
      </div>
    </aside>
  );
}
