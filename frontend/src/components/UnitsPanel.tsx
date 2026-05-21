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

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Copy, Loader2, MoreVertical, Plus, Save, Search, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { Unit, UnitInput } from '../types/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { KommoExplorer } from './KommoExplorer';
import { KommoSchemaPreview } from './KommoSchemaPreview';

const DEFAULT_UNIT_AVATAR = 'https://fiqon.com.br/wp-content/uploads/2025/04/kommo.png';

const blankInput: UnitInput = {
  slug: '',
  name: '',
  isActive: true,
  kommoSubdomain: '',
  kommoAccessToken: '',
  kommoSalesbotId: null,
  kommoReplyFieldId: null,
  kommoPausedFieldId: null,
  kommoWonStatusIds: [],
  kommoBypassSalesbot: false,
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
    kommoPausedFieldId: u.kommoPausedFieldId ?? null,
    kommoWonStatusIds: u.kommoWonStatusIds ?? [],
    kommoBypassSalesbot: u.kommoBypassSalesbot ?? false,
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
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<UnitInput>(blankInput);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [cloningId, setCloningId] = useState<string | null>(null);

  const editing = creating || selectedId !== null;

  useEffect(() => {
    const u = units.find((x) => x.id === selectedId);
    if (u) {
      setDraft(unitToInput(u));
      setCreating(false);
    }
  }, [units, selectedId]);

  // Fecha menu "..." ao clicar fora.
  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [openMenuId]);

  const filteredUnits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return units;
    return units.filter(
      (u) => u.name.toLowerCase().includes(q) || u.slug.toLowerCase().includes(q),
    );
  }, [units, search]);

  async function handleSave() {
    setSaving(true);
    try {
      if (creating) {
        const created = await api.createUnit(draft);
        await refresh();
        setSelectedId(created.id);
        toast.success('Unidade criada');
      } else if (selectedId) {
        await api.updateUnit(selectedId, draft);
        await refresh();
        toast.success('Salvo');
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; issues?: unknown } }; message?: string };
      const code = e?.response?.data?.error;
      toast.error(code ?? e?.message ?? 'erro ao salvar');
      throw err; // re-lança pra callers (ex: botão dedicado dentro do KommoExplorer)
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(unit: Unit) {
    if (!confirm(`Apagar unidade "${unit.name}"? Toda a observabilidade dela vai junto.`)) return;
    try {
      await api.deleteUnit(unit.id);
      if (selectedId === unit.id) {
        setSelectedId(null);
        setDraft(blankInput);
      }
      await refresh();
      toast.success('Unidade apagada');
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message ?? 'erro ao apagar');
    }
  }

  async function handleClone(unit: Unit) {
    setCloningId(unit.id);
    try {
      const created = await api.cloneUnit(unit.id);
      await refresh();
      toast.success(`"${unit.name}" clonada — ajuste o slug/nome`);
      setSelectedId(created.id);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      toast.error(e?.response?.data?.error ?? e?.message ?? 'erro ao clonar');
    } finally {
      setCloningId(null);
    }
  }

  function startCreate() {
    setCreating(true);
    setSelectedId(null);
    setDraft(blankInput);
  }

  function closeEdit() {
    setSelectedId(null);
    setCreating(false);
  }

  // Renderização condicional: grid OU página de edição em tela cheia.
  // Antes era grid + drawer overlay; o user pediu pra ocupar a tela toda.
  if (editing) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
            {/* Header sticky com voltar + ações */}
            <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur-sm flex items-center gap-3 pb-4 mb-2 border-b border-zinc-800/60">
              <button
                type="button"
                onClick={closeEdit}
                className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1.5 rounded hover:bg-zinc-900/60"
                title="Voltar pra lista de unidades"
              >
                <ArrowLeft size={14} />
                Voltar
              </button>
              <h2 className="text-base font-semibold text-zinc-100 flex-1 truncate">
                {creating ? 'Nova unidade' : draft.name || 'Sem nome'}
              </h2>
              <div className="flex items-center gap-2 shrink-0">
                {!creating && selectedId && isSuper && (
                  <button
                    type="button"
                    onClick={() => {
                      const u = units.find((x) => x.id === selectedId);
                      if (u) void handleDelete(u);
                    }}
                    className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1 text-rose-300 hover:bg-rose-500/10 ring-1 ring-rose-500/20"
                  >
                    <Trash2 size={12} />
                    Apagar
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void handleSave().catch(() => {});
                  }}
                  disabled={saving}
                  className="text-xs px-3 py-1.5 rounded bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/30 inline-flex items-center gap-1 hover:bg-brand-500/30 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />}
                  Salvar
                </button>
              </div>
            </div>

            <div className="pt-4 space-y-6">
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
                <KommoExplorer
                  unitId={selectedId}
                  salesbotId={draft.kommoSalesbotId ?? null}
                  replyFieldId={draft.kommoReplyFieldId ?? null}
                  pausedFieldId={draft.kommoPausedFieldId ?? null}
                  wonStatusIds={draft.kommoWonStatusIds ?? []}
                  onSalesbotChange={(id) => setDraft({ ...draft, kommoSalesbotId: id })}
                  onReplyFieldChange={(id) => setDraft({ ...draft, kommoReplyFieldId: id })}
                  onPausedFieldChange={(id) => setDraft({ ...draft, kommoPausedFieldId: id })}
                  onWonStatusIdsChange={(ids) => setDraft({ ...draft, kommoWonStatusIds: ids })}
                  onSave={handleSave}
                  saving={saving}
                />
                <label className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 mt-3 cursor-pointer hover:bg-amber-500/10 transition-colors">
                  <input
                    type="checkbox"
                    checked={!!draft.kommoBypassSalesbot}
                    onChange={(e) => setDraft({ ...draft, kommoBypassSalesbot: e.target.checked })}
                    className="mt-0.5 accent-amber-500"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-amber-100">
                      ⚠️ Modo "edição manual" — pular o disparo direto do Salesbot
                    </div>
                    <div className="text-[11px] text-amber-200/70 mt-1 leading-relaxed">
                      Quando ligado, em vez de chamar <code className="text-[10px] px-1 rounded bg-zinc-900">POST /salesbot/run</code>,
                      nós só fazemos <code className="text-[10px] px-1 rounded bg-zinc-900">PATCH</code>{' '}
                      no campo "Resposta IA" — exatamente como acontece quando você edita o
                      campo manualmente no Kommo. O Digital Pipeline do Kommo se encarrega de
                      disparar o Salesbot uma única vez. <strong>Resolve casos onde o emoji
                      não chega via API, mas chega na edição manual.</strong>{' '}
                      Pré-requisito: o seu Digital Pipeline tem um gatilho "Quando campo
                      Resposta IA mudar → rodar Salesbot".
                    </div>
                  </div>
                </label>
              </Section>

              {!creating && selectedId && (
                <Section
                  title="Etapas e tags do Kommo"
                  subtitle="Read-only — puxado direto da sua conta. Use os IDs/nomes ao instruir a IA."
                >
                  <KommoSchemaPreview
                    unitId={selectedId}
                    canFetch={
                      !!draft.kommoSubdomain &&
                      !!draft.kommoAccessToken &&
                      // Se o token está mascarado (••••), significa que JÁ foi salvo no
                      // backend. Aí dá pra buscar. Se for vazio ou texto novo não-salvo,
                      // não dá — o endpoint usa o que está no DB.
                      (draft.kommoAccessToken.includes('••••') || draft.kommoAccessToken.length > 0)
                    }
                  />
                </Section>
              )}

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

              <Section
                title="System Prompt (legado)"
                subtitle="⚠️ Não use mais — sobrescrito pela aba 'Configurar IA' + 'Fontes'. Deixe vazio."
              >
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 mb-2 text-[11px] text-amber-100/90 leading-relaxed">
                  <strong>Recomendação:</strong> deixe este campo VAZIO. A personalidade
                  da IA agora é gerada automaticamente pela aba <strong>Configurar IA</strong>{' '}
                  (tom, emojis, idioma, toggles) + os documentos da aba <strong>Fontes</strong>{' '}
                  (papel, produtos, negócio). Se preencher aqui, esse texto vira "instrução
                  extra" injetada depois das Fontes — útil só pra casos avançados.
                </div>
                <textarea
                  value={draft.systemPrompt ?? ''}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  rows={6}
                  placeholder="Deixe vazio — use 'Configurar IA' e 'Fontes' pra montar a persona."
                  className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-2 text-xs text-zinc-200 font-mono"
                />
                {(draft.systemPrompt?.trim().length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => setDraft({ ...draft, systemPrompt: '' })}
                    className="mt-2 text-[11px] text-zinc-400 hover:text-rose-300 underline"
                  >
                    Limpar este campo (recomendado)
                  </button>
                )}
              </Section>

            </div>
          </div>
        </div>
      </div>
    );
  }

  // Grid view — quando nenhuma unidade está sendo editada.
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 pt-10 pb-6">
        {/* Header: título + nova */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex-1" />
          <h1 className="text-2xl font-semibold text-zinc-100 text-center">Escolha uma conta</h1>
          <div className="flex-1 flex justify-end">
            {isSuper && (
              <button
                type="button"
                onClick={startCreate}
                className="text-xs px-3 py-1.5 rounded-md bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/30 inline-flex items-center gap-1.5 hover:bg-brand-500/30"
              >
                <Plus size={13} />
                Nova unidade
              </button>
            )}
          </div>
        </div>

        <div className="max-w-md mx-auto mb-10">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar sua conta"
              className="w-full bg-zinc-900/60 border border-zinc-800 rounded-md text-sm pl-9 pr-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
            />
          </div>
        </div>

        {ctxLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin text-zinc-500" size={18} />
          </div>
        )}

        {!ctxLoading && filteredUnits.length === 0 && (
          <div className="text-center text-sm text-zinc-500 py-12">
            {search ? 'Nenhuma unidade bate com a busca.' : 'Nenhuma unidade ainda.'}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
          {filteredUnits.map((u) => (
            <UnitCard
              key={u.id}
              unit={u}
              onOpen={() => {
                setCreating(false);
                setSelectedId(u.id);
              }}
              onClone={() => void handleClone(u)}
              onDelete={() => void handleDelete(u)}
              menuOpen={openMenuId === u.id}
              onMenuToggle={(e) => {
                e.stopPropagation();
                setOpenMenuId(openMenuId === u.id ? null : u.id);
              }}
              cloning={cloningId === u.id}
              canEdit={isSuper || user?.unitId === u.id}
              canDelete={isSuper}
              canClone={isSuper}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnitCard — card circular do grid "Escolha uma conta".
// ---------------------------------------------------------------------------
function UnitCard({
  unit,
  onOpen,
  onClone,
  onDelete,
  menuOpen,
  onMenuToggle,
  cloning,
  canEdit,
  canDelete,
  canClone,
}: {
  unit: Unit;
  onOpen: () => void;
  onClone: () => void;
  onDelete: () => void;
  menuOpen: boolean;
  onMenuToggle: (e: React.MouseEvent) => void;
  cloning: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canClone: boolean;
}) {
  const showMenu = canClone || canDelete;
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onOpen}
        disabled={!canEdit}
        className="w-full flex flex-col items-center text-center disabled:cursor-not-allowed"
        title={canEdit ? `Editar ${unit.name}` : 'Sem permissão de edição'}
      >
        <div
          className={clsx(
            'relative w-24 h-24 rounded-full bg-zinc-900/60 ring-2 ring-zinc-800 overflow-hidden mb-2 transition',
            canEdit && 'group-hover:ring-brand-500/60 group-hover:shadow-[0_0_24px_rgba(124,77,255,0.18)]',
            !unit.isActive && 'opacity-60',
          )}
        >
          <img
            src={DEFAULT_UNIT_AVATAR}
            alt=""
            className="w-full h-full object-cover p-3"
            referrerPolicy="no-referrer"
          />
          {cloning && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <Loader2 className="animate-spin text-zinc-200" size={20} />
            </div>
          )}
          {!unit.isActive && (
            <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-wider text-amber-300 bg-zinc-950/80 px-1.5 py-0.5 rounded">
              off
            </div>
          )}
        </div>
        <div className="text-xs font-semibold text-zinc-100 uppercase tracking-wide leading-tight px-1 break-words line-clamp-2">
          {unit.name}
        </div>
        <div className="text-[10px] text-zinc-500 mt-0.5 truncate max-w-full">/{unit.slug}</div>
      </button>

      {showMenu && (
        <>
          <button
            type="button"
            onClick={onMenuToggle}
            className="absolute top-0 right-0 p-1.5 rounded-md text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-800/80 hover:text-zinc-200 transition"
            title="Mais ações"
          >
            <MoreVertical size={14} />
          </button>
          {menuOpen && (
            <div
              className="absolute top-7 right-0 z-10 w-36 rounded-md bg-zinc-900 ring-1 ring-zinc-700 shadow-lg py-1"
              onClick={(e) => e.stopPropagation()}
            >
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    onOpen();
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800/60"
                >
                  Editar
                </button>
              )}
              {canClone && (
                <button
                  type="button"
                  onClick={onClone}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800/60 inline-flex items-center gap-2"
                >
                  <Copy size={12} />
                  Clonar
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  className="w-full text-left px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10 inline-flex items-center gap-2"
                >
                  <Trash2 size={12} />
                  Apagar
                </button>
              )}
            </div>
          )}
        </>
      )}
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

