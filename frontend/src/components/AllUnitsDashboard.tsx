// ============================================================================
// AllUnitsDashboard — visão geral de TODAS as unidades (modo "painel geral").
// Consome o endpoint agregado GET /dashboard (1 request) e mostra, no formato
// do painel do Kommo: totais (leads, conversas, gasto IA, convertidos,
// conversão), mensagens por canal somadas, e um card por unidade com drill-in.
// Filtros: período + categoria/segmento.
// Funil (etapas) fica no painel por-unidade — clicar numa unidade entra nele.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  DollarSign,
  Loader2,
  MessageCircleMore,
  RefreshCcw,
  Users,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { AggregateDashboardResponse, Unit } from '../types/api';
import { CATEGORY_OPTIONS } from './WizardPanel';

const PERIOD_OPTIONS = [
  { days: 1, label: 'Hoje' },
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
  { days: 90, label: '90 dias' },
];
const SKY =
  'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=2000&q=70';
const CHANNEL_PALETTE = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#06b6d4'];

// Opções do FILTRO de categoria ("Todas" + as categorias reais, sem a "Genérica").
const CATEGORY_FILTERS = [
  { value: '', label: 'Todas as categorias' },
  ...CATEGORY_OPTIONS.filter((o) => o.value),
];

function categoryLabel(cat: string | null): string {
  const o = CATEGORY_OPTIONS.find((c) => c.value === (cat ?? ''));
  return o && o.value ? o.label : 'Genérica';
}

