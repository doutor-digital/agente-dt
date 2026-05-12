import { Activity, CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { Stats } from '../types/api';

/**
 * Header do dashboard — 4 KPIs estilo "control panel".
 * Tons escuros + accents brand para diferenciar sucesso/falha sem usar
 * verde berrante (o AgentGPT usa violeta neon como cor primária).
 */
export function StatsHeader({ stats }: { stats: Stats | null }) {
  const cards = [
    {
      icon: Activity,
      label: 'Execuções totais',
      value: stats?.total ?? '—',
      tone: 'text-brand-300',
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
      tone: 'text-amber-300',
    },
    {
      icon: XCircle,
      label: 'Falhas',
      value: stats?.failed ?? '—',
      tone: 'text-rose-400',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      {cards.map(({ icon: Icon, label, value, tone }) => (
        <div
          key={label}
          className="rounded-lg border border-zinc-800 bg-zinc-900/40 backdrop-blur p-3 flex items-center gap-3"
        >
          <div className={`${tone} bg-zinc-950/60 rounded-md p-2 ring-1 ring-zinc-800`}>
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
            <div className="text-lg font-semibold text-zinc-100 truncate">{value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
