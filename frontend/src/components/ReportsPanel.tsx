// ============================================================================
// ReportsPanel — exportação de relatórios em CSV ou PDF.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Painel simples com 4 cards (1 por relatório). Cada card tem:
//   - título + descrição
//   - filtros locais (período: from/to)
//   - botões "Baixar CSV" e "Baixar PDF"
//
// O escopo de unit é controlado pelo backend (UNIT_ADMIN vê só sua unit;
// SUPER_ADMIN pode passar unitId ou ver tudo). Aqui exibimos um seletor só
// pra SUPER_ADMIN, lendo `useUnit().selectedUnitId` quando preenchido.
// ============================================================================

import { useState } from 'react';
import {
  BarChart3,
  Cpu,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  AlertOctagon,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

type ReportType = 'conversations' | 'llm-cost' | 'actions' | 'errors';

interface ReportMeta {
  type: ReportType;
  title: string;
  description: string;
  icon: typeof BarChart3;
  accent: string;
}

const REPORTS: ReportMeta[] = [
  {
    type: 'conversations',
    title: 'Conversas & Conversão',
    description:
      'Volume de conversas no período, leads convertidos, contato e canal — uma linha por conversa.',
    icon: BarChart3,
    accent: 'emerald',
  },
  {
    type: 'llm-cost',
    title: 'Custo & Uso da IA',
    description:
      'Tokens consumidos (prompt/completion) e custo em USD agrupado por modelo e unit.',
    icon: Cpu,
    accent: 'violet',
  },
  {
    type: 'actions',
    title: 'Ações Disparadas pela IA',
    description:
      'Cada tool call que a IA executou no Kommo (tags, etapas, pausas, etc.) com timestamp e contexto.',
    icon: Zap,
    accent: 'amber',
  },
  {
    type: 'errors',
    title: 'Erros & Falhas',
    description:
      'Falhas de chamadas LLM e erros do agente. Útil pra investigar incidentes e instabilidades.',
    icon: AlertOctagon,
    accent: 'rose',
  },
];

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const past = new Date();
  past.setDate(past.getDate() - 30);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(past), to: fmt(today) };
}

export function ReportsPanel() {
  const { selectedUnitId } = useUnit();
  const { user } = useAuth();
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const isSuper = user?.role === 'SUPER_ADMIN';

  async function handleDownload(type: ReportType, format: 'csv' | 'pdf') {
    const key = `${type}:${format}`;
    setLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.downloadReport(type, format, {
        // SUPER_ADMIN: respeita a unit selecionada se houver; senão devolve todas.
        // UNIT_ADMIN: backend força a sua unit — qualquer valor aqui seria
        // ignorado, mas mandamos por completude.
        unitId: isSuper ? selectedUnitId ?? undefined : selectedUnitId ?? undefined,
        from: range.from,
        to: range.to,
      });
      toast.success(`Relatório (${format.toUpperCase()}) baixado.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao gerar relatório: ${msg}`);
    } finally {
      setLoading((s) => ({ ...s, [key]: false }));
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-display font-bold text-zinc-100 tracking-tight flex items-center gap-2">
            <FileText size={22} className="text-emerald-300" />
            Relatórios
          </h1>
          <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
            Baixe extratos em CSV (planilha) ou PDF (relatório formatado). O período padrão
            é os últimos 30 dias — ajuste abaixo se precisar.
          </p>
        </div>

        {/* Filtros globais */}
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block mb-1.5">
              Período — de
            </label>
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-emerald-500/40 rounded-md px-3 py-1.5 text-sm text-zinc-200 outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block mb-1.5">
              até
            </label>
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-emerald-500/40 rounded-md px-3 py-1.5 text-sm text-zinc-200 outline-none"
            />
          </div>
          <div className="text-[11px] text-zinc-500 ml-auto">
            {isSuper
              ? selectedUnitId
                ? `Filtrando pela unit selecionada (${selectedUnitId.slice(0, 8)}…). Limpe a unit pra ver todas.`
                : 'Sem unit selecionada — relatório cobre TODAS as units.'
              : 'Relatório limitado à sua unit.'}
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-fr">
          {REPORTS.map((r) => (
            <ReportCard
              key={r.type}
              meta={r}
              loadingCsv={!!loading[`${r.type}:csv`]}
              loadingPdf={!!loading[`${r.type}:pdf`]}
              onCsv={() => handleDownload(r.type, 'csv')}
              onPdf={() => handleDownload(r.type, 'pdf')}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReportCard({
  meta,
  loadingCsv,
  loadingPdf,
  onCsv,
  onPdf,
}: {
  meta: ReportMeta;
  loadingCsv: boolean;
  loadingPdf: boolean;
  onCsv: () => void;
  onPdf: () => void;
}) {
  const Icon = meta.icon;
  const accentRing: Record<string, string> = {
    emerald: 'ring-emerald-500/30 hover:ring-emerald-500/60',
    violet: 'ring-violet-500/30 hover:ring-violet-500/60',
    amber: 'ring-amber-500/30 hover:ring-amber-500/60',
    rose: 'ring-rose-500/30 hover:ring-rose-500/60',
  };
  const accentIcon: Record<string, string> = {
    emerald: 'text-emerald-300',
    violet: 'text-violet-300',
    amber: 'text-amber-300',
    rose: 'text-rose-300',
  };
  return (
    <div
      className={clsx(
        'rounded-xl bg-zinc-900/40 ring-1 transition-shadow p-5 flex flex-col gap-4',
        accentRing[meta.accent],
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'w-10 h-10 rounded-lg bg-zinc-950 ring-1 ring-zinc-800 flex items-center justify-center shrink-0',
          )}
        >
          <Icon size={18} className={accentIcon[meta.accent]} />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-zinc-100">{meta.title}</h2>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{meta.description}</p>
        </div>
      </div>

      <div className="flex gap-2 mt-auto">
        <button
          type="button"
          onClick={onCsv}
          disabled={loadingCsv || loadingPdf}
          className="flex-1 inline-flex items-center justify-center gap-2 text-xs px-3 py-2 rounded-md bg-zinc-800/80 hover:bg-zinc-800 text-zinc-200 font-medium disabled:opacity-50 disabled:cursor-wait"
        >
          {loadingCsv ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FileSpreadsheet size={13} />
          )}
          CSV
        </button>
        <button
          type="button"
          onClick={onPdf}
          disabled={loadingCsv || loadingPdf}
          className="flex-1 inline-flex items-center justify-center gap-2 text-xs px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50 disabled:cursor-wait"
        >
          {loadingPdf ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          PDF
        </button>
      </div>
    </div>
  );
}
