// ============================================================================
// DashboardPanel — Painel executivo inspirado no dashboard nativo da Kommo.
//
// LÓGICA VISUAL
// -------------
// Estilo do painel nativo do Kommo: foto de fundo (céu) com overlay escuro,
// título centralizado (nome da unidade) + filtros segmentados, e cards
// translúcidos "glass" (bg escuro + ring claro) por cima. Grid masonry de 4
// colunas. Hero card = "Mensagens recebidas" (número GIGANTE violeta + lista
// por canal). Donut "Distribuição de leads" e funil ocupam linha cheia.
// Charts em SVG inline (sem dependência externa).
//
// DADOS
// -----
// Mesma fonte: GET /units/:id/dashboard?days=N. Sem mudança no backend.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,

  ArrowDownRight,
  ArrowUpRight,
  Brain,
  Calendar,
  CalendarDays,
  Clock4,
  DollarSign,
  LineChart,
  Loader2,
  MessageCircleMore,
  RefreshCcw,
  Repeat,
  Sparkles,
  Users,
} from 'lucide-react';
import clsx from 'clsx';
import axios from 'axios';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { DashboardResponse, LeadsBucket } from '../types/api';
import { LeadsBucketModal } from './LeadsBucketModal';
import { AllUnitsDashboard } from './AllUnitsDashboard';

const PERIOD_OPTIONS = [
  { days: 1, label: 'Hoje' },
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
  { days: 90, label: '90 dias' },
];

