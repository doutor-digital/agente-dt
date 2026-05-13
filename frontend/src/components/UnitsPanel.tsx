// ============================================================================
// UnitsPanel — CRUD de unidades (consultorias).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Mostra a lista à esquerda + form de edição à direita. Secrets vêm
// mascarados do back. Se o usuário não digitar nada novo no campo de secret
// (mantém o valor mascarado), o back ignora — assim ele pode editar nome
// sem precisar redigitar token.
// ============================================================================

import { useEffect, useState } from 'react';
import { Building2, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { Unit, UnitInput } from '../types/api';
import { useUnit } from '../context/UnitContext';

const blankInput: UnitInput = {
  slug: '',
  name: '',
  isActive: true,
  kommoSubdomain: '',
  kommoAccessToken: '',
  kommoSalesbotId: null,
  kommoReplyFieldId: null,
  openaiApiKey: '',
  openaiAdminKey: '',
  openaiModel: 'gpt-4o-mini',
  openaiAssistantId: '',
  openaiTemperature: 0,
  openaiMaxTokens: 1024,
  openaiMonthlyBudgetUsd: 50,
  metaPhoneNumberId: '',
  metaAccessToken: '',
  metaVerifyToken: '',
  metaAppSecret: '',
  systemPrompt: '',
};

function unitToInput(u: Unit): UnitInput {
  return {
    slug: u.slug,
    name: u.name,
    isActive: u.isActive,
    kommoSubdomain: u.kommoSubdomain ?? '',
    kommoAccessToken: u.kommoAccessToken ?? '',
    kommoSalesbotId: u.kommoSalesbotId,
    kommoReplyFieldId: u.kommoReplyFieldId,
    openaiApiKey: u.openaiApiKey ?? '',
    openaiAdminKey: u.openaiAdminKey ?? '',
    openaiModel: u.openaiModel,
    openaiAssistantId: u.openaiAssistantId ?? '',
    openaiTemperature: u.openaiTemperature,
    openaiMaxTokens: u.openaiMaxTokens,
    openaiMonthlyBudgetUsd: Number(u.openaiMonthlyBudgetUsd ?? 50),
    metaPhoneNumberId: u.metaPhoneNumberId ?? '',
    metaAccessToken: u.metaAccessToken ?? '',
    metaVerifyToken: u.metaVerifyToken ?? '',
    metaAppSecret: u.metaAppSecret ?? '',
    systemPrompt: u.systemPrompt,
  };
}

export function UnitsPanel() {
  const { units, refresh, loading: ctxLoading } = useUnit();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<UnitInput>(blankInput);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!selectedId && units.length > 0) {
      setSelectedId(units[0].id);
    }
  }, [units, selectedId]);

  useEffect(() => {
    const u = units.find((x) => x.id === selectedId);
    if (u) {
      setDraft(unitToInput(u));
      setCreating(false);
    }
  }, [units, selectedId]);

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      if (creating) {
        const created = await api.createUnit(draft);
        await refresh();
        setSelectedId(created.id);
        setMsg({ kind: 'ok', text: 'Unidade criada' });
      } else if (selectedId) {
        await api.updateUnit(selectedId, draft);
        await refresh();
        setMsg({ kind: 'ok', text: 'Salvo' });
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; issues?: unknown } }; message?: string };
      const code = e?.response?.data?.error;
      setMsg({ kind: 'err', text: code ?? e?.message ?? 'erro' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirm(`Apagar unidade "${draft.name}"? Toda a observabilidade dela vai junto.`)) return;
    try {
      await api.deleteUnit(selectedId);
      setSelectedId(null);
      setDraft(blankInput);
      await refresh();
      setMsg({ kind: 'ok', text: 'Unidade apagada' });
    } catch (err) {
      const e = err as { message?: string };
      setMsg({ kind: 'err', text: e?.message ?? 'erro' });
    }
  }

  function startCreate() {
    setCreating(true);
    setSelectedId(null);
    setDraft(blankInput);
    setMsg(null);
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Lista */}
      <aside className="w-64 shrink-0 border-r border-zinc-800/80 bg-ink-900 flex flex-col">
        <div className="p-3 border-b border-zinc-800/80 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Unidades</span>
          <button
            type="button"
            onClick={startCreate}
            className="text-xs px-2 py-1 rounded bg-brand-500/10 text-brand-300 ring-1 ring-brand-500/30 inline-flex items-center gap-1 hover:bg-brand-500/20"
          >
            <Plus size={12} />
            Nova
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {ctxLoading && <Loader2 className="animate-spin text-zinc-500 mx-auto mt-4" size={14} />}
          {!ctxLoading && units.length === 0 && !creating && (
            <div className="text-[11px] text-zinc-600 text-center mt-6 px-2">
              Nenhuma unidade. Clique em "Nova" pra começar.
            </div>
          )}
          <ul className="space-y-0.5">
            {units.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setSelectedId(u.id);
                  }}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-md transition border-l-2',
                    selectedId === u.id
                      ? 'bg-zinc-800/70 border-brand-500'
                      : 'border-transparent hover:bg-zinc-800/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Building2 size={12} className="text-brand-400" />
                    <span className="text-xs font-medium text-zinc-200 truncate">{u.name}</span>
                    {!u.isActive && (
                      <span className="ml-auto text-[9px] uppercase tracking-wider text-amber-500/80">
                        off
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-0.5 truncate">/{u.slug}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Form */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-zinc-100">
              {creating ? 'Nova unidade' : selectedId ? draft.name || 'Sem nome' : 'Selecione uma unidade'}
            </h2>
            <div className="flex items-center gap-2">
              {msg && (
                <span
                  className={clsx(
                    'text-xs px-2 py-1 rounded',
                    msg.kind === 'ok' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300',
                  )}
                >
                  {msg.text}
                </span>
              )}
              {!creating && selectedId && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1 text-rose-300 hover:bg-rose-500/10 ring-1 ring-rose-500/20"
                >
                  <Trash2 size={12} />
                  Apagar
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || (!creating && !selectedId)}
                className="text-xs px-3 py-1.5 rounded bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/30 inline-flex items-center gap-1 hover:bg-brand-500/30 disabled:opacity-50"
              >
                {saving ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />}
                Salvar
              </button>
            </div>
          </div>

          {(creating || selectedId) && (
            <div className="space-y-6">
              <Section title="Identidade">
                <Field
                  label="Nome"
                  value={draft.name}
                  onChange={(v) => setDraft({ ...draft, name: v })}
                />
                <Field
                  label="Slug (URL)"
                  value={draft.slug}
                  onChange={(v) => setDraft({ ...draft, slug: v })}
                  hint="Aparece em /api/webhooks/{slug}/... — kebab-case"
                />
                <Toggle
                  label="Ativa"
                  value={!!draft.isActive}
                  onChange={(v) => setDraft({ ...draft, isActive: v })}
                />
              </Section>

              <Section title="OpenAI" subtitle="Cada unidade tem sua API key, Assistant e orçamento.">
                <Field
                  label="API Key (sk-proj-...)"
                  value={draft.openaiApiKey ?? ''}
                  onChange={(v) => setDraft({ ...draft, openaiApiKey: v })}
                  type="password"
                  hint="Chave de projeto, usada nas chamadas de inferência."
                />
                <Field
                  label="Admin Key (sk-admin-...) — opcional"
                  value={draft.openaiAdminKey ?? ''}
                  onChange={(v) => setDraft({ ...draft, openaiAdminKey: v })}
                  type="password"
                  hint="Habilita gastos REAIS da OpenAI no painel de Integrações (custos, projetos, usage)."
                />
                <Field
                  label="Modelo"
                  value={draft.openaiModel ?? ''}
                  onChange={(v) => setDraft({ ...draft, openaiModel: v })}
                />
                <Field
                  label="Assistant ID (opcional)"
                  value={draft.openaiAssistantId ?? ''}
                  onChange={(v) => setDraft({ ...draft, openaiAssistantId: v })}
                  hint="Se preenchido, usa Assistants API ao invés de Chat Completions."
                />
                <div className="grid grid-cols-3 gap-3">
                  <NumberField
                    label="Temperature"
                    value={draft.openaiTemperature ?? 0}
                    onChange={(v) => setDraft({ ...draft, openaiTemperature: v })}
                    step={0.1}
                  />
                  <NumberField
                    label="Max tokens"
                    value={draft.openaiMaxTokens ?? 1024}
                    onChange={(v) => setDraft({ ...draft, openaiMaxTokens: v })}
                  />
                  <NumberField
                    label="Orçamento $USD/mês"
                    value={Number(draft.openaiMonthlyBudgetUsd ?? 50)}
                    onChange={(v) => setDraft({ ...draft, openaiMonthlyBudgetUsd: v })}
                    step={1}
                    allowZero
                  />
                </div>
              </Section>

              <Section title="Kommo" subtitle="Long-Lived Access Token + subdomínio.">
                <Field
                  label="Subdomínio"
                  value={draft.kommoSubdomain ?? ''}
                  onChange={(v) => setDraft({ ...draft, kommoSubdomain: v })}
                  hint="Ex: minhaempresa (de minhaempresa.kommo.com)"
                />
                <Field
                  label="Access Token"
                  value={draft.kommoAccessToken ?? ''}
                  onChange={(v) => setDraft({ ...draft, kommoAccessToken: v })}
                  type="password"
                />
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label="Salesbot ID"
                    value={draft.kommoSalesbotId ?? 0}
                    onChange={(v) => setDraft({ ...draft, kommoSalesbotId: v || null })}
                    allowZero
                  />
                  <NumberField
                    label="Reply Field ID"
                    value={draft.kommoReplyFieldId ?? 0}
                    onChange={(v) => setDraft({ ...draft, kommoReplyFieldId: v || null })}
                    allowZero
                  />
                </div>
              </Section>

              <Section title="Meta WhatsApp Cloud" subtitle="Opcional — habilita o canal Meta direto.">
                <Field
                  label="Phone Number ID"
                  value={draft.metaPhoneNumberId ?? ''}
                  onChange={(v) => setDraft({ ...draft, metaPhoneNumberId: v })}
                />
                <Field
                  label="Access Token"
                  value={draft.metaAccessToken ?? ''}
                  onChange={(v) => setDraft({ ...draft, metaAccessToken: v })}
                  type="password"
                />
                <Field
                  label="Verify Token"
                  value={draft.metaVerifyToken ?? ''}
                  onChange={(v) => setDraft({ ...draft, metaVerifyToken: v })}
                  type="password"
                  hint="Token aleatório que você cadastra no painel da Meta."
                />
                <Field
                  label="App Secret"
                  value={draft.metaAppSecret ?? ''}
                  onChange={(v) => setDraft({ ...draft, metaAppSecret: v })}
                  type="password"
                  hint="Usado pra validar a signature HMAC dos webhooks."
                />
              </Section>

              <Section title="System Prompt" subtitle="Personalidade default da IA pra essa unidade.">
                <textarea
                  value={draft.systemPrompt ?? ''}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  rows={10}
                  className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-2 text-xs text-zinc-200 font-mono"
                />
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pequenos helpers de UI
// ---------------------------------------------------------------------------

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        {subtitle && <p className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'password';
  hint?: string;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
      />
      {hint && <div className="text-[10px] text-zinc-600 mt-1">{hint}</div>}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
  allowZero,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  allowZero?: boolean;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">{label}</label>
      <input
        type="number"
        step={step ?? 1}
        value={allowZero || value !== 0 ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
      />
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-brand-500"
      />
      {label}
    </label>
  );
}
