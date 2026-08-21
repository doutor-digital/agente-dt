import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,

  ArrowDownRight,
  ArrowUpRight,
  Brain,
  Calendar,
  CalendarCheck,
  CalendarDays,
  Clock4,
  DollarSign,
  Flame,
  LineChart,
  Loader2,
  MessageCircleMore,
  RefreshCcw,
  Repeat,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { Trophy } from 'lucide-react';
import axios from 'axios';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { DashboardResponse, LeadsBucket, UnitInput } from '../types/api';
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

  if (!selectedUnitId) {
    return <AllUnitsDashboard units={units} onSelectUnit={setSelectedUnitId} />;
  }

  const periodLabel = PERIOD_OPTIONS.find((p) => p.days === days)?.label ?? `${days}d`;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-350 mx-auto p-6 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow mb-1.5">Painel do agente</div>
            <h1 className="text-2xl font-semibold text-zinc-50 tracking-tight truncate">
              {unit?.name ?? 'Painel'}
            </h1>
            <p className="text-[13px] text-zinc-500 mt-1">
              Últimos dados de {periodLabel.toLowerCase()}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900/60">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setDays(opt.days)}
                  className={clsx(
                    'text-[12px] px-3 py-1.5 rounded-md transition-colors',
                    days === opt.days
                      ? 'bg-zinc-800 text-zinc-50 font-medium'
                      : 'text-zinc-500 hover:text-zinc-200',
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
              className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 disabled:opacity-50 transition-colors"
              title="Atualizar"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            </button>
          </div>
        </div>

        <SofiaJourney data={data} periodLabel={periodLabel} />

        {error && (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <AlertTriangle size={18} className="text-amber-300 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <div className="font-semibold text-amber-200">Não foi possível carregar o painel</div>
              <div className="text-amber-100/80 text-[13px]">{error}</div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[minmax(140px,auto)]">
          <HeroCard data={data} loading={loading} />

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

          <FunnelDonut data={data} />
        </div>

        <SparklineCard data={data} loading={loading} />

        <div className="rounded-xl border border-brand-500/30 bg-brand-500/[0.06] p-5 flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-brand-200/80 font-semibold">
              📅 Consultas agendadas pela IA
            </div>
            <div className="mt-1 text-4xl font-bold text-brand-100 tabular-nums">
              {data?.kpis.aiScheduledConsults ?? 0}
            </div>
            <div className="text-[12px] text-zinc-400 mt-1">
              {data
                ? `${(data.kpis.aiScheduledRate * 100).toFixed(1)}% dos leads do período · ${data.kpis.aiScheduledTotal} no total (desde sempre)`
                : ''}
            </div>
          </div>
          <p className="text-right text-[11px] text-zinc-500 max-w-[240px] hidden sm:block">
            Consultas que a Sofia marcou de fato na agenda da clínica — não é "entrou em etapa",
            é o agendamento concreto.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
          <EconomicsCard
            data={data}
            unitId={selectedUnitId}
            onTicketSaved={() => void load()}
          />
          <ShowRateCard data={data} />
        </div>

        <HotQueueCard data={data} />

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
            deltaInverted
          />
        </div>

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

const journeyTones = {
  brand: { text: 'text-brand-200', num: 'text-brand-100', chip: 'bg-brand-500/15 ring-brand-500/25 text-brand-200' },
  cyan: { text: 'text-cyan-200', num: 'text-cyan-100', chip: 'bg-cyan-500/15 ring-cyan-500/25 text-cyan-200' },
  emerald: { text: 'text-emerald-200', num: 'text-emerald-100', chip: 'bg-emerald-500/15 ring-emerald-500/25 text-emerald-200' },
} as const;

function JourneyStage({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  tone: keyof typeof journeyTones;
}) {
  const t = journeyTones[tone];
  return (
    <div className="flex-1 min-w-[110px]">
      <div className={clsx('inline-flex items-center gap-1.5 text-[11px] font-medium', t.text)}>
        <span className={clsx('grid place-items-center w-6 h-6 rounded-lg ring-1', t.chip)}>{icon}</span>
      </div>
      <div className={clsx('mt-2.5 font-display font-bold tracking-tight leading-none tabular-nums text-4xl sm:text-5xl', t.num)}>
        {value}
      </div>
      <div className="text-[12px] text-zinc-400 mt-1.5">{label}</div>
    </div>
  );
}

function JourneyConnector({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex sm:flex-col items-center justify-center gap-1 shrink-0 px-1 sm:px-2 self-center">
      <span className="hidden sm:block text-[13px] font-semibold font-mono text-zinc-200 tabular-nums">
        {pct.toFixed(0)}%
      </span>
      <svg width="34" height="10" viewBox="0 0 34 10" className="text-zinc-600" fill="none">
        <path d="M0 5 H28" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
        <path d="M27 1 L33 5 L27 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[10px] text-zinc-500 sm:mt-0.5 whitespace-nowrap">
        <span className="sm:hidden font-mono text-zinc-300">{pct.toFixed(0)}% </span>
        {label}
      </span>
    </div>
  );
}

function SofiaJourney({
  data,
  periodLabel,
}: {
  data: DashboardResponse | null;
  periodLabel: string;
}) {
  const atendeu = data?.kpis.uniqueLeads ?? 0;
  const agendou = data?.kpis.aiScheduledConsults ?? 0;
  const fechou = data?.kpis.convertedCount ?? 0;
  const r1 = atendeu > 0 ? (agendou / atendeu) * 100 : 0;
  const r2 = agendou > 0 ? (fechou / agendou) * 100 : 0;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-2xl ring-1 ring-white/10 p-6 sm:p-7 bg-gradient-to-br from-brand-500/[0.13] via-zinc-900/50 to-emerald-500/[0.08]"
    >
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-24 -left-10 w-72 h-72 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute -bottom-28 right-0 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <div className="relative">
        <div className="flex items-center gap-2 mb-5">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-200/90">
            <Sparkles size={13} /> A jornada da Sofia
          </span>
          <span className="text-[11px] text-zinc-500">· {periodLabel.toLowerCase()}</span>
        </div>

        <div className="flex items-stretch gap-1 sm:gap-3">
          <JourneyStage icon={<MessageCircleMore size={13} />} value={atendeu} label="pacientes atendidos" tone="brand" />
          <JourneyConnector pct={r1} label="viraram consulta" />
          <JourneyStage icon={<Calendar size={13} />} value={agendou} label="consultas agendadas" tone="cyan" />
          <JourneyConnector pct={r2} label="fecharam" />
          <JourneyStage icon={<Trophy size={13} />} value={fechou} label="pacientes fechados" tone="emerald" />
        </div>
      </div>
    </motion.section>
  );
}

function HeroCard({
  data,
  loading,
}: {
  data: DashboardResponse | null;
  loading: boolean;
}) {
  const channels = data?.messagesByChannel ?? [];
  const totalMsgsByChannel = channels.reduce((a, c) => a + c.count, 0);
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

function computeDelta(current: number, previous: number): {
  pct: number;
  positive: boolean;
} | null {
  if (previous === 0) {
    if (current === 0) return null;
    return { pct: 100, positive: true };
  }
  const pct = ((current - previous) / previous) * 100;
  return { pct, positive: pct >= 0 };
}

function DeltaBadge({ pct, positive }: { pct: number; positive: boolean }) {
  const sign = positive ? '+' : '';
  const absPct = Math.abs(pct);
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
  deltaInverted?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
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

  const xAt = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const yMsg = (v: number) => PAD.top + innerH - (v / maxMsg) * innerH;
  const yConv = (v: number) => PAD.top + innerH - (v / maxConv) * innerH;

  const msgPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)},${yMsg(s.messages)}`).join(' ');
  const msgArea = `${msgPath} L ${xAt(n - 1)},${PAD.top + innerH} L ${xAt(0)},${PAD.top + innerH} Z`;
  const convPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)},${yConv(s.conversations)}`).join(' ');

  const labelIdxs = n <= 1 ? [0] : n <= 3 ? Array.from({ length: n }, (_, i) => i) : [0, Math.floor(n / 2), n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH / 2} y2={PAD.top + innerH / 2} stroke="rgba(82,82,91,0.15)" strokeWidth="1" />
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke="rgba(82,82,91,0.3)" strokeWidth="1" />

      <path d={msgArea} fill="url(#sparkGradient)" opacity="0.5" />
      <defs>
        <linearGradient id="sparkGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d={msgPath} fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={convPath} fill="none" stroke="#0ea5e9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 4" />

      {series.map((s, i) => (
        <g key={i}>
          <circle cx={xAt(i)} cy={yMsg(s.messages)} r="2.5" fill="#10b981" />
          <circle cx={xAt(i)} cy={yConv(s.conversations)} r="2" fill="#0ea5e9" />
          <title>
            {s.date}: {s.messages} msg · {s.conversations} conv
          </title>
        </g>
      ))}

      {labelIdxs.map((i) => {
        const d = series[i];
        const short = d.date.slice(5);
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

function fmtBrl(v: number, cents = false): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

function EconomicsCard({
  data,
  unitId,
  onTicketSaved,
}: {
  data: DashboardResponse | null;
  unitId: string | null;
  onTicketSaved: () => void;
}) {
  const eco = data?.economics;
  const [editing, setEditing] = useState(false);
  const [ticket, setTicket] = useState('');
  const [saving, setSaving] = useState(false);

  async function saveTicket() {
    if (!unitId) return;
    const n = Number(ticket.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return;
    setSaving(true);
    try {
      await api.updateUnit(unitId, { avgTicketBrl: n } as Partial<UnitInput>);
      setEditing(false);
      onTicketSaved();
    } catch {
    } finally {
      setSaving(false);
    }
  }

  const hasTicket = eco != null && eco.avgTicketBrl != null;
  const revenue = eco?.potentialRevenueBrl ?? null;
  const cost = eco?.totalCostBrl ?? 0;
  const roi = eco?.roi ?? null;

  return (
    <div className="rounded-2xl ring-1 ring-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.08] to-zinc-900/40 backdrop-blur p-5">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <Wallet size={16} className="text-emerald-300" />
          <span className="text-[10px] uppercase tracking-wider text-emerald-200/80 font-semibold">
            Receita × custo da IA
          </span>
        </div>
        {roi != null && (
          <span
            className={clsx(
              'text-[11px] font-semibold px-2 py-0.5 rounded-full tabular-nums',
              roi >= 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300',
            )}
          >
            ROI {roi >= 0 ? '+' : ''}
            {(roi * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {!hasTicket ? (
        <div>
          <p className="text-[13px] text-zinc-300 leading-relaxed">
            Quanto vale, em média, uma consulta fechada aqui? Com esse valor eu mostro{' '}
            <span className="text-emerald-300 font-medium">quanto a Sofia gerou de receita</span> vs
            quanto ela custou.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-[13px]">
                R$
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveTicket()}
                placeholder="250"
                className="w-32 pl-9 pr-3 py-2 rounded-lg bg-zinc-950/70 border border-zinc-700 text-[14px] text-zinc-100 outline-none focus:border-emerald-500 tabular-nums"
              />
            </div>
            <button
              type="button"
              onClick={saveTicket}
              disabled={saving || !ticket.trim() || !unitId}
              className="px-3.5 py-2 rounded-lg bg-emerald-500 text-zinc-950 text-[13px] font-medium hover:bg-emerald-400 disabled:opacity-40"
            >
              {saving ? 'Salvando…' : 'Salvar ticket'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] text-zinc-400">Receita potencial</div>
            <div className="text-3xl font-display font-bold text-emerald-300 tabular-nums mt-0.5">
              {revenue != null ? fmtBrl(revenue) : '—'}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1">
              {eco?.aiScheduledPeriod ?? 0} consultas × {fmtBrl(eco?.avgTicketBrl ?? 0)}
              <button
                type="button"
                onClick={() => {
                  setTicket(String(eco?.avgTicketBrl ?? ''));
                  setEditing(true);
                }}
                className="ml-1.5 text-zinc-400 hover:text-emerald-300 underline decoration-dotted"
              >
                editar
              </button>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-zinc-400">Custo da IA</div>
            <div className="text-3xl font-display font-bold text-zinc-100 tabular-nums mt-0.5">
              {fmtBrl(cost)}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1">
              LLM {fmtBrl(eco?.llmCostBrl ?? 0, true)} · WhatsApp {fmtBrl(eco?.whatsappCostBrl ?? 0, true)}
            </div>
          </div>
          <div className="col-span-2 flex items-center gap-4 pt-3 border-t border-white/5">
            <div className="text-[12px] text-zinc-400">
              Custo por consulta agendada:{' '}
              <span className="text-zinc-100 font-medium tabular-nums">
                {eco?.costPerScheduledBrl != null ? fmtBrl(eco.costPerScheduledBrl, true) : '—'}
              </span>
            </div>
            {editing && (
              <div className="flex items-center gap-1.5 ml-auto">
                <span className="text-zinc-500 text-[13px]">R$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={ticket}
                  onChange={(e) => setTicket(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveTicket()}
                  className="w-20 px-2 py-1 rounded-md bg-zinc-950/70 border border-zinc-700 text-[13px] text-zinc-100 outline-none focus:border-emerald-500 tabular-nums"
                />
                <button
                  type="button"
                  onClick={saveTicket}
                  disabled={saving}
                  className="px-2.5 py-1 rounded-md bg-emerald-500 text-zinc-950 text-[12px] font-medium hover:bg-emerald-400 disabled:opacity-40"
                >
                  ok
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="text-zinc-500 hover:text-zinc-300 text-[12px]"
                >
                  cancelar
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ShowRateCard({ data }: { data: DashboardResponse | null }) {
  const sr = data?.showRate;
  return (
    <div className="rounded-2xl ring-1 ring-white/10 bg-zinc-900/55 backdrop-blur p-5">
      <div className="flex items-center gap-2 mb-3">
        <CalendarCheck size={16} className="text-sky-300" />
        <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
          Comparecimento
        </span>
      </div>
      {sr?.available ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-display font-bold text-sky-200 tabular-nums">
              {(sr.rate * 100).toFixed(0)}%
            </span>
            <span className="text-[12px] text-zinc-400">apareceram</span>
          </div>
          <div className="mt-3 h-2 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-sky-400"
              style={{ width: `${Math.min(100, sr.rate * 100)}%` }}
            />
          </div>
          <div className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
            {sr.attendedCount} compareceram de {sr.scheduledCount + sr.attendedCount} agendados
            <br />
            <span className="text-zinc-600">
              etapas: “{sr.scheduledStageName}” → “{sr.attendedStageName}”
            </span>
          </div>
        </>
      ) : (
        <p className="text-[12px] text-zinc-500 leading-relaxed">
          Ainda não consigo medir. Preciso de uma etapa de{' '}
          <span className="text-zinc-300">“Compareceu”/“Atendido”</span> no funil do Kommo pra
          comparar com os agendados. Assim que ela existir e tiver leads, o índice aparece aqui.
        </p>
      )}
    </div>
  );
}

function fmtWait(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? ` ${min % 60}min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function HotQueueCard({ data }: { data: DashboardResponse | null }) {
  const queue = data?.hotQueue ?? [];
  const openConversation = () => window.dispatchEvent(new CustomEvent('app:openConversation'));
  return (
    <div className="rounded-2xl ring-1 ring-amber-500/20 bg-zinc-900/55 backdrop-blur p-5">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <Flame size={16} className="text-amber-300" />
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
            Leads quentes esperando humano
          </span>
        </div>
        {queue.length > 0 && (
          <span className="text-[11px] text-amber-300 font-semibold tabular-nums">
            {queue.length} na fila
          </span>
        )}
      </div>
      <p className="text-[11px] text-zinc-500 mb-3">
        A IA passou pra pessoa e ninguém fechou nem agendou. Do mais antigo (mais frio) pro mais
        recente.
      </p>
      {queue.length === 0 ? (
        <div className="text-[12px] text-zinc-500 italic py-4 text-center">
          Nenhum lead quente parado. 🎉 Fila limpa.
        </div>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {queue.map((q) => {
            const urgent = q.waitingMinutes >= 120;
            return (
              <button
                key={q.leadId}
                type="button"
                onClick={openConversation}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-950/40 hover:bg-zinc-800/50 transition text-left"
              >
                <span
                  className={clsx(
                    'h-2 w-2 rounded-full shrink-0',
                    urgent ? 'bg-rose-400' : 'bg-amber-400',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-zinc-100 truncate">
                    {q.contactName || q.phone || `Lead ${q.leadId}`}
                  </div>
                  <div className="text-[10.5px] text-zinc-500">
                    {q.reactivations > 0 ? `reativado ${q.reactivations}× · ` : ''}
                    esperando há {fmtWait(q.waitingMinutes)}
                  </div>
                </div>
                <span
                  className={clsx(
                    'text-[11px] font-medium tabular-nums shrink-0',
                    urgent ? 'text-rose-300' : 'text-amber-300',
                  )}
                >
                  {fmtWait(q.waitingMinutes)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FunnelDonut({ data }: { data: DashboardResponse | null }) {
  const slices = useMemo(() => {
    if (!data || data.funnel.length === 0) return [];
    const main = data.funnel[0];
    const all = main.statuses
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count);
    if (all.length === 0) return [];
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

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}
