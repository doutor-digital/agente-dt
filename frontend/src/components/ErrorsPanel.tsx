// ============================================================================
// ErrorsPanel — painel de logs warn/error/fatal persistidos.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Captura automática pelo hook do Pino em backend/src/lib/logger.ts: todo
// `logger.warn/error/fatal` em qualquer lugar do backend vai parar na tabela
// `system_logs` e aparece aqui — sem precisar instrumentar nada nos
// callsites.
//
// Filtros (lado-servidor):
//   - level   WARN | ERROR | FATAL
//   - module  nome do arquivo emissor (ex: "kommo.service")
//   - q       busca em msg (case-insensitive)
//   - since   "1h" | "24h" | "7d" → convertido pra ISO antes de mandar
//
// Click numa linha abre o context completo (JSON) e, se houver `traceId`,
// um link clicável pra aba "Execuções" focando aquele trace específico.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { AlertOctagon, Loader2, Search, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { usePolling } from '../hooks/usePolling';
import { tabToPath } from '../hooks/useRoute';
import type { LogLevel, SystemLog, SystemLogQuery } from '../types/api';

const LEVEL_BADGE: Record<LogLevel, string> = {
  WARN: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  ERROR: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  FATAL: 'bg-red-700/30 text-red-200 ring-red-600/40',
};

const SINCE_OPTIONS: Array<{ label: string; ms: number | null }> = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Tudo', ms: null },
];

