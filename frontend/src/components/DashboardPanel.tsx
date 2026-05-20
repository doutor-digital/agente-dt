// ============================================================================
// DashboardPanel — visão executiva da Unit (atividade do agente de IA).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Página default da app. KPIs centrados na operação do agente:
//
//   - Leads únicos             : pacientes distintos no período
//   - Conversas respondidas    : conversas onde a IA chegou a responder
//   - Leads do fim de semana   : criados em sáb/dom
//   - Conversas do fim de semana : qualquer mensagem em sáb/dom
//   - Taxa de transferência    : % de conversas que escalaram pra humano
//   - Tempo médio de resposta  : latência média do agente
//   - Perguntas sem resposta   : msgs do paciente sem resposta em 60min
//   - Conversões / Custo       : ainda úteis pra contexto financeiro
//
// Seletor de período (7d / 30d / 90d) — default 7d (alinhado ao mock).
//
// Dados vêm de GET /units/:id/dashboard?days=N que combina:
//   - métricas do nosso DB (conversations, messages, traces, llmCalls)
//   - leads do Kommo paginados (até 1000)
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Brain,
  CalendarDays,
  Clock4,
  DollarSign,
  Loader2,
  MessageCircleMore,
  RefreshCcw,
  Repeat,
  Sparkles,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';
import clsx from 'clsx';
import axios from 'axios';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { DashboardResponse } from '../types/api';

const PERIOD_OPTIONS = [
  { days: 7, label: 'Últimos 7 dias' },
  { days: 30, label: 'Últimos 30 dias' },
  { days: 90, label: 'Últimos 90 dias' },
];

