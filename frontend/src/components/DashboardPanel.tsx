// ============================================================================
// DashboardPanel — visão executiva da Unit.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Página default da app. Mostra:
//   - 6 KPI cards grandes (hoje, 30d, conversão, custo, custo/lead, hora pico)
//   - Funil de vendas: contagem de leads por etapa, em barras horizontais
//     com largura proporcional ao maior valor.
//
// Dados vêm de GET /units/:id/dashboard que combina:
//   - métricas do nosso DB (conversations, llmCalls, traces)
//   - leads do Kommo paginados (até 1000)
//
// Reflete o estado dos últimos 30 dias.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Brain,
  Clock4,
  DollarSign,
  Flame,
  Loader2,
  MessageCircleMore,
  RefreshCcw,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { DashboardResponse } from '../types/api';

export function DashboardPanel() {
  const { selectedUnitId, units } = useUnit();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedUnitId) return;
    setLoading(true);
    try {
      const r = await api.unitDashboard(selectedUnitId);
      setData(r);
    } finally {
      setLoading(false);
    }
  }, [selectedUnitId]);

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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold text-zinc-100 tracking-tight">
              Dashboard
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              {unit?.name ?? 'Unidade'} · últimos 30 dias
            </p>
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

        {/* KPIs grandes */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            icon={<MessageCircleMore size={18} />}
            label="Conversas hoje"
            value={data?.kpis.conversationsToday ?? 0}
            sublabel="leads atendidos hoje"
            color="brand"
          />
          <KpiCard
            icon={<Activity size={18} />}
            label="Conversas 30d"
            value={data?.kpis.conversationsLast30d ?? 0}
            sublabel="total no último mês"
            color="sky"
          />
          <KpiCard
            icon={<Target size={18} />}
            label="Taxa de conversão"
            value={data ? `${(data.kpis.conversionRate30d * 100).toFixed(1)}%` : '—'}
            sublabel={data ? `${data.kpis.convertedLast30d} convertidos` : 'sem dados'}
            color="emerald"
          />
          <KpiCard
            icon={<TrendingUp size={18} />}
            label="Custo total"
            value={data ? `$${data.kpis.llmCostUsd30d.toFixed(2)}` : '—'}
            sublabel={data ? `${data.kpis.llmCallsLast30d} chamadas LLM` : 'sem dados'}
            color="amber"
          />
          <KpiCard
            icon={<DollarSign size={18} />}
            label="Custo médio/lead"
            value={data ? `$${data.kpis.avgCostPerLead.toFixed(3)}` : '—'}
            sublabel="custo OpenAI por conversa"
            color="violet"
          />
          <KpiCard
            icon={<Brain size={18} />}
            label="Latência média"
            value={data ? `${data.kpis.avgResponseLatencyMs}ms` : '—'}
            sublabel="tempo médio de resposta"
            color="rose"
          />
          <KpiCard
            icon={<Clock4 size={18} />}
            label="Hora de pico"
            value={data?.kpis.peakHour !== null && data?.kpis.peakHour !== undefined ? `${data.kpis.peakHour}h` : '—'}
            sublabel="hora com mais mensagens"
            color="cyan"
          />
          <KpiCard
            icon={<Flame size={18} />}
            label="Conversão (abs)"
            value={data?.kpis.convertedLast30d ?? 0}
            sublabel="leads marcados como ganho"
            color="orange"
          />
        </div>

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
                            <div className="w-44 shrink-0 text-zinc-300 truncate" title={status.statusName}>
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
  brand: { ring: 'ring-brand-500/30', bg: 'bg-brand-500/10', text: 'text-brand-100', icon: 'text-brand-300' },
  sky: { ring: 'ring-sky-500/30', bg: 'bg-sky-500/10', text: 'text-sky-100', icon: 'text-sky-300' },
  emerald: { ring: 'ring-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-100', icon: 'text-emerald-300' },
  amber: { ring: 'ring-amber-500/30', bg: 'bg-amber-500/10', text: 'text-amber-100', icon: 'text-amber-300' },
  violet: { ring: 'ring-violet-500/30', bg: 'bg-violet-500/10', text: 'text-violet-100', icon: 'text-violet-300' },
  rose: { ring: 'ring-rose-500/30', bg: 'bg-rose-500/10', text: 'text-rose-100', icon: 'text-rose-300' },
  cyan: { ring: 'ring-cyan-500/30', bg: 'bg-cyan-500/10', text: 'text-cyan-100', icon: 'text-cyan-300' },
  orange: { ring: 'ring-orange-500/30', bg: 'bg-orange-500/10', text: 'text-orange-100', icon: 'text-orange-300' },
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