export function AllUnitsDashboard({
  units,
  onSelectUnit,
}: {
  units: Unit[];
  onSelectUnit: (id: string) => void;
}) {
  const [days, setDays] = useState(7);
  const [category, setCategory] = useState('');
  const [data, setData] = useState<AggregateDashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.aggregateDashboard(days, category || undefined);
      setData(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar o painel geral.');
    } finally {
      setLoading(false);
    }
  }, [days, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = data?.totals;
  const channels = data?.messagesByChannel ?? [];
  const totalMsgs = channels.reduce((a, c) => a + c.count, 0);
  const rows = data?.units ?? [];

  return (
    <div
      className="flex-1 overflow-y-auto bg-cover bg-center bg-[#0a1628]"
      style={{
        backgroundImage: `linear-gradient(to bottom, rgba(8,8,12,0.78) 0%, rgba(8,8,12,0.92) 60%, rgba(8,8,12,0.96) 100%), url(${SKY})`,
      }}
    >
      <div className="max-w-[1400px] mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col items-center gap-4 pt-2">
          <div className="text-center">
            <h1 className="text-3xl md:text-4xl font-bold text-white tracking-tight drop-shadow-lg">
              Todas as unidades
            </h1>
            <p className="text-xs text-zinc-300/90 mt-1">
              {rows.length || units.length} unidade{(rows.length || units.length) === 1 ? '' : 's'} · visão geral
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <div className="flex items-center bg-black/30 rounded-full ring-1 ring-white/15 p-1 backdrop-blur">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setDays(opt.days)}
                  className={clsx(
                    'text-xs px-4 py-1.5 rounded-full transition font-medium',
                    days === opt.days ? 'bg-white text-zinc-900 shadow' : 'text-zinc-200 hover:text-white',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="text-xs px-3 py-2 rounded-full bg-black/30 text-zinc-100 ring-1 ring-white/15 hover:bg-black/40 backdrop-blur focus:outline-none"
            >
              {CATEGORY_FILTERS.map((o) => (
                <option key={o.value} value={o.value} className="bg-zinc-900">
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-full bg-black/30 text-zinc-100 ring-1 ring-white/15 hover:bg-black/40 disabled:opacity-50 backdrop-blur"
              title="Atualizar"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl ring-1 ring-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            {error}
          </div>
        )}

        {/* KPIs agregados */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <AggCard icon={<Users size={15} />} label="Leads únicos" value={totals?.uniqueLeads ?? 0} />
          <AggCard icon={<MessageCircleMore size={15} />} label="Conversas" value={totals?.answeredConversations ?? 0} />
          <AggCard icon={<DollarSign size={15} />} label="Gasto IA (total)" value={`$${(totals?.llmCostUsd ?? 0).toFixed(2)}`} accent="text-amber-300" />
          <AggCard icon={<CheckCircle2 size={15} />} label="Convertidos" value={totals?.convertedCount ?? 0} accent="text-emerald-300" />
          <AggCard label="Conversão média" value={`${((totals?.conversionRate ?? 0) * 100).toFixed(1)}%`} accent="text-emerald-300" />
        </div>

        {/* Mensagens por canal (somadas) */}
        <div className="rounded-2xl bg-zinc-900/55 ring-1 ring-white/10 backdrop-blur p-5">
          <div className="flex items-center gap-2 mb-1">
            <MessageCircleMore size={14} className="text-violet-300" />
            <span className="text-[10px] uppercase tracking-wider text-zinc-300 font-semibold">
              Mensagens recebidas (todas as unidades)
            </span>
          </div>
          <div className="text-4xl font-bold text-violet-300 tracking-tight">{totalMsgs}</div>
          {channels.length > 0 ? (
            <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6">
              {channels.map((c, i) => (
                <li key={c.channel} className="flex items-center gap-3 py-2 text-sm border-b border-white/5">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: CHANNEL_PALETTE[i % CHANNEL_PALETTE.length] }} />
                  <span className="text-zinc-300 truncate flex-1">{c.label}</span>
                  <span className="text-zinc-100 font-semibold tabular-nums">{c.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-3 text-xs text-zinc-500 italic">Sem mensagens no período.</div>
          )}
        </div>

        {/* Cards por unidade */}
        {loading && !data ? (
          <div className="flex items-center justify-center py-12 text-zinc-300">
            <Loader2 className="animate-spin mr-2" size={18} /> Carregando…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {rows.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onSelectUnit(u.id)}
                className="group text-left rounded-2xl bg-zinc-900/55 ring-1 ring-white/10 hover:ring-brand-400/60 hover:bg-zinc-900/70 hover:-translate-y-1 backdrop-blur p-5 transition-all duration-300"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-zinc-100 font-semibold truncate">{u.name}</div>
                    <div className="mt-1 inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-white/5 ring-1 ring-white/10 text-zinc-300">
                      {categoryLabel(u.category)}
                    </div>
                  </div>
                  <ArrowRight size={16} className="shrink-0 text-zinc-500 group-hover:text-brand-300 group-hover:translate-x-0.5 transition-all" />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <Metric label="Leads" value={u.uniqueLeads} />
                  <Metric label="Conversas" value={u.answeredConversations} />
                  <Metric label="Conversão" value={`${(u.conversionRate * 100).toFixed(0)}%`} accent="text-emerald-300" />
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">Gasto IA · {u.llmCallsCount} chamadas</span>
                  <span className="text-amber-300 font-semibold tabular-nums">${u.llmCostUsd.toFixed(2)}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        <p className="text-[11px] text-zinc-400 text-center">
          Clique numa unidade pra ver o painel completo dela (funil de etapas, canais, custos detalhados).
        </p>
      </div>
    </div>
  );
}

function AggCard({
  icon,
  label,
  value,
  accent = 'text-violet-300',
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div className="rounded-2xl bg-zinc-900/55 ring-1 ring-white/10 backdrop-blur p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
        {icon && <span className="text-zinc-400">{icon}</span>}
        {label}
      </div>
      <div className={clsx('mt-2 text-3xl font-bold tracking-tight', accent)}>{value}</div>
    </div>
  );
}

function Metric({ label, value, accent = 'text-zinc-100' }: { label: string; value: string | number; accent?: string }) {
  return (
    <div>
      <div className={clsx('text-xl font-bold tracking-tight', accent)}>{value}</div>
      <div className="text-[10px] text-zinc-500">{label}</div>
    </div>
  );
}
