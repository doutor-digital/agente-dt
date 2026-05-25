// ============================================================================
// AllUnitsDashboard — visão geral de TODAS as unidades (modo "painel geral",
// quando nenhuma unidade está selecionada). Busca o dashboard de cada unidade
// em paralelo e agrega: leads, conversas, gasto por IA, convertidos, conversão.
// Mostra um card por unidade (com mini-funil de etapas) e permite entrar nela.
//
// Sem endpoint agregado no back — fan-out de N requests (ok pra poucas units).
// Tags não entram aqui: não são contadas no nosso banco (vão pro Kommo).
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { DashboardResponse, Unit } from '../types/api';
import { CATEGORY_OPTIONS } from './WizardPanel';

const PERIOD_OPTIONS = [
  { days: 1, label: 'Hoje' },
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
  { days: 90, label: '90 dias' },
];
const SKY =
  'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=2000&q=70';
const STAGE_PALETTE = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#06b6d4', '#52525b'];

function categoryLabel(cat: string | null): string {
  const o = CATEGORY_OPTIONS.find((c) => c.value === (cat ?? ''));
  return o && o.value ? o.label : 'Genérica';
}

interface Row {
  unit: Unit;
  data: DashboardResponse | null;
  error: boolean;
}

export function AllUnitsDashboard({
  units,
  onSelectUnit,
}: {
  units: Unit[];
  onSelectUnit: (id: string) => void;
}) {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(
      units.map(async (u): Promise<Row> => {
        try {
          const d = await api.unitDashboard(u.id, days);
          return { unit: u, data: d, error: false };
        } catch {
          return { unit: u, data: null, error: true };
        }
      }),
    );
    // Ordena por gasto de IA desc (as que mais consomem aparecem primeiro).
    results.sort((a, b) => (b.data?.kpis.llmCostUsd ?? 0) - (a.data?.kpis.llmCostUsd ?? 0));
    setRows(results);
    setLoading(false);
  }, [units, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    let leads = 0;
    let conversas = 0;
    let custo = 0;
    let convertidos = 0;
    let msgs = 0;
    for (const r of rows) {
      if (!r.data) continue;
      leads += r.data.kpis.uniqueLeads;
      conversas += r.data.kpis.answeredConversations;
      custo += r.data.kpis.llmCostUsd;
      convertidos += r.data.kpis.convertedCount;
      msgs += r.data.messagesByChannel.reduce((a, c) => a + c.count, 0);
    }
    return { leads, conversas, custo, convertidos, msgs, conv: leads > 0 ? (convertidos / leads) * 100 : 0 };
  }, [rows]);

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
              {units.length} unidade{units.length === 1 ? '' : 's'} · visão geral
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

        {/* KPIs agregados */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <AggCard icon={<Users size={15} />} label="Leads únicos" value={totals.leads} />
          <AggCard icon={<MessageCircleMore size={15} />} label="Conversas" value={totals.conversas} />
          <AggCard icon={<DollarSign size={15} />} label="Gasto IA (total)" value={`$${totals.custo.toFixed(2)}`} accent="text-amber-300" />
          <AggCard icon={<CheckCircle2 size={15} />} label="Convertidos" value={totals.convertidos} accent="text-emerald-300" />
          <AggCard label="Conversão média" value={`${totals.conv.toFixed(1)}%`} accent="text-emerald-300" />
        </div>

        {/* Cards por unidade */}
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-zinc-300">
            <Loader2 className="animate-spin mr-2" size={18} /> Carregando unidades…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {rows.map((r) => (
              <UnitMiniCard key={r.unit.id} row={r} onClick={() => onSelectUnit(r.unit.id)} />
            ))}
          </div>
        )}

        <p className="text-[11px] text-zinc-400 text-center">
          Clique numa unidade pra ver o painel completo dela (funil, canais, custos detalhados).
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

function UnitMiniCard({ row, onClick }: { row: Row; onClick: () => void }) {
  const { unit, data, error } = row;
  const leads = data?.kpis.uniqueLeads ?? 0;
  const conversas = data?.kpis.answeredConversations ?? 0;
  const custo = data?.kpis.llmCostUsd ?? 0;
  const conv = data && data.kpis.uniqueLeads > 0 ? (data.kpis.convertedCount / data.kpis.uniqueLeads) * 100 : 0;

  // Mini-funil: status do pipeline principal como barra empilhada.
  const stages = (data?.funnel[0]?.statuses ?? []).filter((s) => s.count > 0);
  const stageTotal = stages.reduce((a, s) => a + s.count, 0);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left rounded-2xl bg-zinc-900/55 ring-1 ring-white/10 hover:ring-brand-400/60 hover:bg-zinc-900/70 hover:-translate-y-1 backdrop-blur p-5 transition-all duration-300"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-zinc-100 font-semibold truncate">{unit.name}</div>
          <div className="mt-1 inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-white/5 ring-1 ring-white/10 text-zinc-300">
            {categoryLabel(unit.category)}
          </div>
        </div>
        <ArrowRight size={16} className="shrink-0 text-zinc-500 group-hover:text-brand-300 group-hover:translate-x-0.5 transition-all" />
      </div>

      {error ? (
        <div className="mt-4 text-xs text-rose-300/80 italic">Falha ao carregar esta unidade.</div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Metric label="Leads" value={leads} />
            <Metric label="Conversas" value={conversas} />
            <Metric label="Conversão" value={`${conv.toFixed(0)}%`} accent="text-emerald-300" />
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Gasto IA</span>
            <span className="text-amber-300 font-semibold tabular-nums">${custo.toFixed(2)}</span>
          </div>

          {/* Mini-funil de etapas */}
          {stages.length > 0 && (
            <div className="mt-3">
              <div className="flex h-2 rounded-full overflow-hidden ring-1 ring-white/10">
                {stages.map((s, i) => (
                  <div
                    key={s.statusId}
                    title={`${s.statusName}: ${s.count}`}
                    style={{
                      width: `${(s.count / stageTotal) * 100}%`,
                      backgroundColor: s.color ?? STAGE_PALETTE[i % STAGE_PALETTE.length],
                    }}
                  />
                ))}
              </div>
              <div className="text-[10px] text-zinc-500 mt-1">{stageTotal} leads no funil</div>
            </div>
          )}
        </>
      )}
    </button>
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