export function ErrorsPanel() {
  const { selectedUnitId, selectedUnit } = useUnit();

  const [level, setLevel] = useState<LogLevel | ''>('');
  const [module, setModule] = useState('');
  const [q, setQ] = useState('');
  const [sinceMs, setSinceMs] = useState<number | null>(24 * 60 * 60 * 1000);
  const [openId, setOpenId] = useState<string | null>(null);

  // since em ISO — recalcula a cada render (curto), mas só muda quando
  // sinceMs muda. Usar useMemo evita re-fetch desnecessário.
  const sinceIso = useMemo(
    () => (sinceMs == null ? undefined : new Date(Date.now() - sinceMs).toISOString()),
    // recalcula somente quando o range muda (resolução grosseira é OK)
    [sinceMs],
  );

  const query: SystemLogQuery = useMemo(
    () => ({
      ...(level ? { level } : {}),
      ...(module ? { module } : {}),
      ...(q ? { q } : {}),
      ...(sinceIso ? { since: sinceIso } : {}),
    }),
    [level, module, q, sinceIso],
  );

  const fetcher = useMemo(
    () => () => api.listSystemLogs(selectedUnitId, query),
    [selectedUnitId, query],
  );
  const { data, loading } = usePolling(fetcher, 5000, [selectedUnitId, query]);

  const modulesFetcher = useMemo(
    () => () => api.listSystemLogModules(selectedUnitId),
    [selectedUnitId],
  );
  const { data: modules } = usePolling(modulesFetcher, 30000, [selectedUnitId]);

  useEffect(() => {
    setOpenId(null);
  }, [selectedUnitId]);

  const logs = data?.logs ?? [];
  const counts = data?.counts ?? { WARN: 0, ERROR: 0, FATAL: 0 };
  const detail = logs.find((l) => l.id === openId) ?? null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header com totais por level */}
      <div className="px-6 pt-5 pb-3 border-b border-zinc-800/80">
        <div className="flex items-center gap-3 mb-3">
          <AlertOctagon size={16} className="text-rose-400" />
          <h2 className="text-sm font-semibold text-zinc-100">
            Erros do sistema {selectedUnit ? `· ${selectedUnit.name}` : '· Todas as unidades'}
          </h2>
          {loading && <Loader2 className="animate-spin text-zinc-500" size={12} />}
          <div className="ml-auto flex items-center gap-2 text-[11px]">
            <CountBadge label="Warn" value={counts.WARN} className="bg-amber-500/10 text-amber-300" />
            <CountBadge label="Error" value={counts.ERROR} className="bg-rose-500/10 text-rose-300" />
            <CountBadge label="Fatal" value={counts.FATAL} className="bg-red-700/20 text-red-200" />
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar na mensagem…"
              className="w-full bg-zinc-900/60 border border-zinc-800 rounded-md text-xs pl-7 pr-2 py-1.5 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
            />
          </div>

          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as LogLevel | '')}
            className="bg-zinc-900/60 border border-zinc-800 rounded-md text-xs px-2 py-1.5 text-zinc-100 focus:outline-none"
          >
            <option value="">Todos níveis</option>
            <option value="WARN">Warn</option>
            <option value="ERROR">Error</option>
            <option value="FATAL">Fatal</option>
          </select>

          <select
            value={module}
            onChange={(e) => setModule(e.target.value)}
            className="bg-zinc-900/60 border border-zinc-800 rounded-md text-xs px-2 py-1.5 text-zinc-100 focus:outline-none max-w-[200px]"
          >
            <option value="">Todos módulos</option>
            {(modules ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <div className="inline-flex rounded-md border border-zinc-800 overflow-hidden">
            {SINCE_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setSinceMs(opt.ms)}
                className={clsx(
                  'text-[11px] px-2 py-1.5 transition',
                  sinceMs === opt.ms
                    ? 'bg-brand-500/20 text-brand-200'
                    : 'text-zinc-400 hover:bg-zinc-900/60',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {(level || module || q) && (
            <button
              type="button"
              onClick={() => {
                setLevel('');
                setModule('');
                setQ('');
              }}
              className="text-[11px] text-zinc-500 hover:text-zinc-200 px-2"
            >
              Limpar
            </button>
          )}
        </div>
      </div>

      {/* Tabela */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="text-left py-2 px-2 w-32">Quando</th>
              <th className="text-left py-2 px-2 w-16">Nível</th>
              <th className="text-left py-2 px-2 w-40">Módulo</th>
              <th className="text-left py-2 px-2">Mensagem</th>
              <th className="text-left py-2 px-2 w-20">Trace</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {logs.map((l) => (
              <LogRow
                key={l.id}
                log={l}
                active={openId === l.id}
                onClick={() => setOpenId(l.id === openId ? null : l.id)}
              />
            ))}
            {logs.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="text-center text-zinc-600 py-12">
                  Nenhum log nessas condições.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer de detalhe */}
      {detail && <DetailDrawer log={detail} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function LogRow({
  log,
  active,
  onClick,
}: {
  log: SystemLog;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        'border-t border-zinc-800/60 cursor-pointer hover:bg-zinc-900/40 transition',
        active && 'bg-zinc-900/60',
      )}
    >
      <td className="px-2 py-2 text-zinc-400 font-mono whitespace-nowrap">
        {new Date(log.createdAt).toLocaleString('pt-BR')}
      </td>
      <td className="px-2 py-2">
        <span
          className={clsx(
            'text-[10px] px-1.5 py-0.5 rounded ring-1 uppercase font-semibold tracking-wider',
            LEVEL_BADGE[log.level],
          )}
        >
          {log.level}
        </span>
      </td>
      <td className="px-2 py-2 text-zinc-500 font-mono truncate max-w-[200px]">
        {log.module ?? '—'}
      </td>
      <td className="px-2 py-2 text-zinc-200 truncate max-w-[400px]" title={log.msg}>
        {log.msg}
      </td>
      <td className="px-2 py-2">
        {log.traceId ? (
          <a
            href={`${tabToPath('traces')}?trace=${log.traceId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-brand-400 hover:text-brand-300 text-[11px]"
          >
            abrir →
          </a>
        ) : (
          <span className="text-zinc-700">—</span>
        )}
      </td>
    </tr>
  );
}

function DetailDrawer({ log, onClose }: { log: SystemLog; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="absolute right-0 top-0 bottom-0 w-[640px] max-w-[95vw] bg-zinc-950 border-l border-zinc-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'text-[10px] px-1.5 py-0.5 rounded ring-1 uppercase font-semibold tracking-wider',
                LEVEL_BADGE[log.level],
              )}
            >
              {log.level}
            </span>
            <span className="text-sm font-semibold text-zinc-100">Detalhe do erro</span>
          </div>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <KvBlock
            rows={[
              ['Quando', new Date(log.createdAt).toLocaleString('pt-BR')],
              ['Módulo', log.module ?? '—'],
              ['Unit ID', log.unitId ?? '—'],
              [
                'Trace ID',
                log.traceId ? (
                  <a
                    href={`${tabToPath('traces')}?trace=${log.traceId}`}
                    className="text-brand-400 hover:text-brand-300"
                  >
                    {log.traceId}
                  </a>
                ) : (
                  '—'
                ),
              ],
            ]}
          />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Mensagem</div>
            <div className="text-xs text-zinc-200 bg-zinc-900/60 border border-zinc-800 rounded-md p-3 whitespace-pre-wrap break-words">
              {log.msg}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Contexto</div>
            <pre className="text-[11px] bg-zinc-950/80 ring-1 ring-zinc-800 rounded-md p-3 overflow-auto max-h-[60vh] text-zinc-300">
              {log.context === null || log.context === undefined
                ? '—'
                : JSON.stringify(log.context, null, 2)}
            </pre>
          </div>
        </div>
      </aside>
    </div>
  );
}

function KvBlock({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} className="border-t border-zinc-800/60 first:border-t-0">
              <td className="px-3 py-1.5 text-zinc-500 w-32">{k}</td>
              <td className="px-3 py-1.5 text-zinc-200 font-mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CountBadge({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <span className={clsx('px-2 py-0.5 rounded inline-flex items-center gap-1', className)}>
      <span className="font-semibold">{value.toLocaleString('pt-BR')}</span>
      <span className="opacity-70">{label}</span>
    </span>
  );
}
