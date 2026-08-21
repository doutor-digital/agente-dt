import { Activity, CheckCircle2, Clock, Cpu, DollarSign, XCircle, Zap } from 'lucide-react';
import type { Stats } from '../types/api';

export function StatsHeader({ stats }: { stats: Stats | null }) {
  const cards = [
    {
      icon: Activity,
      label: 'Execuções',
      value: stats?.total ?? '—',
      tone: 'text-brand-400',
    },
    {
      icon: CheckCircle2,
      label: 'Taxa de sucesso',
      value: stats ? `${(stats.successRate * 100).toFixed(1)}%` : '—',
      tone: 'text-emerald-400',
    },
    {
      icon: Clock,
      label: 'Latência média',
      value: stats ? `${stats.avgLatencyMs}ms` : '—',
      tone: 'text-amber-400',
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
      tone: 'text-sky-400',
    },
    {
      icon: Zap,
      label: 'Tokens',
      value: stats ? stats.llm.totalTokens.toLocaleString('pt-BR') : '—',
      tone: 'text-violet-400',
    },
    {
      icon: DollarSign,
      label: 'Custo USD',
      value: stats ? formatUsd(stats.llm.costUsd) : '—',
      tone: 'text-teal-400',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mb-5">
      {cards.map(({ icon: Icon, label, value, tone }) => (
        <div
          key={label}
          className="group relative rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 transition-colors hover:border-zinc-700"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 truncate">
              {label}
            </span>
            <Icon size={13} className={`${tone} shrink-0 opacity-70`} />
          </div>
          <div className="mt-2 text-lg font-semibold tracking-tight text-zinc-50 truncate tabular-nums">
            {value}
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
