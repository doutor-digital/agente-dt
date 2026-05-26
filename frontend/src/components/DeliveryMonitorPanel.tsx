// ============================================================================
// DeliveryMonitorPanel — "Saúde da Entrega" (Salesbot do Kommo).
//
// LÓGICA DE ENGENHARIA
// --------------------
// O backend grava a resposta no campo "Resposta IA" (PATCH) e quem ENTREGA ao
// WhatsApp é o Salesbot do Kommo, disparado pelo Digital Pipeline. Quando a
// fila do Kommo engasga, a entrega atrasa (já vimos 36 min). O monitor
// (stale-reply-monitor.ts) fecha o ciclo via webhook outgoing e mede a demora.
//
// Este painel lê /api/delivery-monitor (polling 15s) e mostra:
//   - Status geral (OK / parado / sem confirmação)
//   - Pendentes agora + latência média das últimas entregas
//   - Lista do que está PARADO agora (acima do limiar)
//   - Histórico recente de entregas confirmadas com latência
// ============================================================================

import { Loader2, RefreshCw, Truck, Turtle, CheckCircle2, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { usePolling } from '../hooks/usePolling';
import type { DeliveryMonitor } from '../types/api';

const POLL_MS = 15_000;

function fmtLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

function fmtAge(sec: number): string {
  if (sec < 60) return `há ${sec}s`;
  if (sec < 3600) return `há ${Math.round(sec / 60)}min`;
  return `há ${Math.round(sec / 3600)}h`;
}

export function DeliveryMonitorPanel() {
  const { data, error, loading, refresh } = usePolling<DeliveryMonitor>(
    () => api.getDeliveryMonitor(),
    POLL_MS,
  );

  const staleCount = data?.stale.length ?? 0;
  const status: 'ok' | 'stale' | 'unconfirmed' = !data
    ? 'ok'
    : staleCount > 0
      ? 'stale'
      : !data.everConfirmed
        ? 'unconfirmed'
        : 'ok';

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2.5">
            <Truck size={20} className="text-brand-400" />
            <h1 className="text-lg font-bold text-zinc-100">Saúde da Entrega</h1>
          </div>
          <button
            type="button"
            onClick={() => refresh()}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-5 max-w-2xl">
          Acompanha quanto tempo o Salesbot do Kommo leva pra entregar a resposta da IA depois
          que gravamos no campo "Resposta IA". Atualiza a cada {POLL_MS / 1000}s.
        </p>

        {error && (
          <div className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            Falha ao carregar: {error.message}
          </div>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center py-20 text-zinc-500 text-sm">
            <Loader2 className="animate-spin mr-2" size={16} />
            Carregando…
          </div>
        ) : data ? (
          <>
            {/* Status + KPIs */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-6">
              <StatusCard status={status} staleCount={staleCount} />
              <Kpi
                label="Pendentes agora"
                value={String(data.pendingCount)}
                hint="aguardando entrega"
              />
              <Kpi
                label="Latência média"
                value={data.avgLatencyMs == null ? '—' : fmtLatency(data.avgLatencyMs)}
                hint={`últimas ${data.recent.length} entregas`}
              />
              <Kpi
                label="Entregas lentas"
                value={String(data.slowCount)}
                hint={`acima de ${data.thresholdMin}min`}
                tone={data.slowCount > 0 ? 'warning' : 'ok'}
              />
            </div>

            {/* Parados agora */}
            <section className="mb-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Parados agora
              </h2>
              {staleCount === 0 ? (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-xs text-zinc-500 flex items-center gap-2">
                  <CheckCircle2 size={14} className="text-emerald-400" />
                  Nenhuma resposta parada — tudo sendo entregue dentro do prazo.
                </div>
              ) : (
                <ul className="space-y-2">
                  {data.stale.map((s, i) => (
                    <li
                      key={`${s.unitId}-${s.leadId}-${i}`}
                      className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 flex items-center gap-3"
                    >
                      <Turtle size={16} className="text-rose-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-rose-200">
                          Parada há <span className="font-bold">{s.ageMin}min</span> sem entrega
                        </div>
                        <div className="text-[10px] text-zinc-400 mt-0.5">
                          {s.unitName} · lead {s.leadId} — Salesbot travado, empurre com{' '}
                          <span className="font-mono">/Agente DT</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Salvaguarda: nunca confirmou nenhuma entrega */}
            {!data.everConfirmed && (
              <div className="mb-6 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>
                  Nenhuma entrega confirmada ainda. Se isso persistir com tráfego, verifique se o
                  webhook do Kommo está mandando mensagens <strong>OUTGOING</strong> pro backend —
                  sem isso o monitor não consegue medir a entrega (e não emite alerta de parada).
                </span>
              </div>
            )}

            {/* Histórico recente */}
            <section>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Últimas entregas confirmadas
              </h2>
              {data.recent.length === 0 ? (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-xs text-zinc-500">
                  Ainda sem entregas confirmadas neste boot do servidor.
                </div>
              ) : (
                <div className="rounded-md border border-zinc-800 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                        <th className="text-left font-medium px-3 py-2">Unidade</th>
                        <th className="text-left font-medium px-3 py-2">Lead</th>
                        <th className="text-right font-medium px-3 py-2">Latência</th>
                        <th className="text-right font-medium px-3 py-2">Quando</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {data.recent.map((r, i) => (
                        <tr key={`${r.leadId}-${i}`} className="hover:bg-zinc-900/50">
                          <td className="px-3 py-2 text-zinc-300">{r.unitSlug}</td>
                          <td className="px-3 py-2 text-zinc-400 font-mono text-xs">{r.leadId}</td>
                          <td className="px-3 py-2 text-right">
                            <span
                              className={clsx(
                                'inline-flex items-center gap-1 font-medium',
                                r.slow ? 'text-rose-400' : 'text-emerald-400',
                              )}
                            >
                              {r.slow && <Turtle size={12} />}
                              {fmtLatency(r.latencyMs)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-500 text-xs">
                            {fmtAge(r.ageSec)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function StatusCard({
  status,
  staleCount,
}: {
  status: 'ok' | 'stale' | 'unconfirmed';
  staleCount: number;
}) {
  const cfg = {
    ok: { dot: 'bg-emerald-400', label: 'OK', sub: 'entregando normal', text: 'text-emerald-300' },
    stale: {
      dot: 'bg-rose-500 animate-pulse',
      label: `${staleCount} parada${staleCount === 1 ? '' : 's'}`,
      sub: 'Salesbot travado',
      text: 'text-rose-300',
    },
    unconfirmed: {
      dot: 'bg-amber-400',
      label: 'sem confirmação',
      sub: 'aguardando 1ª entrega',
      text: 'text-amber-300',
    },
  }[status];

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Status</div>
      <div className="flex items-center gap-2">
        <span className={clsx('w-2.5 h-2.5 rounded-full shrink-0', cfg.dot)} />
        <span className={clsx('text-sm font-semibold', cfg.text)}>{cfg.label}</span>
      </div>
      <div className="text-[10px] text-zinc-500 mt-1">{cfg.sub}</div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'neutral' | 'ok' | 'warning';
}) {
  const valueTone =
    tone === 'warning' ? 'text-amber-300' : tone === 'ok' ? 'text-zinc-100' : 'text-zinc-100';
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">{label}</div>
      <div className={clsx('text-xl font-bold', valueTone)}>{value}</div>
      <div className="text-[10px] text-zinc-500 mt-1">{hint}</div>
    </div>
  );
}
