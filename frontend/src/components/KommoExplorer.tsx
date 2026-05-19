// ============================================================================
// KommoExplorer — visualiza e seleciona campos/salesbots/etapas do Kommo.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Substitui os NumberField manuais ("digite o ID") por dropdowns com os
// nomes reais. Carrega os 3 datasets em paralelo (campos, salesbots,
// pipelines) sob demanda. Erros do Kommo (401, 404) são exibidos
// claramente — assim o usuário vê o motivo sem precisar abrir DevTools.
//
// O componente é "controlado": recebe os IDs atuais via props e dispara
// `onChange` quando o usuário seleciona algo. O save continua sendo no
// botão "Salvar" do UnitsPanel pai.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Save, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type {
  KommoErrorEnvelope,
  KommoFieldsResponse,
  KommoPipelinesResponse,
  KommoSalesbotsResponse,
  KommoValidateResponse,
} from '../types/api';

interface Props {
  unitId: string | null;
  salesbotId: number | null;
  replyFieldId: number | null;
  pausedFieldId: number | null;
  wonStatusIds: number[];
  onSalesbotChange: (id: number | null) => void;
  onReplyFieldChange: (id: number | null) => void;
  onPausedFieldChange: (id: number | null) => void;
  onWonStatusIdsChange: (ids: number[]) => void;
  /** Salva a Unit inteira no banco (mesma ação do botão "Salvar" do topo). */
  onSave: () => Promise<void>;
  saving?: boolean;
}