export function DashboardPanel() {
  const { selectedUnitId, units, setSelectedUnitId } = useUnit();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [openBucket, setOpenBucket] = useState<LeadsBucket | null>(null);

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
          'Dashboard indisponível — backend desta versão não expõe `/units/:id/dashboard`.',
        );
      } else if (axios.isAxiosError(err) && !err.response) {
        setError('Não foi possível conectar ao backend. Verifique a variável VITE_API_URL.');
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

  // "Todas as unidades" (nenhuma selecionada) → visão geral agregada, com
  // clique pra entrar em cada unidade.
  if (!selectedUnitId) {
    return <AllUnitsDashboard units={units} onSelectUnit={setSelectedUnitId} />;
  }

  const periodLabel = PERIOD_OPTIONS.find((p) => p.days === days)?.label ?? `${days}d`;

  return (
    <div
      className="flex-1 overflow-y-auto bg-cover bg-center bg-[#0a1628]"
      style={{
        // Foto de fundo (céu/paisagem) + overlay escuro pra manter os cards
        // translúcidos legíveis — estilo do painel do Kommo (img #4).
        backgroundImage:
          'linear-gradient(to bottom, rgba(8,8,12,0.74) 0%, rgba(8,8,12,0.88) 60%, rgba(8,8,12,0.96) 100%), url(https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=2000&q=70)',
      }}
    >
      <div className="max-w-[1400px] mx-auto p-6 space-y-6">
        {/* Header — título centralizado + filtros segmentados (estilo Kommo) */}
        <div className="flex flex-col items-center gap-4 pt-2">
          <div className="text-center">
            <h1 className="text-3xl md:text-4xl font-bold text-white tracking-tight drop-shadow-lg">
              {unit?.name ?? 'Painel'}
            </h1>
            <p className="text-xs text-zinc-300/90 mt-1">{periodLabel.toLowerCase()}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            {/* Filter pills — segmented control claro como o Kommo */}
            <div className="flex items-center bg-black/30 rounded-full ring-1 ring-white/15 p-1 backdrop-blur">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setDays(opt.days)}
                  className={clsx(
                    'text-xs px-4 py-1.5 rounded-full transition font-medium',
                    days === opt.days
                      ? 'bg-white text-zinc-900 shadow'
                      : 'text-zinc-200 hover:text-white',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-full bg-black/30 text-zinc-100 ring-1 ring-white/15 hover:bg-black/40 disabled:opacity-50 backdrop-blur"
              title="Atualizar"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <AlertTriangle size={18} className="text-amber-300 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <div className="font-semibold text-amber-200">Não foi possível carregar o painel</div>
              <div className="text-amber-100/80 text-[13px]">{error}</div>
            </div>
          </div>
        )}

        {/* GRID PRINCIPAL — layout masonry 4 cols
            ┌─────────────────┬───────┬───────┐
            │                 │ Conv  │ S/resp│
            │   HERO          ├───────┼───────┤
            │  (Conversas)    │ Tempo │ Pico  │
            │                 ├───────┴───────┤
            │                 │ Donut Funil   │
            └─────────────────┴───────────────┘ */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[minmax(140px,auto)]">
          {/* HERO — Conversas respondidas + lista de canais (col-span 2, row-span 2) */}
          <HeroCard data={data} loading={loading} />

          {/* KPIs em coluna lateral */}
          <BigStatCard
            label="Leads únicos"
            value={data?.kpis.uniqueLeads ?? 0}
            sublabel="pacientes distintos"
            color="purple"
            icon={<Users size={16} />}
            delta={
              data
                ? computeDelta(data.kpis.uniqueLeads, data.previousKpis.uniqueLeads)
                : undefined
            }
          />
          <BigStatCard
            label="Chats sem resposta"
            value={data?.kpis.unansweredQuestions ?? 0}
            sublabel="> 60min sem reply"
            color="purple"
            icon={<AlertCircle size={16} />}
            onClick={() => setOpenBucket('unanswered')}
          />
          <BigStatCard
            label="Tempo de resposta"
            value={
              data && data.kpis.avgResponseLatencyMs > 0
                ? formatLatency(data.kpis.avgResponseLatencyMs)
                : '—'
            }
            sublabel="latência média da IA"
            color="purple"
            icon={<Brain size={16} />}
          />
          <BigStatCard
            label="Hora de pico"
            value={
              data?.kpis.peakHour !== null && data?.kpis.peakHour !== undefined
                ? `${data.kpis.peakHour}h`
                : '—'
            }
            sublabel="hora com mais msgs"
            color="purple"
            icon={<Clock4 size={16} />}
          />

          {/* Donut + legend — col-span 2, row-span 2 */}
          <FunnelDonut data={data} />
        </div>

        {/* Sparkline — volume diário de mensagens + conversas */}
        <SparklineCard data={data} loading={loading} />

        {/* Stat strip — convertidos + custo, com badge de delta no total/custo */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatStrip
            label="Convertidos total"
            value={data?.kpis.convertedCount ?? 0}
            accent="text-emerald-300"
            sub={data ? `${(data.kpis.conversionRate * 100).toFixed(1)}% conversão` : ''}
            delta={
              data
                ? computeDelta(data.kpis.convertedCount, data.previousKpis.convertedCount)
                : undefined
            }
          />
          <StatStrip
            label="Convertidos pela IA"
            value={data?.kpis.convertedByIa ?? 0}
            accent="text-emerald-200"
            sub={data ? `${(data.kpis.conversionRateIa * 100).toFixed(1)}% sem humano` : ''}
            onClick={() => setOpenBucket('converted_ia')}
          />
          <StatStrip
            label="Convertidos pela SDR"
            value={data?.kpis.convertedBySdr ?? 0}
            accent="text-sky-200"
            sub={data ? `${(data.kpis.conversionRateSdr * 100).toFixed(1)}% pós-handoff` : ''}
            onClick={() => setOpenBucket('converted_sdr')}
          />
          <StatStrip
            label="Custo OpenAI"
            value={data ? `$${data.kpis.llmCostUsd.toFixed(2)}` : '—'}
            accent="text-amber-200"
            sub={data ? `${data.kpis.llmCallsCount} chamadas LLM` : ''}
            delta={
              data
                ? computeDelta(data.kpis.llmCostUsd, data.previousKpis.llmCostUsd)
                : undefined
            }
            // Custo mais alto NÃO é positivo — invertemos a cor do badge.
            deltaInverted
          />
        </div>

        {/* Segunda linha — fim de semana + handoff + custo por lead */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SecondaryCard
            label="Atividade no fim de semana"
            icon={<CalendarDays size={16} className="text-cyan-300" />}
          >
            <div className="grid grid-cols-2 gap-4 mt-3">
              <ClickRow
                label="Leads novos"
                value={data?.kpis.weekendLeads ?? 0}
                onClick={() => setOpenBucket('weekend_leads')}
              />
              <ClickRow
                label="Conversas"
                value={data?.kpis.weekendConversations ?? 0}
                onClick={() => setOpenBucket('weekend_conversations')}
              />
            </div>
          </SecondaryCard>

          <SecondaryCard
            label="Transferência pra humano"
            icon={<Repeat size={16} className="text-amber-300" />}
          >
            <div className="mt-3">
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-display font-bold text-amber-200">
                  {data ? `${(data.kpis.handoffRate * 100).toFixed(0)}%` : '—'}
                </span>
                <button
                  type="button"
                  onClick={() => setOpenBucket('handoff')}
                  className="text-xs text-zinc-400 hover:text-zinc-100"
                >
                  {data?.kpis.handoffCount ?? 0} escalados →
                </button>
              </div>
              <div className="text-[10px] text-zinc-500 mt-1">conversas que pediram humano</div>
            </div>
          </SecondaryCard>

          <SecondaryCard
            label="Custo médio por lead"
            icon={<DollarSign size={16} className="text-violet-300" />}
          >
            <div className="mt-3">
              <span className="text-3xl font-display font-bold text-violet-200">
                {data && data.kpis.uniqueLeads > 0
                  ? `$${(data.kpis.llmCostUsd / data.kpis.uniqueLeads).toFixed(3)}`
                  : '—'}
              </span>
              <div className="text-[10px] text-zinc-500 mt-1">
                custo IA / lead único
              </div>
            </div>
          </SecondaryCard>
        </div>

        {/* FUNIL DE VENDAS — full width */}
        <section className="rounded-2xl ring-1 ring-white/10 bg-zinc-900/45 p-6 backdrop-blur">
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
              Funil indisponível — confirme as credenciais Kommo da unidade.
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
                      const pct = totalInPipeline > 0 ? (status.count / totalInPipeline) * 100 : 0;
                      return (
                        <div key={status.statusId} className="group">
                          <div className="flex items-center gap-3 text-xs">
                            <div
                              className="w-44 shrink-0 text-zinc-300 truncate"
                              title={status.statusName}
                            >
                              {status.statusName}
                            </div>
                            <div className="flex-1 relative h-8 bg-zinc-950/60 rounded-md overflow-hidden ring-1 ring-zinc-800/40">
                              <div
                                className="absolute inset-y-0 left-0 rounded-md transition-all"
                                style={{
                                  width: `${widthPct}%`,
                                  background: status.color
                                    ? `linear-gradient(90deg, ${status.color}40, ${status.color}aa)`
                                    : 'linear-gradient(90deg, rgba(124,77,255,0.2), rgba(124,77,255,0.7))',
                                }}
                              />
                              <div className="absolute inset-0 flex items-center justify-between px-3">
                                <span className="font-mono text-zinc-100 text-[11px] font-bold">
                                  {status.count}
                                </span>
                                <span className="text-[10px] text-zinc-400 font-mono">
                                  {pct.toFixed(0)}%
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

      {openBucket && selectedUnitId && (
        <LeadsBucketModal
          unitId={selectedUnitId}
          bucket={openBucket}
          days={days}
          onClose={() => setOpenBucket(null)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// HeroCard — featured KPI no estilo Kommo: número GIGANTE verde + sublabel
// + lista de detalhamento. Aqui mostramos conversas respondidas com split
// de "primeiras mensagens" e "leads únicos".
// ===========================================================================

function HeroCard({
  data,
  loading,
}: {
  data: DashboardResponse | null;
  loading: boolean;
}) {
  const channels = data?.messagesByChannel ?? [];
  const totalMsgsByChannel = channels.reduce((a, c) => a + c.count, 0);
  // Sem volume de mensagens do período anterior; usamos a variação de conversas
  // respondidas como proxy de tendência só pro badge "esta semana".
  const delta = data
    ? computeDelta(data.kpis.answeredConversations, data.previousKpis.answeredConversations)
    : null;

  return (
    <div className="col-span-1 md:col-span-2 row-span-2 rounded-2xl bg-zinc-900/55 ring-1 ring-white/10 p-6 backdrop-blur relative overflow-hidden">
      <div className="relative">
        <div className="flex items-center gap-2 mb-2">
          <MessageCircleMore size={14} className="text-violet-300" />
          <span className="text-[10px] uppercase tracking-wider text-zinc-300 font-semibold">
            Mensagens recebidas
          </span>
        </div>

        {loading && !data ? (
          <div className="text-zinc-500 inline-flex items-center gap-2 text-sm mt-4">
            <Loader2 size={14} className="animate-spin" /> Carregando…
          </div>
        ) : (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="text-6xl md:text-7xl font-bold text-violet-300 tracking-tight leading-none">
                {totalMsgsByChannel}
              </div>
              {delta && <DeltaBadge {...delta} />}
            </div>
            <div className="text-xs text-zinc-400 mt-3">mensagens do paciente no período</div>

            {/* Lista por canal — nome à esquerda, contagem à direita (estilo Kommo) */}
            <ul className="mt-6 divide-y divide-white/5">
              {channels.length === 0 ? (
                <li className="py-3 text-xs text-zinc-500 italic">Sem mensagens no período.</li>
              ) : (
                channels.map((c, i) => (
                  <li key={c.channel} className="flex items-center gap-3 py-2.5 text-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: CHANNEL_PALETTE[i % CHANNEL_PALETTE.length] }}
                    />
                    <span className="text-zinc-300 truncate flex-1">{c.label}</span>
                    <span className="text-zinc-100 font-semibold tabular-nums shrink-0">{c.count}</span>
                  </li>
                ))
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

const CHANNEL_PALETTE = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#06b6d4'];

/** Calcula delta % entre valor atual e anterior. Retorna null se anterior=0. */
function computeDelta(current: number, previous: number): {
  pct: number;
  positive: boolean;
} | null {
  if (previous === 0) {
    if (current === 0) return null;
    // Subiu de 0 pra algo — não dá pct, mas marca "novo".
    return { pct: 100, positive: true };
  }
  const pct = ((current - previous) / previous) * 100;
  return { pct, positive: pct >= 0 };
}

function DeltaBadge({ pct, positive }: { pct: number; positive: boolean }) {
  const sign = positive ? '+' : '';
  const absPct = Math.abs(pct);
  // Trunca em 999% pra não estourar visual em casos absurdos.
  const display = absPct > 999 ? '>999' : absPct.toFixed(0);
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold font-mono ring-1',
        positive
          ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
          : 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
      )}
      title="Variação vs período anterior (mesma duração)"
    >
      {positive ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      {sign}
      {display}%
    </span>
  );
}

// ===========================================================================
// BigStatCard — KPI lateral com número grande colorido.
// ===========================================================================

const bigColors: Record<string, { number: string; ring: string; icon: string }> = {
  green: { number: 'text-emerald-300', ring: 'ring-emerald-500/20', icon: 'text-emerald-300' },
  purple: { number: 'text-violet-300', ring: 'ring-violet-500/20', icon: 'text-violet-300' },
  rose: { number: 'text-rose-300', ring: 'ring-rose-500/20', icon: 'text-rose-300' },
  amber: { number: 'text-amber-300', ring: 'ring-amber-500/20', icon: 'text-amber-300' },
  sky: { number: 'text-sky-300', ring: 'ring-sky-500/20', icon: 'text-sky-300' },
};

function BigStatCard({
  label,
  value,
  sublabel,
  color = 'purple',
  icon,
  delta,
  onClick,
}: {
  label: string;
  value: string | number;
  sublabel: string;
  color?: keyof typeof bigColors;
  icon?: React.ReactNode;
  /** Variação vs período anterior. Aparece como badge no canto superior direito. */
  delta?: { pct: number; positive: boolean } | null;
  onClick?: () => void;
}) {
  const c = bigColors[color] ?? bigColors.purple;
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={clsx(
        'rounded-2xl ring-1 ring-white/10 bg-zinc-900/55 backdrop-blur p-4 text-left transition-all relative',
        clickable
          ? 'cursor-pointer hover:border-zinc-700 hover:-translate-y-0.5'
          : 'cursor-default',
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={c.icon}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
          {label}
        </span>
        {delta && (
          <span className="ml-auto">
            <DeltaBadge {...delta} />
          </span>
        )}
      </div>
      <div className={clsx('text-4xl md:text-5xl font-display font-bold tracking-tight leading-none', c.number)}>
        {value}
      </div>
      <div className="text-[10px] text-zinc-500 mt-2">{sublabel}</div>
    </button>
  );
}

// ===========================================================================
// StatStrip — card horizontal na faixa inferior.
// ===========================================================================

function StatStrip({
  label,
  value,
  accent,
  sub,
  delta,
  deltaInverted,
  onClick,
}: {
  label: string;
  value: string | number;
  accent: string;
  sub: string;
  delta?: { pct: number; positive: boolean } | null;
  /** Quando true, inverte a semântica: subir é ruim (ex: custo). */
  deltaInverted?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  // Se o delta é "inverted" (custo), subir vira negativo visualmente.
  const adjustedDelta =
    delta && deltaInverted ? { ...delta, positive: !delta.positive } : delta;
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={clsx(
        'rounded-2xl ring-1 ring-white/10 bg-zinc-900/55 backdrop-blur p-4 text-left w-full transition-all',
        onClick && 'cursor-pointer hover:border-zinc-700',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold flex-1 min-w-0">
          {label}
        </div>
        {adjustedDelta && <DeltaBadge {...adjustedDelta} />}
      </div>
      <div className={clsx('text-3xl font-display font-bold tracking-tight', accent)}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-zinc-500 mt-1">{sub}</div>}
    </Tag>
  );
}

// ===========================================================================
// SparklineCard — gráfico de linha SVG mostrando mensagens + conversas por dia.
// Inspirado nos sparklines da Kommo. Sem dependência externa.
// ===========================================================================

function SparklineCard({
  data,
  loading,
}: {
  data: DashboardResponse | null;
  loading: boolean;
}) {
  const series = data?.dailySeries ?? [];
  const maxMsg = Math.max(1, ...series.map((s) => s.messages));
  const maxConv = Math.max(1, ...series.map((s) => s.conversations));
  const totalMsg = series.reduce((a, s) => a + s.messages, 0);
  const totalConv = series.reduce((a, s) => a + s.conversations, 0);

  return (
    <div className="rounded-2xl ring-1 ring-white/10 bg-zinc-900/55 backdrop-blur p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <LineChart size={14} className="text-sky-300" />
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
            Volume diário
          </span>
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="inline-flex items-center gap-1.5 text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Mensagens
            <span className="text-zinc-400 font-mono ml-1">{totalMsg}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-sky-300">
            <span className="w-2 h-2 rounded-full bg-sky-400" />
            Conversas
            <span className="text-zinc-400 font-mono ml-1">{totalConv}</span>
          </span>
        </div>
      </div>

      {loading && !data ? (
        <div className="h-32 flex items-center justify-center text-zinc-600 text-xs">
          <Loader2 size={14} className="animate-spin mr-2" />
          Carregando série…
        </div>
      ) : series.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-zinc-600 text-xs italic">
          Sem dados de mensagens no período.
        </div>
      ) : (
        <Sparkline series={series} maxMsg={maxMsg} maxConv={maxConv} />
      )}
    </div>
  );
}

function Sparkline({
  series,
  maxMsg,
  maxConv,
}: {
  series: Array<{ date: string; messages: number; conversations: number }>;
  maxMsg: number;
  maxConv: number;
}) {
  const W = 800;
  const H = 120;
  const PAD = { top: 8, right: 8, bottom: 18, left: 8 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const n = series.length;

  // Helper pra converter [valor, índice] em coordenadas SVG.
  const xAt = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const yMsg = (v: number) => PAD.top + innerH - (v / maxMsg) * innerH;
  const yConv = (v: number) => PAD.top + innerH - (v / maxConv) * innerH;

  // Path de linha + área.
  const msgPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)},${yMsg(s.messages)}`).join(' ');
  const msgArea = `${msgPath} L ${xAt(n - 1)},${PAD.top + innerH} L ${xAt(0)},${PAD.top + innerH} Z`;
  const convPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)},${yConv(s.conversations)}`).join(' ');

  // Labels de data — primeira, meio, última.
  const labelIdxs = n <= 1 ? [0] : n <= 3 ? Array.from({ length: n }, (_, i) => i) : [0, Math.floor(n / 2), n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
      {/* Grid horizontal sutil */}
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH / 2} y2={PAD.top + innerH / 2} stroke="rgba(82,82,91,0.15)" strokeWidth="1" />
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke="rgba(82,82,91,0.3)" strokeWidth="1" />

      {/* Área verde sob mensagens */}
      <path d={msgArea} fill="url(#sparkGradient)" opacity="0.5" />
      <defs>
        <linearGradient id="sparkGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Linha mensagens (verde) */}
      <path d={msgPath} fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Linha conversas (sky) */}
      <path d={convPath} fill="none" stroke="#0ea5e9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 4" />

      {/* Pontos */}
      {series.map((s, i) => (
        <g key={i}>
          <circle cx={xAt(i)} cy={yMsg(s.messages)} r="2.5" fill="#10b981" />
          <circle cx={xAt(i)} cy={yConv(s.conversations)} r="2" fill="#0ea5e9" />
          {/* tooltip via <title> nativo do SVG */}
          <title>
            {s.date}: {s.messages} msg · {s.conversations} conv
          </title>
        </g>
      ))}

      {/* Labels de data */}
      {labelIdxs.map((i) => {
        const d = series[i];
        const short = d.date.slice(5); // MM-DD
        return (
          <text
            key={i}
            x={xAt(i)}
            y={H - 4}
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            fontSize="9"
            fill="#71717a"
            fontFamily="ui-sans-serif, system-ui"
          >
            {short}
          </text>
        );
      })}
    </svg>
  );
}

// ===========================================================================
// SecondaryCard — card médio com label + conteúdo livre.
// ===========================================================================

function SecondaryCard({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl ring-1 ring-white/10 bg-zinc-900/55 backdrop-blur p-4">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function ClickRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-lg hover:bg-zinc-800/40 px-2 py-1.5 transition"
    >
      <div className="text-2xl font-display font-bold text-cyan-200">{value}</div>
      <div className="text-[10px] text-zinc-500">{label}</div>
    </button>
  );
}

// ===========================================================================
// FunnelDonut — donut chart SVG inline (sem dependência) que mostra a
// distribuição de leads entre os status do pipeline principal. Inspirado
// no "Fontes de Lead" do dashboard Kommo, mas com nossos dados.
// ===========================================================================

function FunnelDonut({ data }: { data: DashboardResponse | null }) {
  // Pega o pipeline principal (ou o 1º) e os top 5 status por count.
  const slices = useMemo(() => {
    if (!data || data.funnel.length === 0) return [];
    const main = data.funnel[0];
    const all = main.statuses
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count);
    if (all.length === 0) return [];
    // Top 4 + "outros"
    const top = all.slice(0, 4);
    const rest = all.slice(4);
    const restTotal = rest.reduce((a, s) => a + s.count, 0);
    const result = top.map((s, i) => ({
      label: s.statusName,
      count: s.count,
      color: s.color ?? PALETTE[i % PALETTE.length],
    }));
    if (restTotal > 0) {
      result.push({ label: 'Outros', count: restTotal, color: '#52525b' });
    }
    return result;
  }, [data]);

  const total = slices.reduce((a, s) => a + s.count, 0);

  return (
    <div className="col-span-1 md:col-span-2 row-span-2 rounded-2xl ring-1 ring-white/10 bg-zinc-900/55 backdrop-blur p-6 relative overflow-hidden">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles size={14} className="text-violet-300" />
        <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
          Distribuição de leads
        </span>
      </div>

      {slices.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-zinc-600 text-xs italic">
          Sem dados de funil ainda — confirme as credenciais Kommo.
        </div>
      ) : (
        <div className="flex items-center gap-6">
          <Donut slices={slices} total={total} />
          <ul className="flex-1 space-y-2 min-w-0">
            {slices.map((s) => {
              const pct = total > 0 ? (s.count / total) * 100 : 0;
              return (
                <li key={s.label} className="flex items-center gap-2 text-[11px] min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-zinc-300 truncate flex-1" title={s.label}>
                    {s.label}
                  </span>
                  <span className="text-zinc-500 font-mono shrink-0">
                    {s.count} · {pct.toFixed(0)}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {total > 0 && (
        <div className="absolute bottom-4 left-6 right-6">
          <div className="text-[10px] text-zinc-500 inline-flex items-center gap-1">
            <Calendar size={10} />
            Total: <span className="text-zinc-300 font-mono">{total}</span> leads no funil
          </div>
        </div>
      )}
    </div>
  );
}

const PALETTE = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e'];

/** SVG donut: 3 anéis concêntricos pra um visual "Kommo-like". */
function Donut({ slices, total }: { slices: Array<{ label: string; count: number; color: string }>; total: number }) {
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const strokeWidth = 14;
  const radius = size / 2 - strokeWidth / 2 - 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      {/* Track de fundo */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke="rgba(82,82,91,0.2)"
        strokeWidth={strokeWidth}
      />
      {slices.map((s) => {
        const length = total > 0 ? (s.count / total) * circumference : 0;
        const arc = (
          <circle
            key={s.label}
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke={s.color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: 'stroke-dasharray 0.5s ease' }}
          />
        );
        offset += length;
        return arc;
      })}
      {/* Texto central com total */}
      <text
        x={cx}
        y={cy - 4}
        textAnchor="middle"
        fontSize="28"
        fontWeight="700"
        fill="#fafafa"
        fontFamily="ui-sans-serif, system-ui"
      >
        {total}
      </text>
      <text
        x={cx}
        y={cy + 14}
        textAnchor="middle"
        fontSize="9"
        fill="#71717a"
        fontFamily="ui-sans-serif, system-ui"
        letterSpacing="1"
      >
        LEADS
      </text>
    </svg>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}
