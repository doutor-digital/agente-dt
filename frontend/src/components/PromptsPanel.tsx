// ============================================================================
// PromptsPanel — Dimensionamento de qualidade de prompts (LLM-as-judge).
//
// LÓGICA DE UX
// ------------
// Mostra, por versão de prompt (hash), quantos leads converteram e a
// qualidade média da conversa segundo o juiz LLM. Permite drill-down em
// cada lead convertido pra ver scores detalhados + veredito qualitativo +
// o system prompt exato que estava em uso.
//
// O que NÃO mostramos: conversas não-convertidas (escopo do MVP). Próximo
// passo natural é avaliar uma amostra de não-convertidas pra contrastar.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, ChevronDown, ChevronRight, RefreshCw, AlertCircle, BadgeCheck } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { usePolling } from '../hooks/usePolling';
import type { PromptPerformanceItem, JudgeCriterion } from '../types/api';

export function PromptsPanel() {
  const { selectedUnitId } = useUnit();
  const [days, setDays] = useState(90);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetcher = useMemo(
    () => async () => (selectedUnitId ? api.getPromptPerformance(selectedUnitId, days) : null),
    [selectedUnitId, days],
  );
  const { data, loading, error, refresh } = usePolling(fetcher, 10_000, [selectedUnitId, days]);

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-zinc-600">
        Selecione uma unidade no topo pra ver a performance dos prompts.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <header className="flex items-center gap-3">
        <Sparkles size={18} className="text-brand-400" />
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Dimensionamento de Prompts</h2>
          <p className="text-[11px] text-zinc-500">
            LLM-as-judge: cada conversa convertida é avaliada por uma 2ª chamada de IA. Agrupado por
            hash do <code className="text-brand-300">systemPrompt</code> em uso no momento.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-xs rounded bg-zinc-900 ring-1 ring-zinc-800 px-2 py-1 text-zinc-300"
          >
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
            <option value={180}>Últimos 180 dias</option>
            <option value={365}>Último ano</option>
          </select>
          <button
            type="button"
            onClick={refresh}
            className="text-xs px-2 py-1 rounded bg-zinc-900 ring-1 ring-zinc-800 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1"
          >
            <RefreshCw size={11} />
            Atualizar
          </button>
        </div>
      </header>

      {loading && !data && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="animate-spin" size={14} />
          Carregando…
        </div>
      )}

      {error && (
        <div className="rounded-md ring-1 ring-rose-500/30 bg-rose-500/10 text-rose-200 px-3 py-2 text-xs">
          Erro carregando dados: {String(error.message ?? error)}
        </div>
      )}

      {data && (
        <>
          <TotalsRow totals={data.totals} />

          {data.totals.converted === 0 && (
            <div className="rounded-md ring-1 ring-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-start gap-2">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold mb-1">Nenhuma conversão registrada ainda.</div>
                <div className="text-amber-200/80">
                  Verifique se você cadastrou os <strong>Status IDs de Conversão (Ganho)</strong>{' '}
                  da unidade na aba "Unidades". Eles são os IDs das etapas do seu funil Kommo que
                  representam "Ganho/Convertido". Quando um lead entrar numa dessas etapas, a
                  conversa é marcada e o juiz LLM avalia automaticamente.
                </div>
              </div>
            </div>
          )}

          {data.totals.pendingJudge > 0 && (
            <div className="text-[11px] text-zinc-500">
              {data.totals.pendingJudge} conversa(s) convertida(s) aguardando avaliação do juiz.
              (Avaliação roda em background no webhook; se ficou presa, clique em "Reavaliar"
              numa conversa pra disparar manualmente.)
            </div>
          )}

          {data.prompts.length > 0 && (
            <div className="space-y-3">
              {data.prompts.map((p) => (
                <PromptCard
                  key={p.promptHash}
                  item={p}
                  criteria={data.criteria}
                  expanded={expanded === p.promptHash}
                  onToggle={() =>
                    setExpanded(expanded === p.promptHash ? null : p.promptHash)
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linha de totais
// ---------------------------------------------------------------------------

function TotalsRow({
  totals,
}: {
  totals: { conversations: number; converted: number; evaluated: number; conversionRate: number };
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Kpi label="Conversas no período" value={totals.conversations.toString()} />
      <Kpi
        label="Convertidas"
        value={totals.converted.toString()}
        hint={`${(totals.conversionRate * 100).toFixed(1)}% das conversas`}
      />
      <Kpi label="Avaliadas pelo juiz" value={totals.evaluated.toString()} />
      <Kpi
        label="Conversão"
        value={`${(totals.conversionRate * 100).toFixed(1)}%`}
        hint="converted / total"
      />
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md ring-1 ring-zinc-800 bg-zinc-900/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100 mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-zinc-500">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card de um prompt (versão)
// ---------------------------------------------------------------------------

function PromptCard({
  item,
  criteria,
  expanded,
  onToggle,
}: {
  item: PromptPerformanceItem;
  criteria: JudgeCriterion[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const overallColor =
    item.avgOverall >= 8 ? 'text-emerald-300' :
    item.avgOverall >= 6 ? 'text-amber-300' :
    'text-rose-300';

  return (
    <div className="rounded-lg ring-1 ring-zinc-800 bg-zinc-900/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-900/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-zinc-500 shrink-0" />
        )}
        <BadgeCheck size={14} className="text-brand-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <code className="text-[10px] text-zinc-500">#{item.promptHash}</code>
            <span className="text-xs text-zinc-300 truncate">
              {snippet(item.promptSnapshot)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0 text-xs">
          <div>
            <span className="text-zinc-500">conv.</span>{' '}
            <span className="text-zinc-100 font-semibold">{item.conversions}</span>
          </div>
          <div>
            <span className="text-zinc-500">score</span>{' '}
            <span className={clsx('font-semibold', overallColor)}>{item.avgOverall.toFixed(1)}</span>
          </div>
          <div className="text-zinc-500 text-[10px]">
            ${item.totalCostUsd.toFixed(4)}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {/* Médias por critério */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
              Score médio por critério
            </div>
            <div className="grid grid-cols-5 gap-2">
              {criteria.map((c) => {
                const v = (item.avgScores as Record<string, number>)[c.key] ?? 0;
                return (
                  <div key={c.key}>
                    <div className="text-[10px] text-zinc-500 truncate" title={c.desc}>
                      {c.label}
                    </div>
                    <ScoreBar value={v} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Snapshot do prompt */}
          <details className="rounded ring-1 ring-zinc-800 bg-zinc-950/50">
            <summary className="cursor-pointer text-xs text-zinc-400 px-3 py-2">
              System prompt usado nesta versão
            </summary>
            <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap px-3 pb-3 font-mono leading-relaxed max-h-72 overflow-auto">
              {item.promptSnapshot}
            </pre>
          </details>

          {/* Top conversões */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
              Leads convertidos com este prompt
            </div>
            <div className="space-y-2">
              {item.topEvaluations.map((e) => (
                <div
                  key={e.conversationId}
                  className="rounded ring-1 ring-zinc-800 bg-zinc-950/40 p-3"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs font-medium text-zinc-200">
                      Lead #{e.leadId}
                      {e.contactName && (
                        <span className="text-zinc-500"> — {e.contactName}</span>
                      )}
                    </span>
                    <span className="ml-auto text-[10px] text-zinc-500">
                      {e.convertedAt ? new Date(e.convertedAt).toLocaleString('pt-BR') : ''}
                    </span>
                    <span
                      className={clsx(
                        'text-xs font-semibold',
                        e.overallScore >= 8
                          ? 'text-emerald-300'
                          : e.overallScore >= 6
                          ? 'text-amber-300'
                          : 'text-rose-300',
                      )}
                    >
                      {e.overallScore.toFixed(1)}
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-2 mb-2">
                    {criteria.map((c) => {
                      const v = (e.scores as Record<string, number>)[c.key] ?? 0;
                      return (
                        <div key={c.key}>
                          <div className="text-[9px] text-zinc-600 truncate">{c.label}</div>
                          <ScoreBar value={v} compact />
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">{e.verdict}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreBar({ value, compact }: { value: number; compact?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  const color =
    value >= 8 ? 'bg-emerald-400' :
    value >= 6 ? 'bg-amber-400' :
    value >= 4 ? 'bg-orange-400' :
    'bg-rose-400';
  return (
    <div className="flex items-center gap-1.5">
      <div className={clsx('flex-1 bg-zinc-800/80 rounded-full overflow-hidden', compact ? 'h-1' : 'h-1.5')}>
        <div className={clsx('h-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={clsx('text-[10px] tabular-nums', compact ? 'text-zinc-500' : 'text-zinc-400')}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function snippet(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 120) + '…' : clean || '(prompt vazio)';
}
