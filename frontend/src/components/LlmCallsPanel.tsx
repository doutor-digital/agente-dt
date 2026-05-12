// ============================================================================
// LlmCallsPanel — visão "ByteGPT/IA": todas as chamadas à OpenAI.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Lista paginada das LlmCalls da unidade selecionada (ou todas). Mostra
// modelo, tokens, custo, latência e status. Click revela payload completo
// (request body + response body) — útil pra debug e auditoria.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Cpu, DollarSign, Loader2, X, Zap } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { usePolling } from '../hooks/usePolling';
import type { LlmCallDetail } from '../types/api';

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtN(n: number): string {
  return n.toLocaleString('pt-BR');
}

export function LlmCallsPanel() {
  const { selectedUnitId, selectedUnit } = useUnit();
  const fetcher = useMemo(() => () => api.listLlmCalls(selectedUnitId, 200), [selectedUnitId]);
  const { data: calls, loading } = usePolling(fetcher, 5000, [selectedUnitId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LlmCallDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    setOpenId(null);
    setDetail(null);
  }, [selectedUnitId]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    api
      .getLlmCall(openId)
      .then(setDetail)
      .finally(() => setLoadingDetail(false));
  }, [openId]);

  const totalCost = (calls ?? []).reduce((sum, c) => sum + c.costUsd, 0);
  const totalTokens = (calls ?? []).reduce((sum, c) => sum + c.totalTokens, 0);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="px-6 pt-5 pb-3 border-b border-zinc-800/80">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-zinc-100">
            Chamadas IA {selectedUnit ? `· ${selectedUnit.name}` : '· Todas as unidades'}
          </h2>
          {loading && <Loader2 className="animate-spin text-zinc-500" size={12} />}
          <div className="ml-auto flex items-center gap-4 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <Cpu size={11} className="text-brand-400" />
              {fmtN(calls?.length ?? 0)} chamadas (últimas 200)
            </span>
            <span className="inline-flex items-center gap-1">
              <Zap size={11} className="text-amber-400" />
              {fmtN(totalTokens)} tokens
            </span>
            <span className="inline-flex items-center gap-1">
              <DollarSign size={11} className="text-emerald-400" />
              {fmtUsd(totalCost)}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="text-left py-2 px-2">Quando</th>
              <th className="text-left py-2 px-2">Modelo</th>
              <th className="text-left py-2 px-2">Endpoint</th>
              <th className="text-right py-2 px-2">Prompt</th>
              <th className="text-right py-2 px-2">Output</th>
              <th className="text-right py-2 px-2">Total</th>
              <th className="text-right py-2 px-2">Custo</th>
              <th className="text-right py-2 px-2">Latência</th>
              <th className="text-left py-2 px-2">Status</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {(calls ?? []).map((c) => (
              <tr
                key={c.id}
                onClick={() => setOpenId(c.id)}
                className={clsx(
                  'border-t border-zinc-800/60 cursor-pointer hover:bg-zinc-900/40 transition',
                  openId === c.id && 'bg-zinc-900/60',
                )}
              >
                <td className="px-2 py-2 text-zinc-400">
                  {new Date(c.createdAt).toLocaleString('pt-BR')}
                </td>
                <td className="px-2 py-2 font-mono">{c.model}</td>
                <td className="px-2 py-2 text-zinc-500">{c.endpoint}</td>
                <td className="px-2 py-2 text-right">{fmtN(c.promptTokens)}</td>
                <td className="px-2 py-2 text-right">{fmtN(c.completionTokens)}</td>
                <td className="px-2 py-2 text-right font-medium">{fmtN(c.totalTokens)}</td>
                <td className="px-2 py-2 text-right text-emerald-300">{fmtUsd(c.costUsd)}</td>
                <td className="px-2 py-2 text-right text-amber-300">{c.latencyMs}ms</td>
                <td className="px-2 py-2">
                  <span
                    className={clsx(
                      'text-[10px] px-1.5 py-0.5 rounded',
                      c.status === 'success'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-rose-500/15 text-rose-300',
                    )}
                  >
                    {c.status}
                  </span>
                </td>
              </tr>
            ))}
            {(calls ?? []).length === 0 && !loading && (
              <tr>
                <td colSpan={9} className="text-center text-zinc-600 py-8">
                  Nenhuma chamada registrada{selectedUnitId ? ' nesta unidade' : ''} ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer de detalhe */}
      {openId && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setOpenId(null)}
        >
          <aside
            className="absolute right-0 top-0 bottom-0 w-[640px] max-w-[95vw] bg-zinc-950 border-l border-zinc-800 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80">
              <span className="text-sm font-semibold text-zinc-100">Detalhe da chamada</span>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="text-zinc-500 hover:text-zinc-200"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loadingDetail && <Loader2 className="animate-spin text-zinc-500" size={14} />}
              {detail && (
                <>
                  <KvBlock
                    rows={[
                      ['Modelo', detail.model],
                      ['Endpoint', detail.endpoint],
                      ['Status', detail.status],
                      ['Tokens prompt', fmtN(detail.promptTokens)],
                      ['Tokens output', fmtN(detail.completionTokens)],
                      ['Total tokens', fmtN(detail.totalTokens)],
                      ['Custo USD', fmtUsd(detail.costUsd)],
                      ['Latência', `${detail.latencyMs}ms`],
                      ['Quando', new Date(detail.createdAt).toLocaleString('pt-BR')],
                      ...(detail.errorMessage ? ([['Erro', detail.errorMessage]] as [string, string][]) : []),
                    ]}
                  />
                  <JsonBlock title="Request" value={detail.requestBody} />
                  <JsonBlock title="Response" value={detail.responseBody} />
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function KvBlock({ rows }: { rows: [string, string][] }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-zinc-800/60 first:border-t-0">
              <td className="px-3 py-1.5 text-zinc-500 w-32">{k}</td>
              <td className="px-3 py-1.5 text-zinc-200 font-mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{title}</div>
      <pre className="text-[11px] bg-zinc-950/80 ring-1 ring-zinc-800 rounded-md p-3 overflow-auto max-h-96 text-zinc-300">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