export function DashboardPanel() {
  const { selectedUnitId, units } = useUnit();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const load = useCallback(async () => {
    if (!selectedUnitId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.unitDashboard(selectedUnitId, days);
      setData(r);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setError(
          'Dashboard indisponível — backend desta versão não expõe `/units/:id/dashboard`. Confirme se o backend de produção está atualizado.',
        );
      } else if (axios.isAxiosError(err) && !err.response) {
        setError('Não foi possível conectar ao backend. Verifique a variável VITE_API_URL do deploy.');
      } else {
        setError(err instanceof Error ? err.message : 'Falha ao carregar o dashboard.');
      }
    } finally {
      setLoading(false);
    }
  }, [selectedUnitId, days]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const unit = units.find((u) => u.id === selectedUnitId);

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra ver o dashboard.
      </div>
    );
  }

  const periodLabel = PERIOD_OPTIONS.find((p) => p.days === days)?.label ?? `${days} dias`;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-display font-bold text-zinc-100 tracking-tight">
              Painel
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              Atividade do agente de IA · {unit?.name ?? 'Unidade'} · {periodLabel.toLowerCase()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Period selector */}
            <div className="flex items-center bg-zinc-900 rounded-md ring-1 ring-zinc-800 p-0.5">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setDays(opt.days)}
                  className={clsx(
                    'text-xs px-3 py-1 rounded transition',
                    days === opt.days
                      ? 'bg-brand-500/20 text-brand-100 ring-1 ring-brand-500/30'
                      : 'text-zinc-400 hover:text-zinc-200',
                  )}
                >
                  {opt.days}d
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-md bg-zinc-900 text-zinc-200 ring-1 ring-zinc-800 hover:bg-zinc-800 disabled:opacity-50"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
              Atualizar
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <AlertTriangle size={18} className="text-amber-300 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <div className="font-semibold text-amber-200">Não foi possível carregar o painel</div>
              <div className="text-amber-100/80 text-[13px]">{error}</div>
            </div>
          </div>
        )}

        {/* Estatísticas — bloco principal de KPIs */}
        <section>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-3">
            Estatísticas
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              icon={<Users size={18} />}
              label="Leads únicos"
              value={data?.kpis.uniqueLeads ?? 0}
              sublabel="pacientes distintos no período"
              color="brand"
            />
            <KpiCard
              icon={<MessageCircleMore size={18} />}
              label="Conversas respondidas"
              value={data?.kpis.answeredConversations ?? 0}
              sublabel="onde a IA chegou a responder"
              color="sky"
            />
            <KpiCard
              icon={<CalendarDays size={18} />}
              label="Leads do fim de semana"
              value={data?.kpis.weekendLeads ?? 0}
              sublabel="criados em sábado/domingo"
              color="cyan"
            />
            <KpiCard
              icon={<CalendarDays size={18} />}
              label="Conversas de fim de semana"
              value={data?.kpis.weekendConversations ?? 0}
              sublabel="qualquer mensagem em sáb/dom"
              color="violet"
            />
            <KpiCard
              icon={<Repeat size={18} />}
              label="Taxa de transferência"
              value={data ? `${(data.kpis.handoffRate * 100).toFixed(0)}%` : '—'}
              sublabel={data ? `${data.kpis.handoffCount} escalados pra humano` : 'sem dados'}
              color="amber"
            />
            <KpiCard
              icon={<Brain size={18} />}
              label="Tempo médio de resposta"
              value={
                data && data.kpis.avgResponseLatencyMs > 0
                  ? `${(data.kpis.avgResponseLatencyMs / 1000).toFixed(1)}s`
                  : '—'
              }
              sublabel="latência média do agente"
              color="rose"
            />
            <KpiCard
              icon={<AlertCircle size={18} />}
              label="Perguntas sem resposta"
              value={data?.kpis.unansweredQuestions ?? 0}
              sublabel="sem reply em 60min"
              color="orange"
            />
            <KpiCard
              icon={<Clock4 size={18} />}
              label="Hora de pico"
              value={
                data?.kpis.peakHour !== null && data?.kpis.peakHour !== undefined
                  ? `${data.kpis.peakHour}h`
                  : '—'
              }
              sublabel="hora com mais mensagens"
              color="emerald"
            />
          </div>
        </section>

        {/* Bloco secundário — conversão e custo (contexto financeiro) */}
        <section>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-3">
            Conversão & custo
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <KpiCard
              icon={<Target size={18} />}
              label="Taxa de conversão"
              value={data ? `${(data.kpis.conversionRate * 100).toFixed(1)}%` : '—'}
              sublabel={data ? `${data.kpis.convertedCount} convertidos` : 'sem dados'}
              color="emerald"
            />
            <KpiCard
              icon={<TrendingUp size={18} />}
              label="Custo OpenAI"
              value={data ? `$${data.kpis.llmCostUsd.toFixed(2)}` : '—'}
              sublabel={data ? `${data.kpis.llmCallsCount} chamadas LLM` : 'sem dados'}
              color="amber"
            />
            <KpiCard
              icon={<DollarSign size={18} />}
              label="Custo médio/lead"
              value={
                data && data.kpis.uniqueLeads > 0
                  ? `$${(data.kpis.llmCostUsd / data.kpis.uniqueLeads).toFixed(3)}`
                  : '—'
              }
              sublabel="custo IA por lead único"
              color="violet"
            />
          </div>
        </section>

        {/* FUNIL */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles size={16} className="text-brand-300" />
            <h2 className="text-lg font-display font-semibold text-zinc-100">Funil de vendas</h2>
          </div>
          {!data && loading && (
            <div className="text-zinc-600 text-sm flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Carregando funil…
            </div>
          )}
          {data && data.funnel.length === 0 && (
            <div className="text-xs text-zinc-600 italic">
              Funil indisponível — confirme as credenciais Kommo da Unit (Unidades → token).
            </div>
          )}
          {data &&
            data.funnel.map((pipeline) => {
              const maxCount = Math.max(1, ...pipeline.statuses.map((s) => s.count));
              const totalInPipeline = pipeline.statuses.reduce((a, s) => a + s.count, 0);
              return (
                <div key={pipeline.pipelineId} className="mb-6 last:mb-0">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-display font-semibold text-zinc-200">
                      {pipeline.pipelineName}
                    </h3>
                    <span className="text-[11px] text-zinc-500">
                      {totalInPipeline} leads totais
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {pipeline.statuses.map((status) => {
                      const widthPct = (status.count / maxCount) * 100;
                      return (
                        <div key={status.statusId} className="group">
                          <div className="flex items-center gap-3 text-xs">
                            <div
                              className="w-44 shrink-0 text-zinc-300 truncate"
                              title={status.statusName}
                            >
                              {status.statusName}
                            </div>
                            <div className="flex-1 relative h-7 bg-zinc-950 rounded">
                              <div
                                className="absolute inset-y-0 left-0 rounded transition-all"
                                style={{
                                  width: `${widthPct}%`,
                                  background: status.color
                                    ? `linear-gradient(90deg, ${status.color}30, ${status.color}80)`
                                    : 'linear-gradient(90deg, rgba(124,77,255,0.15), rgba(124,77,255,0.55))',
                                }}
                              />
                              <div className="absolute inset-0 flex items-center justify-between px-3">
                                <span className="font-mono text-zinc-200 text-[11px]">
                                  {status.count}
                                </span>
                                <span className="text-[10px] text-zinc-500">
                                  #{status.statusId}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI Card — visual destacado pro dashboard.
// ---------------------------------------------------------------------------

const colorClasses: Record<string, { ring: string; bg: string; text: string; icon: string }> = {
  brand: {
    ring: 'ring-brand-500/30',
    bg: 'bg-brand-500/10',
    text: 'text-brand-100',
    icon: 'text-brand-300',
  },
  sky: { ring: 'ring-sky-500/30', bg: 'bg-sky-500/10', text: 'text-sky-100', icon: 'text-sky-300' },
  emerald: {
    ring: 'ring-emerald-500/30',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-100',
    icon: 'text-emerald-300',
  },
  amber: {
    ring: 'ring-amber-500/30',
    bg: 'bg-amber-500/10',
    text: 'text-amber-100',
    icon: 'text-amber-300',
  },
  violet: {
    ring: 'ring-violet-500/30',
    bg: 'bg-violet-500/10',
    text: 'text-violet-100',
    icon: 'text-violet-300',
  },
  rose: {
    ring: 'ring-rose-500/30',
    bg: 'bg-rose-500/10',
    text: 'text-rose-100',
    icon: 'text-rose-300',
  },
  cyan: {
    ring: 'ring-cyan-500/30',
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-100',
    icon: 'text-cyan-300',
  },
  orange: {
    ring: 'ring-orange-500/30',
    bg: 'bg-orange-500/10',
    text: 'text-orange-100',
    icon: 'text-orange-300',
  },
};

function KpiCard({
  icon,
  label,
  value,
  sublabel,
  color = 'brand',
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sublabel: string;
  color?: keyof typeof colorClasses;
}) {
  const c = colorClasses[color] ?? colorClasses.brand;
  return (
    <div
      className={clsx(
        'rounded-xl ring-1 p-4 transition-transform hover:-translate-y-0.5',
        c.ring,
        c.bg,
      )}
    >
      <div className={clsx('flex items-center gap-2 mb-3', c.icon)}>{icon}</div>
      <div className={clsx('text-2xl font-display font-bold tracking-tight', c.text)}>{value}</div>
      <div className="text-[11px] text-zinc-400 mt-1">{label}</div>
      <div className="text-[10px] text-zinc-500 mt-0.5">{sublabel}</div>
    </div>
  );
}
