// ============================================================================
// WhatsappCostsPanel — Painel dedicado de custo WhatsApp (Meta Graph API).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Lê /api/units/:id/whatsapp-costs e /api/units/:id/whatsapp-templates,
// renderiza:
//   - 3 KPIs (mês, últimos 7 dias, hoje)
//   - Status do orçamento mensal Meta
//   - Timeline diária (barras simples, sem dep nova de chart)
//   - Breakdown por categoria (MARKETING/UTILITY/AUTHENTICATION/SERVICE)
//   - Breakdown por tipo (REGULAR / FREE_*)
//   - Top países
//   - Ranking de templates (funil sent → delivered → read → clicked)
//   - Botões: Sincronizar agora · Exportar CSV/PDF
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Loader2,
  MessageCircle,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import type {
  WhatsappCostsResponse,
  WhatsappTemplatesResponse,
} from '../types/api';

const fmtUsd = (n: unknown): string => {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v === 0) return '$0,00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
};
const fmtN = (n: unknown): string => Number(n ?? 0).toLocaleString('pt-BR');
const fmtPct = (n: unknown, dec = 1): string => `${Number(n ?? 0).toFixed(dec)}%`;

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function WhatsappCostsPanel() {
  const { units, selectedUnitId } = useUnit();
  const toast = useToast();
  const targetUnitId = selectedUnitId ?? units[0]?.id ?? null;

  const [from, setFrom] = useState<string>(isoDaysAgo(30));
  const [to, setTo] = useState<string>(isoToday());
  const [costs, setCosts] = useState<WhatsappCostsResponse | null>(null);
  const [templates, setTemplates] = useState<WhatsappTemplatesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<string[] | null>(null);

  async function load() {
    if (!targetUnitId) {
      setCosts(null);
      setTemplates(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [c, t] = await Promise.all([
        api.getWhatsappCosts(targetUnitId, { from, to }),
        api.getWhatsappTemplates(targetUnitId, { from, to }),
      ]);
      setCosts(c);
      setTemplates(t);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
      setError(e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'erro');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUnitId, from, to]);

  async function handleSync() {
    if (!targetUnitId) return;
    setSyncing(true);
    setSyncErrors(null);
    try {
      const r = await api.syncWhatsappCosts(targetUnitId, { lookbackDays: 7 });
      if (r.ok) {
        toast.success(
          `Sync OK: ${r.pricingRowsUpserted} linhas de custo + ${r.templateRowsUpserted} de template`,
        );
        setSyncErrors(null);
      } else {
        toast.error('Sync com erros — veja detalhes abaixo');
        setSyncErrors(r.errors);
      }
      await load();
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      const msg = e?.response?.data?.message ?? e?.message ?? 'falha no sync';
      toast.error(msg);
      setSyncErrors([msg]);
    } finally {
      setSyncing(false);
    }
  }

  async function handleExport(format: 'csv' | 'pdf') {
    if (!targetUnitId) return;
    try {
      await api.downloadReport('whatsapp-cost', format, { unitId: targetUnitId, from, to });
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message ?? 'falha ao baixar relatório');
    }
  }

  const maxTimelineCost = useMemo(() => {
    if (!costs || costs.timeline.length === 0) return 0;
    return Math.max(...costs.timeline.map((t) => t.costUsd));
  }, [costs]);

  const maxCategoryCost = useMemo(() => {
    if (!costs || costs.byCategory.length === 0) return 0;
    return Math.max(...costs.byCategory.map((c) => c.costUsd));
  }, [costs]);

  if (!targetUnitId) {
    return (
      <div className="flex-1 grid place-items-center text-zinc-500 text-sm">
        <div className="flex flex-col items-center gap-2">
          <MessageCircle size={32} />
          <span>Selecione uma unidade para ver os custos do WhatsApp.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Custo WhatsApp (Meta)</h2>
            <p className="text-xs text-zinc-500">
              {costs
                ? <>Unidade: <strong className="text-zinc-300">{costs.unit.name}</strong>{' '}
                    {costs.unit.wabaId
                      ? <>· WABA: <code className="text-zinc-400">{costs.unit.wabaId}</code></>
                      : <span className="text-amber-400">· WABA não configurada</span>}
                  </>
                : 'Carregando...'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-zinc-500 flex items-center gap-1">
              De
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="bg-zinc-900/60 ring-1 ring-zinc-800 rounded px-2 py-1 text-zinc-300 text-xs"
              />
            </label>
            <label className="text-xs text-zinc-500 flex items-center gap-1">
              Até
              <input
                type="date"
                value={to}
                min={from}
                max={isoToday()}
                onChange={(e) => setTo(e.target.value)}
                className="bg-zinc-900/60 ring-1 ring-zinc-800 rounded px-2 py-1 text-zinc-300 text-xs"
              />
            </label>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1 bg-zinc-900/60 ring-1 ring-zinc-800 text-zinc-300 hover:bg-zinc-800/80 disabled:opacity-50"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Atualizar
            </button>
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={syncing || !costs?.unit.wabaId}
              title={!costs?.unit.wabaId ? 'Configure o WABA ID na unidade' : 'Sincronizar agora com a Graph API'}
              className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1 bg-emerald-600/30 ring-1 ring-emerald-500/40 text-emerald-200 hover:bg-emerald-600/40 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Sincronizar
            </button>
            <button
              type="button"
              onClick={() => void handleExport('csv')}
              className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1 bg-zinc-900/60 ring-1 ring-zinc-800 text-zinc-300 hover:bg-zinc-800/80"
            >
              <Download size={12} /> CSV
            </button>
            <button
              type="button"
              onClick={() => void handleExport('pdf')}
              className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1 bg-zinc-900/60 ring-1 ring-zinc-800 text-zinc-300 hover:bg-zinc-800/80"
            >
              <Download size={12} /> PDF
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-rose-500/10 ring-1 ring-rose-500/30 px-4 py-3 text-sm text-rose-300">
            Falha ao carregar: {error}
          </div>
        )}

        {syncErrors && syncErrors.length > 0 && (
          <div className="mb-4 rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30 px-4 py-3 text-xs">
            <div className="flex items-center justify-between mb-2">
              <div className="text-amber-300 font-semibold">
                Erros do último sync ({syncErrors.length})
              </div>
              <button
                type="button"
                onClick={() => setSyncErrors(null)}
                className="text-[10px] text-amber-300/70 hover:text-amber-200"
              >
                fechar
              </button>
            </div>
            <ul className="space-y-1 text-amber-100/90 font-mono break-all">
              {syncErrors.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-amber-300/60 shrink-0">•</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
            <div className="text-[10px] text-amber-300/60 mt-2 font-normal">
              Cole o <code className="text-amber-200">[trace ...]</code> em developer support da Meta se precisar abrir ticket.
            </div>
          </div>
        )}

        {loading && !costs && (
          <div className="grid place-items-center py-20 text-zinc-500">
            <Loader2 className="animate-spin" size={20} />
          </div>
        )}

        {costs && (
          <div className="space-y-5">
            {/* KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <KpiCard
                label="No período"
                primary={fmtUsd(costs.totals.costUsd)}
                secondary={`${fmtN(costs.totals.volume)} mensagens`}
              />
              <KpiCard
                label="Mês corrente"
                primary={fmtUsd(costs.budget.spentUsd)}
                secondary={
                  costs.budget.monthlyUsd > 0
                    ? `${fmtPct(costs.budget.pctUsed)} do orçamento`
                    : 'Sem orçamento definido'
                }
              />
              <KpiCard
                label="Projeção do mês"
                primary={fmtUsd(costs.budget.projectedMonthUsd)}
                secondary={`em ${costs.budget.daysIntoMonth}º dia do mês`}
              />
              <KpiCard
                label="Último sync"
                primary={
                  costs.lastSyncedAt
                    ? new Date(costs.lastSyncedAt).toLocaleString('pt-BR')
                    : '—'
                }
                secondary={costs.unit.wabaId ? 'WABA ok' : 'WABA pendente'}
              />
            </div>

            {/* Orçamento */}
            {costs.budget.monthlyUsd > 0 && (
              <BudgetBar budget={costs.budget} />
            )}

            {/* Timeline */}
            <section className="rounded-xl bg-zinc-900/40 ring-1 ring-zinc-800/60 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-zinc-100">Custo por dia</h3>
                <span className="text-[11px] text-zinc-500">
                  {costs.range.from} → {costs.range.to}
                </span>
              </div>
              {costs.timeline.length === 0 ? (
                <EmptyHint />
              ) : (
                <div className="space-y-1.5">
                  {costs.timeline.map((t) => {
                    const pct = maxTimelineCost > 0 ? (t.costUsd / maxTimelineCost) * 100 : 0;
                    return (
                      <div key={t.date} className="flex items-center gap-2 text-[11px]">
                        <span className="text-zinc-500 w-20 shrink-0 font-mono">{t.date}</span>
                        <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
                          <div className="h-full bg-emerald-500/60" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-zinc-300 font-mono w-20 text-right">{fmtUsd(t.costUsd)}</span>
                        <span className="text-zinc-500 w-16 text-right">{fmtN(t.volume)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Por categoria + Por tipo */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <BreakdownCard
                title="Por categoria de cobrança"
                rows={costs.byCategory.map((c) => ({
                  label: c.pricingCategory,
                  volume: c.volume,
                  costUsd: c.costUsd,
                }))}
                maxCost={maxCategoryCost}
                empty="Nenhum dado de categoria"
              />
              <BreakdownCard
                title="Por tipo de mensagem"
                rows={costs.byType.map((c) => ({
                  label: c.pricingType,
                  volume: c.volume,
                  costUsd: c.costUsd,
                }))}
                maxCost={Math.max(...costs.byType.map((c) => c.costUsd), 0)}
                empty="Nenhum dado de tipo"
              />
            </div>

            {/* Países */}
            {costs.byCountry.length > 0 && (
              <BreakdownCard
                title="Top países"
                rows={costs.byCountry.map((c) => ({
                  label: c.country || '(agregado)',
                  volume: c.volume,
                  costUsd: c.costUsd,
                }))}
                maxCost={Math.max(...costs.byCountry.map((c) => c.costUsd), 0)}
                empty="Sem dados de país"
              />
            )}

            {/* Templates */}
            {templates && (
              <section className="rounded-xl bg-zinc-900/40 ring-1 ring-zinc-800/60 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-zinc-100">Templates</h3>
                  <span className="text-[11px] text-zinc-500">
                    {fmtN(templates.totals.sent)} enviadas · {fmtUsd(templates.totals.costUsd)}
                  </span>
                </div>
                {templates.templates.length === 0 ? (
                  <EmptyHint />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800/80">
                          <th className="text-left py-2 pr-2">Template</th>
                          <th className="text-right py-2 px-2">Enviadas</th>
                          <th className="text-right py-2 px-2">Entregues</th>
                          <th className="text-right py-2 px-2">Lidas</th>
                          <th className="text-right py-2 px-2">Clicadas</th>
                          <th className="text-right py-2 px-2">Entrega</th>
                          <th className="text-right py-2 px-2">Leitura</th>
                          <th className="text-right py-2 px-2">Clique</th>
                          <th className="text-right py-2 pl-2">Custo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {templates.templates.map((t) => (
                          <tr key={`${t.templateId}-${t.language}`} className="border-b border-zinc-800/40">
                            <td className="py-2 pr-2">
                              <div className="text-zinc-200">{t.templateName ?? <span className="font-mono">{t.templateId}</span>}</div>
                              {t.language && <div className="text-[10px] text-zinc-500">{t.language}</div>}
                            </td>
                            <td className="py-2 px-2 text-right text-zinc-300 font-mono">{fmtN(t.sent)}</td>
                            <td className="py-2 px-2 text-right text-zinc-400 font-mono">{fmtN(t.delivered)}</td>
                            <td className="py-2 px-2 text-right text-zinc-400 font-mono">{fmtN(t.read)}</td>
                            <td className="py-2 px-2 text-right text-zinc-400 font-mono">{fmtN(t.clicked)}</td>
                            <td className="py-2 px-2 text-right text-emerald-300 font-mono">{fmtPct(t.deliveryRate)}</td>
                            <td className="py-2 px-2 text-right text-emerald-300 font-mono">{fmtPct(t.readRate)}</td>
                            <td className="py-2 px-2 text-right text-emerald-300 font-mono">{fmtPct(t.clickRate)}</td>
                            <td className="py-2 pl-2 text-right text-zinc-300 font-mono">{fmtUsd(t.costUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function KpiCard({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className="rounded-xl bg-zinc-900/40 ring-1 ring-zinc-800/60 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100 mt-1">{primary}</div>
      <div className="text-[11px] text-zinc-500 mt-1">{secondary}</div>
    </div>
  );
}

function BudgetBar({
  budget,
}: {
  budget: WhatsappCostsResponse['budget'];
}) {
  const tone = (() => {
    switch (budget.alert) {
      case 'over':
        return { bg: 'bg-rose-500/15', text: 'text-rose-300', bar: 'bg-rose-500', icon: 'text-rose-300' };
      case 'danger':
        return { bg: 'bg-rose-500/10', text: 'text-rose-300', bar: 'bg-rose-500/80', icon: 'text-rose-300' };
      case 'warning':
        return { bg: 'bg-amber-500/10', text: 'text-amber-300', bar: 'bg-amber-500', icon: 'text-amber-300' };
      default:
        return { bg: 'bg-emerald-500/10', text: 'text-emerald-300', bar: 'bg-emerald-500/80', icon: 'text-emerald-300' };
    }
  })();
  const pct = Math.min(100, budget.pctUsed);
  return (
    <section className={clsx('rounded-xl px-5 py-4 ring-1 ring-zinc-800/60', tone.bg)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {budget.alert === 'ok' ? (
            <Wallet size={16} className={tone.icon} />
          ) : (
            <AlertTriangle size={16} className={tone.icon} />
          )}
          <div className="text-sm font-semibold text-zinc-100">Orçamento mensal Meta</div>
        </div>
        <div className={clsx('text-xs font-mono', tone.text)}>
          {fmtUsd(budget.spentUsd)} / {fmtUsd(budget.monthlyUsd)} · {fmtPct(budget.pctUsed)}
        </div>
      </div>
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div className={clsx('h-full', tone.bar)} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[11px] text-zinc-500 mt-2">
        Restante: {fmtUsd(budget.remainingUsd)} · Projeção mensal: {fmtUsd(budget.projectedMonthUsd)}
      </div>
    </section>
  );
}

function BreakdownCard({
  title,
  rows,
  maxCost,
  empty,
}: {
  title: string;
  rows: Array<{ label: string; volume: number; costUsd: number }>;
  maxCost: number;
  empty: string;
}) {
  return (
    <section className="rounded-xl bg-zinc-900/40 ring-1 ring-zinc-800/60 p-5">
      <h3 className="text-sm font-semibold text-zinc-100 mb-3">{title}</h3>
      {rows.length === 0 ? (
        <div className="text-xs text-zinc-500">{empty}</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => {
            const pct = maxCost > 0 ? (r.costUsd / maxCost) * 100 : 0;
            return (
              <div key={r.label} className="flex items-center gap-2 text-[11px]">
                <span className="text-zinc-300 w-32 shrink-0 truncate" title={r.label}>{r.label}</span>
                <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-emerald-500/60" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-zinc-300 font-mono w-20 text-right">{fmtUsd(r.costUsd)}</span>
                <span className="text-zinc-500 w-16 text-right">{fmtN(r.volume)}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EmptyHint() {
  return (
    <div className="text-xs text-zinc-500 py-3 text-center">
      Sem dados no período. Configure o WABA ID e clique em <span className="text-zinc-300">Sincronizar</span>.
    </div>
  );
}
