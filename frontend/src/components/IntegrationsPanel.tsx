// ============================================================================
// IntegrationsPanel — Central de Integrações (visão pra leigo).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cards por provider com:
//   - status visual (verde/amarelo/vermelho)
//   - métricas em destaque
//   - mensagem em linguagem clara ("falta X", "tudo certo", "perto do limite")
//
// COMPARATIVO OPENAI
// ------------------
// Quando a Admin Key está cadastrada, mostramos LADO A LADO:
//   "Sua conta ChatGPT" (gasto real reportado pela OpenAI)  vs
//   "Pelo agente"      (o que a nossa plataforma gerou)
//
// O delta entre os dois é exatamente o quanto a Unit gasta em OUTRAS
// integrações que usam a mesma chave (ex: testes manuais, ByteGPT).
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Cable,
  CheckCircle2,
  Cpu,
  DollarSign,
  Gauge,
  Key,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Wallet,
  XCircle,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type {
  CardStatus,
  IntegrationsResponse,
  KommoIntegrationCard,
  MetaIntegrationCard,
  OpenAIIntegrationCard,
} from '../types/api';

// Coerção defensiva — Prisma Decimal vira string em alguns paths, e a OpenAI
// API às vezes devolve campos numéricos faltando. `safeNum` normaliza tudo.
const safeNum = (n: unknown, fallback = 0): number => {
  if (n === null || n === undefined) return fallback;
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : fallback;
};

const fmtUsd = (raw: unknown): string => {
  const n = safeNum(raw);
  if (n === 0) return '$0,00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
};

const fmtN = (raw: unknown): string => safeNum(raw).toLocaleString('pt-BR');

const fmtPct = (raw: unknown, decimals = 1): string => `${safeNum(raw).toFixed(decimals)}%`;

const statusColor = (s: CardStatus): { ring: string; text: string; bg: string; chip: string; label: string } => {
  switch (s) {
    case 'ok':
      return { ring: 'ring-emerald-500/30', text: 'text-emerald-300', bg: 'bg-emerald-500/10', chip: 'bg-emerald-500/15 text-emerald-300', label: 'Funcionando' };
    case 'warning':
      return { ring: 'ring-amber-500/30', text: 'text-amber-300', bg: 'bg-amber-500/10', chip: 'bg-amber-500/15 text-amber-300', label: 'Atenção' };
    case 'danger':
      return { ring: 'ring-rose-500/30', text: 'text-rose-300', bg: 'bg-rose-500/10', chip: 'bg-rose-500/15 text-rose-300', label: 'Ação necessária' };
    case 'idle':
    default:
      return { ring: 'ring-zinc-700', text: 'text-zinc-400', bg: 'bg-zinc-800/30', chip: 'bg-zinc-800/60 text-zinc-400', label: 'Não configurado' };
  }
};