export function KommoExplorer(props: Props) {
  const { unitId } = props;
  const [fields, setFields] = useState<KommoFieldsResponse | null>(null);
  const [bots, setBots] = useState<KommoSalesbotsResponse | null>(null);
  const [pipelines, setPipelines] = useState<KommoPipelinesResponse | null>(null);
  const [validation, setValidation] = useState<KommoValidateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!unitId) return;
    setLoading(true);
    try {
      const [f, b, p] = await Promise.all([
        api.kommoFields(unitId).catch((err) => extractErrorBody<KommoFieldsResponse>(err, 'campos')),
        api.kommoSalesbots(unitId).catch((err) => extractErrorBody<KommoSalesbotsResponse>(err, 'salesbots')),
        api.kommoPipelines(unitId).catch((err) => extractErrorBody<KommoPipelinesResponse>(err, 'pipelines')),
      ]);
      setFields(f);
      setBots(b);
      setPipelines(p);
    } finally {
      setLoading(false);
    }
  }, [unitId]);

  useEffect(() => {
    // Reset ao trocar de Unit.
    setFields(null);
    setBots(null);
    setPipelines(null);
    setValidation(null);
  }, [unitId]);

  async function validate() {
    if (!unitId) return;
    setValidating(true);
    try {
      const v = await api.kommoValidate(unitId);
      setValidation(v);
    } catch (err) {
      const msg = errMessage(err);
      setValidation({
        ok: false,
        checks: [{ name: 'request', ok: false, detail: msg }],
      });
    } finally {
      setValidating(false);
    }
  }

  const checkboxFields = (fields?.fields ?? []).filter((f) => f.type === 'checkbox');
  const textFields = (fields?.fields ?? []).filter((f) => f.type === 'text' || f.type === 'textarea');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-zinc-500">
          {!fields && !bots && !pipelines && 'Clica em "Carregar do Kommo" pra puxar campos, salesbots e etapas ao vivo.'}
          {(fields || bots || pipelines) && 'Dados ao vivo do Kommo. Clica em "Recarregar" se você alterou algo no Kommo.'}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading || !unitId}
            className="text-xs px-3 py-1.5 rounded bg-zinc-800 text-zinc-200 ring-1 ring-zinc-700 inline-flex items-center gap-1 hover:bg-zinc-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="animate-spin" size={12} /> : <RefreshCw size={12} />}
            {fields || bots || pipelines ? 'Recarregar' : 'Carregar do Kommo'}
          </button>
          <button
            type="button"
            onClick={validate}
            disabled={validating || !unitId}
            className="text-xs px-3 py-1.5 rounded bg-brand-500/10 text-brand-200 ring-1 ring-brand-500/30 inline-flex items-center gap-1 hover:bg-brand-500/20 disabled:opacity-50"
          >
            {validating ? <Loader2 className="animate-spin" size={12} /> : <CheckCircle2 size={12} />}
            Validar config
          </button>
        </div>
      </div>

      {/* Reply Field (textarea/text) */}
      <KommoSelect
        label="Resposta IA (campo de texto)"
        hint='Campo onde o agente escreve a resposta. O Salesbot lê daqui e envia ao paciente.'
        value={props.replyFieldId}
        onChange={props.onReplyFieldChange}
        options={textFields.map((f) => ({ id: f.id, label: `${f.name} · #${f.id} (${f.type})` }))}
        emptyHint={fields ? 'Nenhum campo de texto encontrado no Kommo.' : 'Carregue os campos pra escolher.'}
        error={fields && !fields.ok ? fields : null}
      />

      {/* Paused Field (checkbox) */}
      <KommoSelect
        label="IA Pausada (checkbox)"
        hint='Checkbox que, marcado, pausa o agente. Operador humano clica pra assumir.'
        value={props.pausedFieldId}
        onChange={props.onPausedFieldChange}
        options={checkboxFields.map((f) => ({ id: f.id, label: `${f.name} · #${f.id}` }))}
        emptyHint={fields ? 'Nenhum campo checkbox encontrado.' : 'Carregue os campos pra escolher.'}
        error={fields && !fields.ok ? fields : null}
      />

      {/* Salesbot — listagem 404 em algumas contas Kommo. Mostra input manual
          como fallback, porque o disparo (POST /salesbot/{id}/run) funciona
          mesmo sem a API de listagem. */}
      {bots && !bots.ok && bots.kommoStatus === 404 ? (
        <ManualIdField
          label="Salesbot ID"
          value={props.salesbotId}
          onChange={props.onSalesbotChange}
          hint='A API do Kommo não lista salesbots nesta conta (404). Pegue o ID na URL do bot no Kommo (.../salesbot/{ID} ou ?bot_id={ID}) e cole aqui.'
          error={bots}
        />
      ) : (
        <KommoSelect
          label="Salesbot"
          hint='Bot do Kommo que envia a mensagem pelo canal nativo (WhatsApp/Instagram).'
          value={props.salesbotId}
          onChange={props.onSalesbotChange}
          options={(bots?.bots ?? []).map((b) => ({ id: b.id, label: `${b.name} · #${b.id}` }))}
          emptyHint={bots ? 'Nenhum salesbot ativo.' : 'Carregue pra escolher.'}
          error={bots && !bots.ok ? bots : null}
        />
      )}

      {/* Pipelines + Won statuses */}
      <div>
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
          Etapas de "Ganho/Convertido"
        </div>
        <div className="text-[10px] text-zinc-600 mb-2">
          Marque as etapas que significam conversão. Quando o lead entra numa delas, a conversa é marcada como convertida e o juiz LLM avalia.
        </div>
        {pipelines?.error && <ErrorBanner envelope={pipelines} />}
        {!pipelines && (
          <div className="text-[11px] text-zinc-600 italic">Carregue os dados do Kommo pra escolher etapas.</div>
        )}
        {pipelines?.pipelines && pipelines.pipelines.length === 0 && (
          <div className="text-[11px] text-zinc-600 italic">Nenhum pipeline encontrado.</div>
        )}
        {pipelines?.pipelines && pipelines.pipelines.length > 0 && (
          <div className="space-y-2">
            {pipelines.pipelines
              .filter((p) => !p.isArchive)
              .map((p) => (
                <div key={p.id} className="rounded border border-zinc-800 bg-zinc-950/40 p-2">
                  <div className="text-[11px] font-medium text-zinc-300 mb-1.5 flex items-center gap-2">
                    {p.name}
                    {p.isMain && <span className="text-[9px] uppercase tracking-wider text-brand-400">Principal</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {p.statuses.map((s) => {
                      const checked = props.wonStatusIds.includes(s.id);
                      return (
                        <label
                          key={s.id}
                          className={clsx(
                            'flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer transition',
                            checked ? 'bg-emerald-500/15 text-emerald-200' : 'text-zinc-300 hover:bg-zinc-800/40',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...props.wonStatusIds, s.id]
                                : props.wonStatusIds.filter((x) => x !== s.id);
                              props.onWonStatusIdsChange(next);
                            }}
                            className="accent-emerald-500"
                          />
                          <span className="truncate">{s.name}</span>
                          <span className="ml-auto text-[10px] text-zinc-500">#{s.id}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Validation result */}
      {validation && <ValidationResults result={validation} />}

      {/* Botão de salvar dedicado — persiste tudo no banco. */}
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 mt-2">
        <div className="flex items-start gap-3">
          <Save className="text-emerald-400 mt-0.5 shrink-0" size={16} />
          <div className="flex-1">
            <div className="text-xs font-semibold text-emerald-200 mb-1">
              Salvar configuração Kommo no banco
            </div>
            <div className="text-[11px] text-zinc-400 mb-3">
              Persiste suas seleções (Resposta IA, IA Pausada, Salesbot ID, etapas de Ganho) na Unit.
              Sem clicar aqui, o agente continua usando os valores antigos.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  setSaveMsg(null);
                  try {
                    await props.onSave();
                    setSaveMsg({ kind: 'ok', text: 'Configuração salva no banco ✓' });
                  } catch (err) {
                    setSaveMsg({ kind: 'err', text: errMessage(err) });
                  }
                }}
                disabled={props.saving || !unitId}
                className="text-xs px-4 py-2 rounded bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-500/40 inline-flex items-center gap-1.5 hover:bg-emerald-500/30 disabled:opacity-50 font-medium"
              >
                {props.saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                Salvar configuração Kommo
              </button>
              {saveMsg && (
                <span
                  className={clsx(
                    'text-[11px] px-2 py-1 rounded',
                    saveMsg.kind === 'ok'
                      ? 'bg-emerald-500/15 text-emerald-200'
                      : 'bg-rose-500/15 text-rose-300',
                  )}
                >
                  {saveMsg.text}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponentes
// ---------------------------------------------------------------------------

function KommoSelect({
  label,
  hint,
  value,
  onChange,
  options,
  emptyHint,
  error,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (id: number | null) => void;
  options: Array<{ id: number; label: string }>;
  emptyHint: string;
  error: KommoErrorEnvelope | null | undefined;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">{label}</label>
      {error && <ErrorBanner envelope={error} />}
      <select
        value={value ?? 0}
        onChange={(e) => {
          const id = Number(e.target.value);
          onChange(id > 0 ? id : null);
        }}
        disabled={options.length === 0}
        className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:opacity-50"
      >
        <option value={0}>— Nenhum —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        {/* Se o valor atual não está na lista (ex: ainda não carregou os dados), mostra ele assim mesmo */}
        {value && !options.some((o) => o.id === value) && (
          <option value={value}>#{value} (atual)</option>
        )}
      </select>
      {options.length === 0 && !error && (
        <div className="text-[10px] text-zinc-600 mt-1 italic">{emptyHint}</div>
      )}
      {hint && <div className="text-[10px] text-zinc-600 mt-1">{hint}</div>}
    </div>
  );
}

function ManualIdField({
  label,
  value,
  onChange,
  hint,
  error,
}: {
  label: string;
  value: number | null;
  onChange: (id: number | null) => void;
  hint?: string;
  error?: KommoErrorEnvelope | null;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">{label}</label>
      {error && <ErrorBanner envelope={error} />}
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value.trim();
          const n = v === '' ? null : Number(v);
          onChange(n && Number.isFinite(n) && n > 0 ? n : null);
        }}
        placeholder="Cole o ID aqui (ex: 12345)"
        className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
      />
      {hint && <div className="text-[10px] text-zinc-600 mt-1">{hint}</div>}
    </div>
  );
}

function ErrorBanner({ envelope }: { envelope: KommoErrorEnvelope }) {
  const detail = formatKommoBody(envelope.kommoBody);
  return (
    <div className="mb-1 rounded bg-rose-500/10 ring-1 ring-rose-500/30 px-2 py-1.5 text-[10px] text-rose-200 space-y-1">
      <div>
        <strong className="font-semibold">Kommo</strong>
        {envelope.kommoStatus && (
          <span className="ml-1 inline-block rounded bg-rose-500/20 px-1.5 py-0.5 font-mono">
            HTTP {envelope.kommoStatus}
          </span>
        )}
        {envelope.error && <span className="ml-1 text-rose-300/80">— {envelope.error}</span>}
      </div>
      {detail && (
        <pre className="font-mono text-[10px] text-rose-300/90 whitespace-pre-wrap break-words">
          {detail}
        </pre>
      )}
    </div>
  );
}

function formatKommoBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  // Kommo costuma devolver { title, type, status, detail, "validation-errors": [...] }
  const b = body as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof b.detail === 'string') lines.push(`detail: ${b.detail}`);
  else if (typeof b.title === 'string') lines.push(`title: ${b.title}`);
  if (b.hint && typeof b.hint === 'string') lines.push(`hint: ${b.hint}`);
  if (Array.isArray(b['validation-errors'])) {
    lines.push('validation-errors:');
    for (const ve of b['validation-errors'] as unknown[]) lines.push(`  · ${JSON.stringify(ve)}`);
  }
  if (lines.length === 0) lines.push(JSON.stringify(body, null, 2));
  return lines.join('\n');
}

function ValidationResults({ result }: { result: KommoValidateResponse }) {
  return (
    <div
      className={clsx(
        'rounded-lg p-3 ring-1',
        result.ok ? 'bg-emerald-500/5 ring-emerald-500/30' : 'bg-rose-500/5 ring-rose-500/30',
      )}
    >
      <div className="text-xs font-semibold mb-2 flex items-center gap-2">
        {result.ok ? (
          <>
            <CheckCircle2 className="text-emerald-400" size={14} />
            <span className="text-emerald-200">Configuração validada</span>
          </>
        ) : (
          <>
            <XCircle className="text-rose-400" size={14} />
            <span className="text-rose-200">Configuração com pendências</span>
          </>
        )}
      </div>
      <ul className="space-y-1">
        {result.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-2 text-[11px]">
            {c.ok ? (
              <CheckCircle2 size={12} className="text-emerald-400 mt-0.5 shrink-0" />
            ) : (
              <XCircle size={12} className="text-rose-400 mt-0.5 shrink-0" />
            )}
            <span className={clsx('font-mono', c.ok ? 'text-zinc-300' : 'text-rose-300')}>
              {c.name}
            </span>
            {c.detail && <span className="text-zinc-500">— {c.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractErrorBody<T>(err: unknown, _kind: string): T {
  const e = err as { response?: { data?: unknown }; message?: string };
  const body = e?.response?.data as Partial<T> | undefined;
  if (body && typeof body === 'object') return body as T;
  return { ok: false, error: e?.message ?? 'erro' } as unknown as T;
}

function errMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'erro';
}
