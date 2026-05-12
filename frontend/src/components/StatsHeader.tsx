import { Activity, CheckCircle2, Clock, Cpu, DollarSign, XCircle, Zap } from 'lucide-react';
import type { Stats } from '../types/api';

/**
 * Header do dashboard — KPIs estilo "control panel" com observabilidade
 * de custo e tokens (multi-tenant).
 */
export function StatsHeader({ stats }: { stats: Stats | null }) {
  const cards = [
    {
      icon: Activity,
      label: 'Execuções',
      value: stats?.total ?? '—',
      tone: 'text-brand-300',
    },
    {
      icon: CheckCircle2,
      label: 'Taxa sucesso',
      value: stats ? `${(stats.successRate * 100).toFixed(1)}%` : '—',
      tone: 'text-emerald-400',
    },
    {
      icon: Clock,
      label: 'Latência média',
      value: stats ? `${stats.avgLatencyMs}ms` : '—',
      tone: 'text-amber-300',
    },
    {
      icon: XCircle,
      label: 'Falhas',
      value: stats?.failed ?? '—',
      tone: 'text-rose-400',
    },
    {
      icon: Cpu,
      label: 'Chamadas IA',
      value: stats?.llm.calls ?? '—',
      tone: 'text-sky-300',
    },
    {
      icon: Zap,
      label: 'Tokens',
      value: stats ? stats.llm.totalTokens.toLocaleString('pt-BR') : '—',
      tone: 'text-violet-300',
    },
    {
      icon: DollarSign,
      label: 'Custo USD',
      value: stats ? formatUsd(stats.llm.costUsd) : '—',
      tone: 'text-emerald-300',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5 mb-4">
      {cards.map(({ icon: Icon, label, value, tone }) => (
        <div
          key={label}
          className="rounded-lg border border-zinc-800 bg-zinc-900/40 backdrop-blur p-2.5 flex items-center gap-2"
        >
          <div className={`${tone} bg-zinc-950/60 rounded-md p-1.5 ring-1 ring-zinc-800`}>
            <Icon size={14} />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
            <div className="text-sm font-semibold text-zinc-100 truncate">{value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
