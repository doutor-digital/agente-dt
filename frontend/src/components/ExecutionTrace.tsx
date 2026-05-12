import { Clock, Hash, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { TraceStep } from './TraceStep';
import type { TraceDetail } from '../types/api';

const STATUS_BADGE = {
  RUNNING: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  SUCCESS: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  FAILED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

/**
 * Console principal — feed vertical animado dos steps do LangGraph.
 * Quando o trace está RUNNING, mostramos um caret piscando no final
 * sugerindo "digitando" (vibe AgentGPT terminal).
 */
export function ExecutionTrace({ trace }: { trace: TraceDetail | null }) {
  if (!trace) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 px-6">
        <div className="text-5xl mb-4 opacity-30">🤖</div>
        <h2 className="text-lg font-medium text-zinc-400 mb-1">Selecione uma execução</h2>
        <p className="text-xs text-zinc-600 text-center max-w-sm">
          Escolha um webhook na barra lateral para ver o raciocínio passo-a-passo do agente.
        </p>
      </div>
    );
  }

  const running = trace.status === 'RUNNING';

  return (
    <main className="flex-1 overflow-y-auto">
      {/* HEADER do trace */}
      <header className="sticky top-0 z-10 bg-zinc-950/85 backdrop-blur-md border-b border-zinc-800/80 px-6 py-4">
        <div className="flex items-center gap-3 mb-2">
          <span
            className={clsx(
              'px-2 py-0.5 rounded-md text-[10px] font-semibold ring-1 uppercase tracking-wider',
              STATUS_BADGE[trace.status],
            )}
          >
            {trace.status}
          </span>
          <h1 className="text-lg font-semibold text-zinc-100">
            Lead <span className="text-brand-400">#{trace.leadId}</span>
          </h1>
          {running && <Loader2 className="animate-spin text-amber-400 ml-1" size={16} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 font-mono">
          <span className="flex items-center gap-1.5">
            <Hash size={11} />
            <span className="truncate max-w-[16ch]">{trace.threadId}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Clock size={11} />
            {new Date(trace.createdAt).toLocaleString('pt-BR')}
          </span>
          {trace.latencyMs != null && (
            <span className="flex items-center gap-1.5">
              ⏱
              <span className="text-zinc-300">{trace.latencyMs}ms</span>
            </span>
          )}
          {typeof trace.iaDecision === 'string' && trace.iaDecision && (
            <span className="text-zinc-400 truncate">
              💡 <span className="text-zinc-300">{trace.iaDecision}</span>
            </span>
          )}
        </div>
      </header>

      {/* FEED de steps */}
      <div className="px-6 py-6">
        {trace.steps.length === 0 ? (
          <div className="text-xs text-zinc-600">Aguardando primeiro step…</div>
        ) : (
          <div>
            {trace.steps.map((step, i) => (
              <TraceStep key={step.id} step={step} index={i} />
            ))}
            {running && (
              <div className="pl-12 mt-1 text-xs text-zinc-500 font-mono caret">
                Agente raciocinando
              </div>
            )}
          </div>
        )}

        {trace.errorMessage && (
          <div className="mt-4 ml-12 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
            <div className="font-semibold mb-1 uppercase tracking-wider text-[10px]">Erro</div>
            {trace.errorMessage}
          </div>
        )}
      </div>
    </main>
  );
}
