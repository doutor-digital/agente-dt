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
import {
  ArrowLeft,
  BrainCircuit,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  KeyRound,
  Loader2,
  MessagesSquare,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  ScrollText,
  Search,
  ShieldCheck,
  Tags,
  Trash2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { Unit, UnitInput } from '../types/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { KommoExplorer } from './KommoExplorer';
import { KommoSchemaPreview } from './KommoSchemaPreview';

const DEFAULT_UNIT_AVATAR = 'https://fiqon.com.br/wp-content/uploads/2025/04/kommo.png';

// 5 versões de visualização da lista de unidades (switcher no topo), todas com
// a CHAVE OPENAI por unidade em destaque. Persistida no navegador.
type UnitsView = 'avatares' | 'cartoes' | 'tabela' | 'chaves' | 'lista';
const UNIT_VIEWS: Array<{ id: UnitsView; label: string }> = [
  { id: 'avatares', label: 'V1 · Avatares' },
  { id: 'cartoes', label: 'V2 · Cartões' },
  { id: 'tabela', label: 'V3 · Tabela' },
  { id: 'chaves', label: 'V4 · Foco na chave' },
  { id: 'lista', label: 'V5 · Lista' },
];

/** Unidade usa chave própria? (vem do `_hasSecrets` mascarado pelo back). */
function hasOwnKey(unit: Unit): boolean {
  return !!unit._hasSecrets?.openaiApiKey;
}

// 5 layouts do FORMULÁRIO de edição da unidade (switcher no topo do editor).
// Persistido no navegador. As seções são as mesmas; muda só o arranjo.
type FormView = 'unico' | 'duas' | 'abas' | 'acordeao' | 'cartoes';
const FORM_VIEWS: Array<{ id: FormView; label: string }> = [
  { id: 'unico', label: 'V1 · Único' },
  { id: 'duas', label: 'V2 · 2 colunas' },
  { id: 'abas', label: 'V3 · Abas' },
  { id: 'acordeao', label: 'V4 · Acordeão' },
  { id: 'cartoes', label: 'V5 · Cartões' },
];
const META_CHECK_LABELS: Record<string, string> = {
  accessToken: 'Access Token',
  wabaId: 'WABA ID',
  waba: 'WABA acessível',
  phoneNumber: 'Phone Number',
  scopeMessaging: 'Escopo whatsapp_business_management',
  scopeAnalytics: 'Escopo pricing_analytics',
};
function checkLabel(name: string): string {
  return META_CHECK_LABELS[name] ?? name;
}

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
  openaiTopP: 1,
  openaiFrequencyPenalty: 0,
  openaiPresencePenalty: 0,
  openaiMonthlyBudgetUsd: 50,
  metaPhoneNumberId: '',
  metaAccessToken: '',
  metaVerifyToken: '',
  metaAppSecret: '',
  metaWabaId: '',
  metaMonthlyBudgetUsd: 0,
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
    openaiTopP: u.openaiTopP ?? 1,
    openaiFrequencyPenalty: u.openaiFrequencyPenalty ?? 0,
    openaiPresencePenalty: u.openaiPresencePenalty ?? 0,
    openaiMonthlyBudgetUsd: Number(u.openaiMonthlyBudgetUsd ?? 50),
    metaPhoneNumberId: u.metaPhoneNumberId ?? '',
    metaAccessToken: u.metaAccessToken ?? '',
    metaVerifyToken: u.metaVerifyToken ?? '',
    metaAppSecret: u.metaAppSecret ?? '',
    metaWabaId: u.metaWabaId ?? '',
    metaMonthlyBudgetUsd: Number(u.metaMonthlyBudgetUsd ?? 0),
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
  const [view, setView] = useState<UnitsView>(() => {
    try {
      return (localStorage.getItem('unidades:view') as UnitsView) || 'avatares';
    } catch {
      return 'avatares';
    }
  });
  const changeView = (v: UnitsView) => {
    setView(v);
    try {
      localStorage.setItem('unidades:view', v);
    } catch {
      /* ignore */
    }
  };
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [validatingMeta, setValidatingMeta] = useState(false);
  const [metaChecks, setMetaChecks] = useState<
    { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> } | null
  >(null);

  // Layout do formulário de edição (5 versões pra escolher). Persistido.
  const [formView, setFormView] = useState<FormView>(() => {
    try {
      return (localStorage.getItem('unidade:formview') as FormView) || 'abas';
    } catch {
      return 'abas';
    }
  });
  const changeFormView = (v: FormView) => {
    setFormView(v);
    try {
      localStorage.setItem('unidade:formview', v);
    } catch {
      /* ignore */
    }
  };
  const [activeTab, setActiveTab] = useState(0);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  const editing = creating || selectedId !== null;

  useEffect(() => {
    const u = units.find((x) => x.id === selectedId);
    if (u) {
      setDraft(unitToInput(u));
      setCreating(false);
    }
    // Resetar resultado de validação quando trocar de unit ou entrar em "criar".
    setMetaChecks(null);
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

  async function handleValidateMeta() {
    if (!selectedId) {
      toast.error('Salve a unidade antes de validar.');
      return;
    }
    setValidatingMeta(true);
    setMetaChecks(null);
    try {
      // Manda o que está no draft como override — funciona com credenciais
      // novas (não salvas) e ignora os mascarados (••••).
      const res = await api.metaValidate(selectedId, {
        metaWabaId: draft.metaWabaId ?? null,
        metaAccessToken: draft.metaAccessToken ?? null,
        metaPhoneNumberId: draft.metaPhoneNumberId ?? null,
      });
      setMetaChecks(res);
      if (res.ok) toast.success('Credenciais Meta validadas.');
      else toast.error('Algumas checagens falharam — veja detalhes abaixo.');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      toast.error(e?.response?.data?.error ?? e?.message ?? 'erro ao validar');
    } finally {
      setValidatingMeta(false);
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
    const showSchema = !creating && !!selectedId;
    const formSections: FormSection[] = [
      {
        id: 'identidade',
        label: 'Identidade',
        icon: UserRound,
        body: (
          <>
            <Field label="Nome" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
            <Field
              label="Slug (URL)"
              value={draft.slug}
              onChange={(v) => setDraft({ ...draft, slug: v })}
              hint="Aparece em /api/webhooks/{slug}/... — kebab-case"
            />
            <Toggle label="Ativa" value={!!draft.isActive} onChange={(v) => setDraft({ ...draft, isActive: v })} />
          </>
        ),
      },
      {
        id: 'openai',
        label: 'OpenAI & Chave',
        icon: BrainCircuit,
        subtitle: 'Cada unidade tem sua API key, Assistant e orçamento.',
        body: (
          <>
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
            <Field label="Modelo" value={draft.openaiModel ?? ''} onChange={(v) => setDraft({ ...draft, openaiModel: v })} />
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
            <p className="text-[11px] text-zinc-500 mt-1">
              Amostragem avançada (opcional). Padrão Top P 1 e penalties 0 = sem efeito. Use Top P <em>ou</em> Temperature,
              não os dois.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <NumberField
                label="Top P (0–1)"
                value={draft.openaiTopP ?? 1}
                onChange={(v) => setDraft({ ...draft, openaiTopP: v })}
                step={0.05}
                allowZero
              />
              <NumberField
                label="Freq. penalty (-2 a 2)"
                value={draft.openaiFrequencyPenalty ?? 0}
                onChange={(v) => setDraft({ ...draft, openaiFrequencyPenalty: v })}
                step={0.1}
                allowZero
              />
              <NumberField
                label="Presence penalty (-2 a 2)"
                value={draft.openaiPresencePenalty ?? 0}
                onChange={(v) => setDraft({ ...draft, openaiPresencePenalty: v })}
                step={0.1}
                allowZero
              />
            </div>
          </>
        ),
      },
      {
        id: 'kommo',
        label: 'Kommo',
        icon: Cable,
        subtitle: 'Long-Lived Access Token + subdomínio.',
        body: (
          <>
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
                  nós só fazemos <code className="text-[10px] px-1 rounded bg-zinc-900">PATCH</code> no campo "Resposta IA" —
                  exatamente como acontece quando você edita o campo manualmente no Kommo. O Digital Pipeline do Kommo se
                  encarrega de disparar o Salesbot uma única vez. <strong>Resolve casos onde o emoji não chega via API, mas
                  chega na edição manual.</strong> Pré-requisito: o seu Digital Pipeline tem um gatilho "Quando campo Resposta
                  IA mudar → rodar Salesbot".
                </div>
              </div>
            </label>
          </>
        ),
      },
      ...(showSchema
        ? [
            {
              id: 'schema',
              label: 'Etapas & tags',
              icon: Tags,
              subtitle: 'Read-only — puxado direto da sua conta. Use os IDs/nomes ao instruir a IA.',
              body: (
                <KommoSchemaPreview
                  unitId={selectedId}
                  canFetch={
                    !!draft.kommoSubdomain &&
                    !!draft.kommoAccessToken &&
                    (draft.kommoAccessToken.includes('••••') || draft.kommoAccessToken.length > 0)
                  }
                />
              ),
            } as FormSection,
          ]
        : []),
      {
        id: 'meta',
        label: 'Meta WhatsApp',
        icon: MessagesSquare,
        subtitle:
          'Acesso à Graph API pra puxar custo (pricing_analytics) e métricas de template. O canal de envio/recepção continua sendo o Kommo.',
        body: (
          <>
            <Field
              label="Phone Number ID"
              value={draft.metaPhoneNumberId ?? ''}
              onChange={(v) => setDraft({ ...draft, metaPhoneNumberId: v })}
              hint="Opcional. Usado só pra check de validação mostrar nome/quality do número."
            />
            <Field
              label="WABA ID"
              value={draft.metaWabaId ?? ''}
              onChange={(v) => setDraft({ ...draft, metaWabaId: v })}
              hint="ID da WhatsApp Business Account. Necessário pra sincronizar custo (pricing_analytics + template_analytics)."
            />
            <Field
              label="Access Token"
              value={draft.metaAccessToken ?? ''}
              onChange={(v) => setDraft({ ...draft, metaAccessToken: v })}
              type="password"
              hint="System User token com escopo whatsapp_business_management."
            />
            <Field
              label="Orçamento mensal Meta (USD)"
              value={String(draft.metaMonthlyBudgetUsd ?? 0)}
              onChange={(v) => setDraft({ ...draft, metaMonthlyBudgetUsd: Number(v) || 0 })}
              type="number"
              hint="Limite mensal de gasto WhatsApp em USD. Dispara alertas 70/90/100% no painel."
            />
            <div className="mt-3 pt-3 border-t border-zinc-800/60 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-zinc-500 leading-relaxed">
                  Valida WABA, Phone Number, escopo de envio e escopo de analytics direto na Graph API. Não salva — use
                  depois de preencher pra confirmar que vai funcionar.
                </div>
                <button
                  type="button"
                  onClick={() => void handleValidateMeta()}
                  disabled={validatingMeta || !selectedId}
                  title={!selectedId ? 'Salve a unidade antes de validar' : 'Validar credenciais na Graph API'}
                  className="shrink-0 text-xs px-3 py-1.5 rounded inline-flex items-center gap-1.5 bg-emerald-600/30 ring-1 ring-emerald-500/40 text-emerald-200 hover:bg-emerald-600/40 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {validatingMeta ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  Validar credenciais
                </button>
              </div>
              {metaChecks && (
                <div
                  className={clsx(
                    'rounded-md ring-1 px-3 py-2 space-y-1.5',
                    metaChecks.ok ? 'bg-emerald-500/5 ring-emerald-500/30' : 'bg-amber-500/5 ring-amber-500/30',
                  )}
                >
                  {metaChecks.checks.map((c) => (
                    <div key={c.name} className="flex items-start gap-2 text-[11px]">
                      {c.ok ? (
                        <CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle size={13} className="text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1">
                        <div className={clsx('font-medium', c.ok ? 'text-emerald-200' : 'text-rose-200')}>
                          {checkLabel(c.name)}
                        </div>
                        {c.detail && <div className="text-zinc-400 break-all">{c.detail}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ),
      },
      {
        id: 'prompt',
        label: 'System Prompt',
        icon: ScrollText,
        subtitle: "⚠️ Não use mais — sobrescrito pela aba 'Configurar IA' + 'Fontes'. Deixe vazio.",
        body: (
          <>
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 mb-2 text-[11px] text-amber-100/90 leading-relaxed">
              <strong>Recomendação:</strong> deixe este campo VAZIO. A personalidade da IA agora é gerada automaticamente
              pela aba <strong>Configurar IA</strong> (tom, emojis, idioma, toggles) + os documentos da aba{' '}
              <strong>Fontes</strong> (papel, produtos, negócio). Se preencher aqui, esse texto vira "instrução extra"
              injetada depois das Fontes — útil só pra casos avançados.
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
          </>
        ),
      },
    ];
    const containerMax = formView === 'duas' || formView === 'cartoes' ? 'max-w-5xl' : 'max-w-3xl';
    return (
      <div className="flex-1 overflow-y-auto">
        <div className={clsx('mx-auto px-6 py-6', containerMax)}>
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

            {/* Switcher de layout do formulário — 5 versões pra escolher */}
            <div className="flex items-center justify-center pt-4 mb-5">
              <div className="flex items-center gap-1 bg-zinc-900/40 ring-1 ring-white/10 rounded-full p-1 w-fit backdrop-blur overflow-x-auto">
                {FORM_VIEWS.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => changeFormView(v.id)}
                    className={clsx(
                      'text-xs px-3 py-1.5 rounded-full font-medium transition whitespace-nowrap',
                      formView === v.id ? 'bg-brand-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-100',
                    )}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <FormSections
              view={formView}
              sections={formSections}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              openSections={openSections}
              setOpenSections={setOpenSections}
            />
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

        {/* Switcher de visualização — 5 versões, todas com a chave OpenAI por unidade em destaque */}
        {!ctxLoading && filteredUnits.length > 0 && (
          <div className="flex items-center justify-center mb-8">
            <div className="flex items-center gap-1 bg-zinc-900/40 ring-1 ring-white/10 rounded-full p-1 w-fit backdrop-blur overflow-x-auto">
              {UNIT_VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => changeView(v.id)}
                  className={clsx(
                    'text-xs px-3 py-1.5 rounded-full font-medium transition whitespace-nowrap',
                    view === v.id ? 'bg-brand-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-100',
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        )}

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

        {!ctxLoading && filteredUnits.length > 0 && (
          <UnitsListView
            view={view}
            units={filteredUnits}
            isSuper={isSuper}
            cloningId={cloningId}
            canEdit={(u) => isSuper || user?.unitId === u.id}
            onOpen={(u) => {
              setCreating(false);
              setSelectedId(u.id);
            }}
            onClone={(u) => void handleClone(u)}
            onDelete={(u) => void handleDelete(u)}
            onKeySaved={() => void refresh()}
            menuOpenId={openMenuId}
            onMenuToggle={(u, e) => {
              e.stopPropagation();
              setOpenMenuId(openMenuId === u.id ? null : u.id);
            }}
          />
        )}
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
  onKeySaved,
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
  onKeySaved: () => void;
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

      <div className="mt-1.5 flex justify-center">
        <InlineKeyEditor unit={unit} onSaved={onKeySaved} />
      </div>

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
// CHAVE OPENAI por unidade — editor inline reaproveitado por todas as views.
// Mostra o status (própria vs compartilhada) num chip clicável que expande um
// popover pra definir/trocar a chave, ou voltar pra compartilhada (envia null).
// Vazio no back = cai na chave única do servidor (resolveOpenAIApiKey).
// ---------------------------------------------------------------------------
function InlineKeyEditor({
  unit,
  onSaved,
  align = 'left',
}: {
  unit: Unit;
  onSaved: () => void;
  align?: 'left' | 'right';
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const own = hasOwnKey(unit);

  async function save(next: string | null) {
    setSaving(true);
    try {
      await api.updateUnit(unit.id, { openaiApiKey: next });
      toast.success(next ? 'Chave própria salva ✓' : 'Voltou pra chave compartilhada');
      setValue('');
      setOpen(false);
      onSaved();
    } catch {
      toast.error('Erro ao salvar a chave');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={clsx(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 transition',
          own
            ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-500/20'
            : 'bg-zinc-700/30 text-zinc-400 ring-zinc-600/40 hover:text-zinc-200',
        )}
        title={
          own
            ? 'Chave própria configurada — clique pra trocar'
            : 'Usando a chave compartilhada — clique pra definir uma própria'
        }
      >
        <KeyRound size={10} />
        {own ? 'Chave própria' : 'Compartilhada'}
        <Pencil size={9} className="opacity-60" />
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className={clsx(
            'absolute z-20 mt-1 w-64 rounded-lg bg-zinc-900 ring-1 ring-zinc-700 shadow-xl p-3 space-y-2',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div className="text-[11px] text-zinc-400 leading-snug">
            Chave OpenAI desta unidade. Vazio = usa a chave compartilhada do servidor.
          </div>
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={own ? 'Nova chave sk-proj-…' : 'sk-proj-…'}
            className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={saving || value.trim().length < 8}
              onClick={() => void save(value.trim())}
              className="flex-1 text-[11px] px-2 py-1.5 rounded-md bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/30 inline-flex items-center justify-center gap-1 hover:bg-brand-500/30 disabled:opacity-40"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              Salvar
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValue('');
              }}
              className="text-[11px] px-2 py-1.5 rounded-md text-zinc-400 ring-1 ring-zinc-700 hover:text-zinc-200"
              title="Cancelar"
            >
              <X size={11} />
            </button>
          </div>
          {own && (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(null)}
              className="w-full text-[10px] text-zinc-500 hover:text-amber-300 inline-flex items-center justify-center gap-1 pt-0.5"
            >
              <RotateCcw size={10} />
              Voltar pra chave compartilhada
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx(
        'p-1.5 rounded-md ring-1 transition disabled:opacity-30',
        danger
          ? 'text-rose-300 ring-rose-500/20 hover:bg-rose-500/10'
          : 'text-zinc-400 ring-zinc-700/60 hover:text-zinc-100 hover:bg-zinc-800/60',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// As 5 VISUALIZAÇÕES. UnitsListView despacha pra variante escolhida no switcher.
// V1 Avatares = UnitCard (acima, com chip de chave). V2-V5 abaixo.
// ---------------------------------------------------------------------------
interface ViewProps {
  units: Unit[];
  isSuper: boolean;
  cloningId: string | null;
  canEdit: (u: Unit) => boolean;
  onOpen: (u: Unit) => void;
  onClone: (u: Unit) => void;
  onDelete: (u: Unit) => void;
  onKeySaved: () => void;
}

function UnitsListView(
  props: ViewProps & {
    view: UnitsView;
    menuOpenId: string | null;
    onMenuToggle: (u: Unit, e: React.MouseEvent) => void;
  },
) {
  const { view, menuOpenId, onMenuToggle, ...rest } = props;
  if (view === 'cartoes') return <UnitsCards {...rest} />;
  if (view === 'tabela') return <UnitsTable {...rest} />;
  if (view === 'chaves') return <UnitsKeyFocus {...rest} />;
  if (view === 'lista') return <UnitsList {...rest} />;
  // V1 · Avatares — cards circulares com dropdown (preserva o comportamento antigo).
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
      {rest.units.map((u) => (
        <UnitCard
          key={u.id}
          unit={u}
          onOpen={() => rest.onOpen(u)}
          onClone={() => rest.onClone(u)}
          onDelete={() => rest.onDelete(u)}
          onKeySaved={rest.onKeySaved}
          menuOpen={menuOpenId === u.id}
          onMenuToggle={(e) => onMenuToggle(u, e)}
          cloning={rest.cloningId === u.id}
          canEdit={rest.canEdit(u)}
          canDelete={rest.isSuper}
          canClone={rest.isSuper}
        />
      ))}
    </div>
  );
}

// V2 — Cartões retangulares com avatar, modelo e chip de chave.
function UnitsCards({ units, isSuper, cloningId, canEdit, onOpen, onClone, onDelete, onKeySaved }: ViewProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {units.map((u) => (
        <div
          key={u.id}
          className={clsx(
            'group relative rounded-xl bg-zinc-900/40 ring-1 ring-zinc-800 p-4 transition hover:ring-brand-500/40 hover:bg-zinc-900/70',
            !u.isActive && 'opacity-60',
          )}
        >
          <button
            type="button"
            disabled={!canEdit(u)}
            onClick={() => onOpen(u)}
            className="w-full text-left disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-3 mb-3">
              <img
                src={DEFAULT_UNIT_AVATAR}
                alt=""
                className="w-10 h-10 rounded-lg bg-zinc-950/60 object-contain p-1.5 ring-1 ring-zinc-800 shrink-0"
                referrerPolicy="no-referrer"
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-100 truncate">{u.name}</div>
                <div className="text-[10px] text-zinc-500 truncate">/{u.slug}</div>
              </div>
              {cloningId === u.id && <Loader2 className="animate-spin text-zinc-400 ml-auto shrink-0" size={14} />}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-zinc-500 mb-3">
              <span className="rounded bg-zinc-800/60 px-1.5 py-0.5">{u.openaiModel}</span>
              {!u.isActive && <span className="text-amber-300">inativa</span>}
            </div>
          </button>
          <div className="flex items-center justify-between gap-2">
            <InlineKeyEditor unit={u} onSaved={onKeySaved} />
            {isSuper && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                <IconBtn title="Clonar" onClick={() => onClone(u)}>
                  <Copy size={13} />
                </IconBtn>
                <IconBtn title="Apagar" danger onClick={() => onDelete(u)}>
                  <Trash2 size={13} />
                </IconBtn>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// V3 — Tabela enterprise.
function UnitsTable({ units, isSuper, canEdit, onOpen, onClone, onDelete, onKeySaved }: ViewProps) {
  return (
    <div className="rounded-xl ring-1 ring-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 bg-zinc-900/60">
            <th className="px-4 py-2.5 font-medium">Unidade</th>
            <th className="px-4 py-2.5 font-medium">Modelo</th>
            <th className="px-4 py-2.5 font-medium">Chave OpenAI</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium text-right">Ações</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60">
          {units.map((u) => (
            <tr key={u.id} className={clsx('hover:bg-zinc-900/40 transition', !u.isActive && 'opacity-60')}>
              <td className="px-4 py-2.5">
                <button
                  type="button"
                  disabled={!canEdit(u)}
                  onClick={() => onOpen(u)}
                  className="text-left disabled:cursor-not-allowed"
                >
                  <div className="text-zinc-100 font-medium hover:text-brand-200">{u.name}</div>
                  <div className="text-[10px] text-zinc-500">/{u.slug}</div>
                </button>
              </td>
              <td className="px-4 py-2.5 text-zinc-400 text-xs whitespace-nowrap">{u.openaiModel}</td>
              <td className="px-4 py-2.5">
                <InlineKeyEditor unit={u} onSaved={onKeySaved} />
              </td>
              <td className="px-4 py-2.5">
                <span className={clsx('text-[10px]', u.isActive ? 'text-emerald-300' : 'text-amber-300')}>
                  {u.isActive ? '● ativa' : '○ inativa'}
                </span>
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center justify-end gap-1">
                  <IconBtn title="Editar" disabled={!canEdit(u)} onClick={() => onOpen(u)}>
                    <Pencil size={13} />
                  </IconBtn>
                  {isSuper && (
                    <IconBtn title="Clonar" onClick={() => onClone(u)}>
                      <Copy size={13} />
                    </IconBtn>
                  )}
                  {isSuper && (
                    <IconBtn title="Apagar" danger onClick={() => onDelete(u)}>
                      <Trash2 size={13} />
                    </IconBtn>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// V4 — Foco na chave: ícone grande de chave + status por unidade.
function UnitsKeyFocus({ units, isSuper, canEdit, onOpen, onClone, onDelete, onKeySaved }: ViewProps) {
  const ownCount = units.filter(hasOwnKey).length;
  return (
    <div className="space-y-3">
      <div className="text-center text-[11px] text-zinc-500">
        {ownCount} de {units.length} unidades com chave própria · as demais usam a chave compartilhada do servidor
      </div>
      {units.map((u) => {
        const own = hasOwnKey(u);
        return (
          <div
            key={u.id}
            className={clsx(
              'flex items-center gap-4 rounded-xl bg-zinc-900/40 ring-1 p-4 transition',
              own ? 'ring-emerald-500/20' : 'ring-zinc-800',
              !u.isActive && 'opacity-60',
            )}
          >
            <div
              className={clsx(
                'shrink-0 w-11 h-11 rounded-full grid place-items-center ring-1',
                own ? 'bg-emerald-500/10 ring-emerald-500/30 text-emerald-300' : 'bg-zinc-800/60 ring-zinc-700 text-zinc-500',
              )}
            >
              <KeyRound size={18} />
            </div>
            <button
              type="button"
              disabled={!canEdit(u)}
              onClick={() => onOpen(u)}
              className="text-left min-w-0 flex-1 disabled:cursor-not-allowed"
            >
              <div className="text-sm font-semibold text-zinc-100 truncate">{u.name}</div>
              <div className="text-[11px] text-zinc-500 truncate">
                {own ? 'Chave própria configurada' : 'Sem chave própria — usando a compartilhada'} · {u.openaiModel}
              </div>
            </button>
            <InlineKeyEditor unit={u} onSaved={onKeySaved} align="right" />
            {isSuper && (
              <div className="flex items-center gap-1 shrink-0">
                <IconBtn title="Clonar" onClick={() => onClone(u)}>
                  <Copy size={13} />
                </IconBtn>
                <IconBtn title="Apagar" danger onClick={() => onDelete(u)}>
                  <Trash2 size={13} />
                </IconBtn>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// V5 — Lista compacta.
function UnitsList({ units, isSuper, canEdit, onOpen, onClone, onDelete, onKeySaved }: ViewProps) {
  return (
    <div className="rounded-xl ring-1 ring-zinc-800 divide-y divide-zinc-800/60">
      {units.map((u) => (
        <div
          key={u.id}
          className={clsx('flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-900/40 transition', !u.isActive && 'opacity-60')}
        >
          <button
            type="button"
            disabled={!canEdit(u)}
            onClick={() => onOpen(u)}
            className="text-left min-w-0 flex-1 flex items-center gap-2 disabled:cursor-not-allowed"
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', u.isActive ? 'bg-emerald-400' : 'bg-zinc-600')} />
            <span className="text-sm text-zinc-100 truncate hover:text-brand-200">{u.name}</span>
            <span className="text-[10px] text-zinc-600 truncate">/{u.slug}</span>
          </button>
          <InlineKeyEditor unit={u} onSaved={onKeySaved} align="right" />
          {isSuper && (
            <div className="flex items-center gap-1 shrink-0">
              <IconBtn title="Clonar" onClick={() => onClone(u)}>
                <Copy size={13} />
              </IconBtn>
              <IconBtn title="Apagar" danger onClick={() => onDelete(u)}>
                <Trash2 size={13} />
              </IconBtn>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// As 5 versões de LAYOUT do formulário. FormSections recebe as mesmas seções
// e só muda o arranjo conforme o switcher (Único, 2 colunas, Abas, Acordeão,
// Cartões). Persistência/handlers ficam no UnitsPanel (closure nas `body`).
// ---------------------------------------------------------------------------
interface FormSection {
  id: string;
  label: string;
  icon: LucideIcon;
  subtitle?: string;
  body: React.ReactNode;
}

function FormSections({
  view,
  sections,
  activeTab,
  setActiveTab,
  openSections,
  setOpenSections,
}: {
  view: FormView;
  sections: FormSection[];
  activeTab: number;
  setActiveTab: (i: number) => void;
  openSections: Record<string, boolean>;
  setOpenSections: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) {
  // V3 · Abas — uma seção por vez.
  if (view === 'abas') {
    const idx = Math.min(activeTab, sections.length - 1);
    const active = sections[idx];
    return (
      <div className="unidade-tabs">
        {/* Animações "lottie-like" escopadas só nesta página (prefixo .utab*). */}
        <style>{`
          .utab svg { transition: transform .25s ease, filter .25s ease, color .25s ease; }
          .utab:hover svg { transform: scale(1.18) rotate(-4deg); filter: drop-shadow(0 0 6px rgba(124,77,255,.55)); }
          .utab-active svg {
            color: #a78bfa;
            filter: drop-shadow(0 0 8px rgba(124,77,255,.75));
            stroke-dasharray: 64;
            animation: utabDraw .6s cubic-bezier(.65,0,.35,1) forwards;
          }
          @keyframes utabDraw {
            0%   { stroke-dashoffset: 64; opacity: .3; transform: rotate(-15deg) scale(.85); }
            55%  { opacity: 1; }
            100% { stroke-dashoffset: 0; opacity: 1; transform: rotate(0) scale(1); }
          }
          .utab-underline {
            position: absolute; left: 12%; right: 12%; bottom: -1px; height: 2px; border-radius: 2px;
            background: linear-gradient(90deg, transparent, #7c4dff, transparent);
            box-shadow: 0 0 8px 1px rgba(124,77,255,.7);
            transform-origin: center; animation: utabUnder .35s ease forwards;
          }
          @keyframes utabUnder { from { transform: scaleX(0); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
          .utab-content { animation: utabIn .32s cubic-bezier(.22,1,.36,1); }
          @keyframes utabIn { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
        `}</style>
        <div className="relative flex items-center gap-1 overflow-x-auto border-b border-zinc-800 mb-5">
          {sections.map((s, i) => {
            const Icon = s.icon;
            const isActive = i === idx;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveTab(i)}
                className={clsx(
                  'utab relative inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-medium whitespace-nowrap transition-colors -mb-px',
                  isActive ? 'utab-active text-brand-200' : 'text-zinc-400 hover:text-zinc-100',
                )}
              >
                <Icon size={16} />
                {s.label}
                {isActive && <span className="utab-underline" />}
              </button>
            );
          })}
        </div>
        {active && (
          <div key={active.id} className="utab-content">
            <Section title={active.label} subtitle={active.subtitle} icon={active.icon}>
              {active.body}
            </Section>
          </div>
        )}
      </div>
    );
  }

  // V4 · Acordeão — seções colapsáveis.
  if (view === 'acordeao') {
    return (
      <div className="space-y-2">
        {sections.map((s, i) => {
          const Icon = s.icon;
          const open = openSections[s.id] ?? i === 0;
          return (
            <div key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-900/30 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenSections((prev) => ({ ...prev, [s.id]: !(prev[s.id] ?? i === 0) }))}
                className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-zinc-900/50 transition"
              >
                <Icon size={15} className="text-brand-300 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-zinc-100">{s.label}</div>
                  {s.subtitle && !open && <div className="text-[11px] text-zinc-500 truncate">{s.subtitle}</div>}
                </div>
                <ChevronDown size={16} className={clsx('text-zinc-500 transition-transform shrink-0', open && 'rotate-180')} />
              </button>
              {open && (
                <div className="px-4 pb-4 pt-1 space-y-3">
                  {s.subtitle && <p className="text-[11px] text-zinc-500 -mt-1 mb-2">{s.subtitle}</p>}
                  {s.body}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // V2 · 2 colunas (masonry) | V5 · Cartões (grid) | V1 · Único (pilha).
  const layoutClass =
    view === 'duas'
      ? 'columns-1 lg:columns-2 gap-5 [&>*]:mb-5 [&>*]:break-inside-avoid'
      : view === 'cartoes'
        ? 'grid grid-cols-1 md:grid-cols-2 gap-4 items-start'
        : 'space-y-6';
  return (
    <div className={layoutClass}>
      {sections.map((s) => (
        <Section key={s.id} title={s.label} subtitle={s.subtitle} icon={s.icon}>
          {s.body}
        </Section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pequenos helpers de UI
// ---------------------------------------------------------------------------

function Section({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="mb-3 flex items-start gap-2">
        {Icon && <Icon size={15} className="text-brand-300 shrink-0 mt-0.5" />}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
          {subtitle && <p className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</p>}
        </div>
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
  type?: 'text' | 'password' | 'number';
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