export function IntegrationsPanel() {
  const { selectedUnitId, units } = useUnit();
  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Se não houver unit selecionada, escolhe a primeira pra mostrar algo.
  const targetUnitId = selectedUnitId ?? units[0]?.id ?? null;

  const load = useMemo(
    () => async () => {
      if (!targetUnitId) {
        setData(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await api.getIntegrations(targetUnitId, 30);
        setData(res);
      } catch (err) {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        setError(e?.response?.data?.error ?? e?.message ?? 'erro');
      } finally {
        setLoading(false);
      }
    },
    [targetUnitId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!targetUnitId) {
    return (
      <div className="flex-1 grid place-items-center text-zinc-500 text-sm">
        <div className="flex flex-col items-center gap-2">
          <Cable size={32} />
          <span>Crie uma unidade primeiro pra ver as integrações.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Central de Integrações</h2>
            <p className="text-xs text-zinc-500">
              {data ? `Unidade: ${data.unit.name} · atualizado ${new Date(data.generatedAt).toLocaleTimeString('pt-BR')}` : 'Carregando...'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1 bg-zinc-900/60 ring-1 ring-zinc-800 text-zinc-300 hover:bg-zinc-800/80 disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Atualizar
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-rose-500/10 ring-1 ring-rose-500/30 px-4 py-3 text-sm text-rose-300">
            Falha ao carregar integrações: {error}
          </div>
        )}

        {loading && !data && (
          <div className="grid place-items-center py-20 text-zinc-500">
            <Loader2 className="animate-spin" size={20} />
          </div>
        )}

        {data && (
          <div className="space-y-5">
            {/* Resumo no topo (alertas) */}
            {data.alerts.length > 0 && <AlertsBanner alerts={data.alerts} />}

            {/* OpenAI — o card mais importante */}
            <OpenAICardView card={data.openai} unitId={data.unit.id} />

            {/* Linha com Kommo + Meta */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <KommoCardView card={data.kommo} />
              <MetaCardView card={data.meta} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Banner de alertas no topo
// ---------------------------------------------------------------------------

function AlertsBanner({ alerts }: { alerts: IntegrationsResponse['alerts'] }) {
  const danger = alerts.filter((a) => a.severity === 'danger');
  const warning = alerts.filter((a) => a.severity === 'warning');
  const info = alerts.filter((a) => a.severity === 'info');
  return (
    <div className="space-y-2">
      {danger.map((a, i) => (
        <AlertLine key={`d${i}`} severity="danger" message={a.message} integration={a.integration} />
      ))}
      {warning.map((a, i) => (
        <AlertLine key={`w${i}`} severity="warning" message={a.message} integration={a.integration} />
      ))}
      {info.map((a, i) => (
        <AlertLine key={`i${i}`} severity="info" message={a.message} integration={a.integration} />
      ))}
    </div>
  );
}

function AlertLine({
  severity,
  message,
  integration,
}: {
  severity: 'info' | 'warning' | 'danger';
  message: string;
  integration: string;
}) {
  const colors =
    severity === 'danger'
      ? 'bg-rose-500/10 ring-rose-500/30 text-rose-200'
      : severity === 'warning'
        ? 'bg-amber-500/10 ring-amber-500/30 text-amber-200'
        : 'bg-sky-500/10 ring-sky-500/30 text-sky-200';
  const Icon = severity === 'info' ? CheckCircle2 : severity === 'warning' ? AlertTriangle : ShieldAlert;
  return (
    <div className={clsx('rounded-md ring-1 px-3 py-2 text-xs flex items-center gap-2', colors)}>
      <Icon size={14} />
      <span className="uppercase tracking-wider text-[10px] font-semibold opacity-70">{integration}</span>
      <span className="opacity-50">·</span>
      <span>{message}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CARD: OpenAI
// ---------------------------------------------------------------------------

function OpenAICardView({ card, unitId }: { card: OpenAIIntegrationCard; unitId: string }) {
  const sc = statusColor(card.status);

  return (
    <section className={clsx('rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden', sc.ring, 'ring-1')}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center gap-3">
        <div className={clsx('rounded-lg p-2.5', sc.bg)}>
          <Bot size={20} className={sc.text} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            OpenAI <span className={clsx('text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider', sc.chip)}>{sc.label}</span>
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Modelo padrão: <span className="text-zinc-300">{card.model}</span>
            {card.assistantId && (
              <>
                {' · '}Assistant: <span className="text-zinc-300 font-mono">{card.assistantId.slice(0, 14)}…</span>
              </>
            )}
          </p>
        </div>
        <KeysBadges card={card} />
      </div>

      {/* Comparativo (foco do painel) */}
      <div className="px-5 py-4 grid grid-cols-1 lg:grid-cols-2 gap-4 bg-zinc-950/30">
        <CostPanel
          title="Sua conta ChatGPT (real)"
          subtitle={card.platform ? 'Dados reportados pela própria OpenAI' : 'Cadastre uma Admin Key pra ver os números reais'}
          icon={Wallet}
          tone={card.platform ? 'platform' : 'idle'}
          spend={safeNum(card.platform?.totalCostUsd)}
          today={safeNum(card.platform?.todayCostUsd)}
          last7={safeNum(card.platform?.last7DaysCostUsd)}
          tokens={safeNum(card.platform?.totalTokens)}
          requests={safeNum(card.platform?.numRequests)}
          available={!!card.platform}
        />
        <CostPanel
          title="Pelo agente (medido)"
          subtitle="Tudo que passou pela nossa plataforma — sempre disponível"
          icon={Cpu}
          tone="measured"
          spend={safeNum(card.measured.totalCostUsd)}
          today={safeNum(card.measured.todayCostUsd)}
          last7={safeNum(card.measured.last7DaysCostUsd)}
          tokens={safeNum(card.measured.totalTokens)}
          requests={safeNum(card.measured.numCalls)}
          available
        />
      </div>

      {card.agentShare && (
        <div className="px-5 py-3 bg-zinc-950/40 border-t border-zinc-800/60 text-[11px] text-zinc-400 flex items-center gap-3">
          <TrendingUp size={12} className="text-brand-400" />
          <span>
            <span className="font-semibold text-zinc-200">{fmtPct(card.agentShare.percentOfCost)}</span> do gasto da sua conta
            ChatGPT vem deste agente. ({fmtPct(card.agentShare.percentOfRequests)} das requisições.)
          </span>
        </div>
      )}

      {/* Orçamento */}
      <BudgetBlock card={card} />

      {/* Breakdown por modelo */}
      <ModelBreakdown card={card} />

      {/* Linha do tempo (sparkline simples) */}
      <Timeline card={card} />

      {/* Diagnóstico da Admin Key — útil quando "platform" está vazio. */}
      {card.adminKey.configured && (!card.platform || !card.adminKey.usable) && (
        <AdminKeyDebug unitId={unitId} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Diagnóstico cru do Admin Key.
// Aparece quando a key está cadastrada mas não traz dados. Chama o
// endpoint /openai-debug que devolve status HTTP + corpo bruto da OpenAI.
// ---------------------------------------------------------------------------

function AdminKeyDebug({ unitId }: { unitId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.openaiDebug>> | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    try {
      const r = await api.openaiDebug(unitId);
      setData(r);
      setOpen(true);
    } catch (e) {
      const m = (e as { message?: string })?.message ?? 'erro';
      setErr(m);
    } finally {
      setRunning(false);
    }
  }

  const sevColor =
    data?.diagnosis?.severity === 'danger'
      ? 'bg-rose-500/10 ring-rose-500/30 text-rose-200'
      : data?.diagnosis?.severity === 'warning'
        ? 'bg-amber-500/10 ring-amber-500/30 text-amber-200'
        : 'bg-emerald-500/10 ring-emerald-500/30 text-emerald-200';

  return (
    <div className="px-5 py-4 border-t border-zinc-800/60 bg-zinc-950/30 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} className="text-amber-400" />
        <span className="text-xs text-zinc-200 font-semibold">Diagnosticar Admin Key</span>
        <span className="text-[10px] text-zinc-500">
          A Admin Key está cadastrada mas a OpenAI não está devolvendo dados — rode pra descobrir o motivo.
        </span>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="ml-auto text-xs px-2 py-1 rounded ring-1 ring-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 inline-flex items-center gap-1 disabled:opacity-50"
        >
          {running ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
          Rodar diagnóstico
        </button>
      </div>

      {err && (
        <div className="rounded ring-1 ring-rose-500/30 bg-rose-500/10 text-rose-200 text-xs px-3 py-2">
          Falha no debug: {err}
        </div>
      )}

      {open && data && (
        <div className="space-y-3">
          {data.diagnosis && (
            <div className={clsx('rounded-md ring-1 px-3 py-2 text-xs', sevColor)}>
              <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
                {data.diagnosis.severity === 'danger' ? 'Problema detectado' : data.diagnosis.severity === 'warning' ? 'Atenção' : 'OK'}
              </div>
              {data.diagnosis.conclusion}
            </div>
          )}
          {data.message && (
            <div className="rounded-md ring-1 ring-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
              {data.message}
            </div>
          )}
          {data.calls && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {(['costs', 'usage', 'projects'] as const).map((k) => {
                const c = data.calls![k];
                const okTone =
                  c.status === null
                    ? 'ring-zinc-700 text-zinc-400'
                    : c.status >= 200 && c.status < 300
                      ? 'ring-emerald-500/30 text-emerald-300'
                      : 'ring-rose-500/30 text-rose-300';
                return (
                  <details key={k} className={clsx('rounded ring-1 bg-zinc-950/60', okTone)}>
                    <summary className="cursor-pointer text-[11px] px-3 py-2 font-mono">
                      {c.path} → {c.status ?? 'erro'}
                    </summary>
                    <pre className="text-[10px] text-zinc-400 px-3 pb-3 whitespace-pre-wrap max-h-72 overflow-auto">
                      {c.error ? `error: ${c.error}` : JSON.stringify(c.body, null, 2)}
                    </pre>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KeysBadges({ card }: { card: OpenAIIntegrationCard }) {
  const apiOk = card.apiKey.reachable;
  const adminOk = card.adminKey.usable;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <KeyBadge label="API Key" ok={apiOk} configured={card.apiKey.configured} />
      <KeyBadge label="Admin Key" ok={adminOk} configured={card.adminKey.configured} />
    </div>
  );
}

function KeyBadge({ label, ok, configured }: { label: string; ok: boolean | null; configured: boolean }) {
  const tone = !configured
    ? 'bg-zinc-800/60 text-zinc-500 ring-zinc-700'
    : ok
      ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
      : 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-1 rounded ring-1', tone)}>
      <Key size={10} />
      {label}: {!configured ? 'falta' : ok ? 'ok' : 'erro'}
    </span>
  );
}

function CostPanel({
  title,
  subtitle,
  icon: Icon,
  tone,
  spend,
  today,
  last7,
  tokens,
  requests,
  available,
}: {
  title: string;
  subtitle: string;
  icon: typeof Bot;
  tone: 'platform' | 'measured' | 'idle';
  spend: number;
  today: number;
  last7: number;
  tokens: number;
  requests: number;
  available: boolean;
}) {
  const accent =
    tone === 'platform' ? 'from-emerald-500/20 to-emerald-500/0 ring-emerald-500/30 text-emerald-300'
    : tone === 'measured' ? 'from-brand-500/20 to-brand-500/0 ring-brand-500/30 text-brand-300'
    : 'from-zinc-800/30 to-zinc-800/0 ring-zinc-800 text-zinc-500';
  return (
    <div className={clsx('rounded-lg ring-1 p-4 bg-gradient-to-br', accent)}>
      <div className="flex items-center gap-2 mb-3">
        <Icon size={14} />
        <h4 className="text-xs font-semibold text-zinc-100">{title}</h4>
      </div>
      <p className="text-[11px] text-zinc-400 mb-3 min-h-[28px]">{subtitle}</p>

      {!available ? (
        <div className="text-[11px] text-zinc-600 italic">Indisponível sem Admin Key</div>
      ) : (
        <>
          <div className="text-3xl font-bold text-zinc-100">{fmtUsd(spend)}</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">total nos últimos 30 dias</div>
          <div className="grid grid-cols-3 gap-2 mt-4 text-[11px]">
            <Stat label="Hoje" value={fmtUsd(today)} />
            <Stat label="7 dias" value={fmtUsd(last7)} />
            <Stat label="Tokens" value={fmtN(tokens)} />
          </div>
          <div className="mt-2 text-[10px] text-zinc-500 text-right">{fmtN(requests)} requisições</div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-zinc-950/60 px-2 py-1.5 ring-1 ring-zinc-800/80">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-zinc-200 font-semibold truncate">{value}</div>
    </div>
  );
}

function BudgetBlock({ card }: { card: OpenAIIntegrationCard }) {
  const b = card.budget;
  const pctUsed = safeNum(b.pctUsed);
  const monthlyUsd = safeNum(b.monthlyUsd);
  const spentUsd = safeNum(b.spentUsd);
  const remainingUsd = safeNum(b.remainingUsd);
  const projectedMonthUsd = safeNum(b.projectedMonthUsd);
  const pct = Math.min(100, pctUsed);
  const fillColor =
    b.alert === 'over' || b.alert === 'danger' ? 'bg-rose-500'
    : b.alert === 'warning' ? 'bg-amber-500'
    : 'bg-emerald-500';

  return (
    <div className="px-5 py-4 border-t border-zinc-800/80">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-zinc-200 inline-flex items-center gap-1.5">
          <Gauge size={13} />
          Orçamento mensal
          <span className="text-[10px] font-normal text-zinc-500">
            (fonte: {b.spentSource === 'platform' ? 'OpenAI real' : 'medido por nós'})
          </span>
        </h4>
        <span
          className={clsx(
            'text-[11px] px-2 py-0.5 rounded font-semibold',
            b.alert === 'over' ? 'bg-rose-500/20 text-rose-300'
            : b.alert === 'danger' ? 'bg-rose-500/15 text-rose-300'
            : b.alert === 'warning' ? 'bg-amber-500/15 text-amber-300'
            : 'bg-emerald-500/15 text-emerald-300',
          )}
        >
          {fmtPct(pctUsed)}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-zinc-800/60 overflow-hidden ring-1 ring-zinc-800">
        <div
          className={clsx('h-full transition-all', fillColor)}
          style={{ width: `${pct}%` }}
        />
        {/* Marcadores 70%, 90% */}
        <div className="absolute top-0 left-[70%] w-px h-full bg-amber-500/40" />
        <div className="absolute top-0 left-[90%] w-px h-full bg-rose-500/40" />
      </div>
      <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
        <Stat label="Gasto no mês" value={fmtUsd(spentUsd)} />
        <Stat label="Limite" value={fmtUsd(monthlyUsd)} />
        <Stat label="Restante" value={fmtUsd(remainingUsd)} />
        <Stat label="Projeção fim do mês" value={fmtUsd(projectedMonthUsd)} />
      </div>
      {b.alert === 'over' && (
        <div className="mt-2 text-xs text-rose-300 flex items-center gap-1.5">
          <ShieldAlert size={12} />
          Orçamento estourado — desative ou aumente o limite na aba Unidades.
        </div>
      )}
      {b.alert === 'danger' && (
        <div className="mt-2 text-xs text-rose-300 flex items-center gap-1.5">
          <ShieldAlert size={12} />
          Você passou de 90% do orçamento. Considere ajustar o limite ou pausar.
        </div>
      )}
      {b.alert === 'warning' && (
        <div className="mt-2 text-xs text-amber-300 flex items-center gap-1.5">
          <AlertTriangle size={12} />
          Mais de 70% do orçamento usado.
        </div>
      )}
    </div>
  );
}

function ModelBreakdown({ card }: { card: OpenAIIntegrationCard }) {
  // Prioriza dados da plataforma, cai pra measured.
  const platformRows = card.platform?.byModel ?? [];
  const measuredRows = card.measured.byModel;
  const useReal = platformRows.length > 0;

  const rows = useReal
    ? platformRows.map((p) => ({
        model: p.model,
        tokens: safeNum(p.inputTokens) + safeNum(p.outputTokens),
        requests: safeNum(p.numRequests),
        costUsd: safeNum(measuredRows.find((m) => m.model === p.model)?.costUsd),
      }))
    : measuredRows.map((m) => ({
        model: m.model,
        tokens: safeNum(m.totalTokens),
        requests: safeNum(m.calls),
        costUsd: safeNum(m.costUsd),
      }));

  if (rows.length === 0) {
    return (
      <div className="px-5 py-4 border-t border-zinc-800/80 text-xs text-zinc-500">
        Nenhuma chamada registrada nos últimos 30 dias.
      </div>
    );
  }

  const max = Math.max(...rows.map((r) => r.tokens));

  return (
    <div className="px-5 py-4 border-t border-zinc-800/80">
      <h4 className="text-xs font-semibold text-zinc-200 mb-3 inline-flex items-center gap-1.5">
        <Cpu size={13} />
        Por modelo {useReal && <span className="text-[10px] text-zinc-500 font-normal">(dados reais OpenAI)</span>}
      </h4>
      <div className="space-y-2">
        {rows.slice(0, 8).map((r) => (
          <div key={r.model}>
            <div className="flex items-center justify-between text-[11px] text-zinc-300 mb-1">
              <span className="font-mono">{r.model}</span>
              <span className="text-zinc-500">
                {fmtN(r.tokens)} tok · {fmtN(r.requests)} req {r.costUsd > 0 && `· ${fmtUsd(r.costUsd)}`}
              </span>
            </div>
            <div className="h-1.5 rounded bg-zinc-800/60 overflow-hidden">
              <div
                className="h-full bg-brand-500/60"
                style={{ width: max > 0 ? `${(r.tokens / max) * 100}%` : '0%' }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ card }: { card: OpenAIIntegrationCard }) {
  const platformTl = card.platform?.timeline ?? [];
  const measuredTl = card.measured.timeline;
  // Junta timelines pra exibir comparativo barra a barra.
  const dates = Array.from(
    new Set([...platformTl.map((p) => p.date), ...measuredTl.map((m) => m.date)]),
  ).sort();

  if (dates.length === 0) return null;

  const points = dates.map((date) => {
    const p = safeNum(platformTl.find((x) => x.date === date)?.costUsd);
    const m = safeNum(measuredTl.find((x) => x.date === date)?.costUsd);
    return { date, platform: p, measured: m };
  });
  const max = Math.max(0.001, ...points.map((p) => Math.max(p.platform, p.measured)));

  return (
    <div className="px-5 py-4 border-t border-zinc-800/80">
      <h4 className="text-xs font-semibold text-zinc-200 mb-3 inline-flex items-center gap-1.5">
        <DollarSign size={13} />
        Custo por dia
        <span className="text-[10px] text-zinc-500 font-normal">(últimos 30 dias)</span>
      </h4>
      <div className="flex items-end gap-1 h-32">
        {points.map((p) => (
          <div key={p.date} className="flex-1 flex flex-col items-center gap-0.5 min-w-0" title={p.date}>
            <div className="w-full flex items-end justify-center gap-px h-full">
              {card.platform && (
                <div
                  className="bg-emerald-500/70 w-1/2 rounded-t"
                  style={{ height: `${(p.platform / max) * 100}%` }}
                  title={`OpenAI real: ${fmtUsd(p.platform)}`}
                />
              )}
              <div
                className="bg-brand-500/70 w-1/2 rounded-t"
                style={{ height: `${(p.measured / max) * 100}%` }}
                title={`Medido: ${fmtUsd(p.measured)}`}
              />
            </div>
            <span className="text-[8px] text-zinc-600 truncate w-full text-center">
              {p.date.slice(5)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-zinc-500">
        {card.platform && (
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 bg-emerald-500/70 rounded-sm" /> Conta ChatGPT (real)
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 bg-brand-500/70 rounded-sm" /> Pelo agente (medido)
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CARD: Kommo
// ---------------------------------------------------------------------------

function KommoCardView({ card }: { card: KommoIntegrationCard }) {
  const sc = statusColor(card.status);
  return (
    <section className={clsx('rounded-xl border border-zinc-800 bg-zinc-900/40', sc.ring, 'ring-1')}>
      <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center gap-3">
        <div className={clsx('rounded-lg p-2.5', sc.bg)}>
          <ShieldCheck size={20} className={sc.text} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            Kommo CRM <span className={clsx('text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider', sc.chip)}>{sc.label}</span>
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {card.subdomain ? <>Subdomínio: <span className="text-zinc-300">{card.subdomain}.kommo.com</span></> : 'Sem subdomínio'}
          </p>
        </div>
      </div>
      <div className="px-5 py-4 grid grid-cols-2 gap-3 text-xs">
        <Stat label="Configurado" value={card.configured ? 'Sim' : 'Não'} />
        <Stat label="Conexão" value={card.reachable === null ? '—' : card.reachable ? 'OK' : 'Falha'} />
        {card.account?.name && <Stat label="Conta" value={card.account.name} />}
        {card.account?.id && <Stat label="ID Kommo" value={String(card.account.id)} />}
      </div>
      {card.error && (
        <div className="px-5 pb-4 text-[11px] text-rose-300">Erro: {card.error}</div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// CARD: Meta
// ---------------------------------------------------------------------------

function MetaCardView({ card }: { card: MetaIntegrationCard }) {
  const sc = statusColor(card.status);
  return (
    <section className={clsx('rounded-xl border border-zinc-800 bg-zinc-900/40', sc.ring, 'ring-1')}>
      <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center gap-3">
        <div className={clsx('rounded-lg p-2.5', sc.bg)}>
          <MessageSquare size={20} className={sc.text} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            Meta WhatsApp Cloud <span className={clsx('text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider', sc.chip)}>{sc.label}</span>
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {card.phoneNumberId ? <>Phone Number ID: <span className="text-zinc-300 font-mono">{card.phoneNumberId}</span></> : 'Phone Number ID não cadastrado'}
          </p>
        </div>
      </div>
      <div className="px-5 py-4 space-y-2 text-xs">
        <CheckRow ok={card.hasAccessToken} label="Access Token" />
        <CheckRow ok={card.hasVerifyToken} label="Verify Token (handshake)" />
        <CheckRow ok={card.hasAppSecret} label="App Secret (signature dos webhooks)" />
      </div>
      <div className="px-5 pb-4">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Webhook URL</div>
        <code className="text-[11px] block bg-zinc-950/60 ring-1 ring-zinc-800 px-2 py-1.5 rounded text-zinc-300 break-all">
          {card.webhookUrl}
        </code>
        <div className="text-[10px] text-zinc-500 mt-1">
          Cole essa URL no painel Meta for Developers ao cadastrar o webhook.
        </div>
      </div>
    </section>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={clsx('flex items-center gap-2', ok ? 'text-emerald-300' : 'text-zinc-500')}>
      {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      <span>{label}</span>
    </div>
  );
}
