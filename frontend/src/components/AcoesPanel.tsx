// ============================================================================
// AcoesPanel — construtor visual de regras "quando → faça" pra o agente.
//
// LÓGICA DE ENGENHARIA
// --------------------
// CRUD por cima de UnitAction. Cada regra tem 3 partes:
//
//   - Quando (condição) : descrição semântica em PT-BR — a IA decide quando aplica.
//   - Fazer (ação)      : enum estruturado:
//       * add_tag                     → aplica 1+ tags Kommo
//       * transfer_with_permission    → pede ok ao cliente e transfere
//       * transfer_without_permission → transfere direto (emergência/sentimento)
//   - Mais (notas)      : hint extra opcional pra LLM (frases-gatilho, exceções).
//
// As regras são injetadas pelo backend no system prompt como seção "AÇÕES
// CONFIGURADAS". Sem mágica de matching — é o LLM que decide quando aplicar.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  UserCog,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import type {
  ActionKind,
  ActionStep,
  KommoPipelinesResponse,
  KommoTagsResponse,
  UnitAction,
  UnitActionInput,
} from '../types/api';

/** Forma de UM passo do rascunho. Cada `kind` usa um subset dos campos. */
interface DraftStep {
  kind: ActionKind;
  /** add_tag */
  tags?: string[];
  /** move_stage */
  statusId?: number | null;
  pipelineId?: number | null;
  statusLabel?: string | null;
  /** transfer_* */
  includeSummary?: boolean;
  /** summarize_to_note */
  focusHint?: string;
  /** send_message */
  text?: string;
}

interface DraftRule {
  conditionDescription: string;
  steps: DraftStep[];
  notes: string;
  enabled: boolean;
}

function defaultStep(kind: ActionKind): DraftStep {
  if (kind === 'add_tag') return { kind, tags: [] };
  if (kind === 'move_stage') return { kind, statusId: null, pipelineId: null, statusLabel: null };
  if (kind === 'summarize_to_note') return { kind, focusHint: '' };
  if (kind === 'send_message') return { kind, text: '' };
  return { kind, includeSummary: true };
}

const EMPTY_DRAFT: DraftRule = {
  conditionDescription: '',
  steps: [defaultStep('add_tag')],
  notes: '',
  enabled: true,
};

/** Lê os passos de uma UnitAction (formato novo ou legado). */
function readSteps(a: UnitAction): ActionStep[] {
  if (Array.isArray(a.actions) && a.actions.length > 0) return a.actions;
  if (a.actionKind) return [{ kind: a.actionKind, params: a.actionParams ?? {} }];
  return [];
}

function stepFromAction(s: ActionStep): DraftStep {
  const params = (s.params ?? {}) as Record<string, unknown>;
  if (s.kind === 'add_tag') {
    return { kind: s.kind, tags: Array.isArray(params.tags) ? (params.tags as string[]) : [] };
  }
  if (s.kind === 'move_stage') {
    return {
      kind: s.kind,
      statusId: typeof params.statusId === 'number' ? params.statusId : null,
      pipelineId: typeof params.pipelineId === 'number' ? params.pipelineId : null,
      statusLabel: typeof params.statusLabel === 'string' ? params.statusLabel : null,
    };
  }
  if (s.kind === 'summarize_to_note') {
    return { kind: s.kind, focusHint: typeof params.focusHint === 'string' ? params.focusHint : '' };
  }
  if (s.kind === 'send_message') {
    return { kind: s.kind, text: typeof params.text === 'string' ? params.text : '' };
  }
  return { kind: s.kind, includeSummary: params.includeSummary !== false };
}

function actionToDraft(a: UnitAction): DraftRule {
  const steps = readSteps(a).map(stepFromAction);
  return {
    conditionDescription: a.conditionDescription,
    steps: steps.length > 0 ? steps : [defaultStep('add_tag')],
    notes: a.notes ?? '',
    enabled: a.enabled,
  };
}

function stepToParams(s: DraftStep): Record<string, unknown> {
  if (s.kind === 'add_tag') return { tags: s.tags ?? [] };
  if (s.kind === 'move_stage') {
    return {
      statusId: s.statusId,
      ...(s.pipelineId ? { pipelineId: s.pipelineId } : {}),
      ...(s.statusLabel ? { statusLabel: s.statusLabel } : {}),
    };
  }
  if (s.kind === 'summarize_to_note') {
    return s.focusHint?.trim() ? { focusHint: s.focusHint.trim() } : {};
  }
  if (s.kind === 'send_message') {
    return { text: (s.text ?? '').trim() };
  }
  return { includeSummary: s.includeSummary !== false };
}

function draftToInput(d: DraftRule): UnitActionInput {
  return {
    conditionDescription: d.conditionDescription.trim(),
    actions: d.steps.map((s) => ({ kind: s.kind, params: stepToParams(s) })),
    notes: d.notes.trim() || null,
    enabled: d.enabled,
  };
}

function isStepValid(s: DraftStep): boolean {
  if (s.kind === 'add_tag') return (s.tags?.length ?? 0) > 0;
  if (s.kind === 'move_stage') return !!s.statusId && s.statusId > 0;
  if (s.kind === 'send_message') return !!s.text && s.text.trim().length > 0;
  return true; // transfer_* e summarize_to_note são válidos sem params extras
}

function isValid(d: DraftRule): boolean {
  if (d.conditionDescription.trim().length < 3) return false;
  if (d.steps.length === 0) return false;
  return d.steps.every(isStepValid);
}

const KIND_LABEL: Record<ActionKind, { label: string; icon: typeof Tag; color: string }> = {
  add_tag: { label: 'Adicionar tag(s)', icon: Tag, color: 'text-amber-300' },
  move_stage: { label: 'Mover de etapa', icon: Workflow, color: 'text-sky-300' },
  transfer_with_permission: {
    label: 'Transferir COM permissão',
    icon: UserCog,
    color: 'text-emerald-300',
  },
  transfer_without_permission: {
    label: 'Transferir SEM permissão',
    icon: Zap,
    color: 'text-rose-300',
  },
  summarize_to_note: {
    label: 'Resumir lead pro SDR (nota interna)',
    icon: FileText,
    color: 'text-violet-300',
  },
  send_message: {
    label: 'Enviar mensagem',
    icon: MessageCircle,
    color: 'text-cyan-300',
  },
};

export function AcoesPanel() {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [actions, setActions] = useState<UnitAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<UnitAction | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!selectedUnitId) {
      setActions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listActions(selectedUnitId);
      setActions(list);
    } finally {
      setLoading(false);
    }
  }, [selectedUnitId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(draft: DraftRule) {
    if (!selectedUnitId) return;
    try {
      const input = draftToInput(draft);
      if (editing) {
        const updated = await api.updateAction(selectedUnitId, editing.id, input);
        setActions((cur) => cur.map((a) => (a.id === updated.id ? updated : a)));
        toast.success('Ação atualizada.');
      } else {
        const created = await api.createAction(selectedUnitId, input);
        setActions((cur) => [...cur, created]);
        toast.success('Ação criada.');
      }
      setEditing(null);
      setCreating(false);
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao salvar: ${e?.message ?? 'erro'}`);
    }
  }

  async function handleDelete(action: UnitAction) {
    if (!selectedUnitId) return;
    if (!confirm(`Excluir esta ação?\n\n"${action.conditionDescription.slice(0, 80)}…"`)) return;
    try {
      await api.deleteAction(selectedUnitId, action.id);
      setActions((cur) => cur.filter((a) => a.id !== action.id));
      toast.success('Ação excluída.');
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao excluir: ${e?.message ?? 'erro'}`);
    }
  }

  async function handleToggle(action: UnitAction) {
    if (!selectedUnitId) return;
    try {
      const updated = await api.updateAction(selectedUnitId, action.id, {
        enabled: !action.enabled,
      });
      setActions((cur) => cur.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha: ${e?.message ?? 'erro'}`);
    }
  }

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra configurar as Ações.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold text-zinc-100 tracking-tight flex items-center gap-2">
              <Zap size={22} className="text-brand-300" />
              Ações
            </h1>
            <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
              Regras de "quando o cliente fizer X, a IA faz Y". O agente lê todas as regras a
              cada mensagem e decide se alguma se aplica.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setEditing(null);
            }}
            className="inline-flex items-center gap-2 text-sm px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 text-white font-medium shrink-0"
          >
            <Plus size={14} />
            Nova ação
          </button>
        </div>

        {/* Grid responsivo de cards. Cada card tem largura mínima generosa
            (min 320px) e o grid auto-fit balanceia colunas conforme o viewport:
              - mobile  → 1 coluna
              - tablet  → 2 colunas
              - desktop → 2-3 colunas (a partir de ~1280px aceita 3)
            `auto-rows-fr` força altura igual entre cards na mesma linha pra
            os botões de ação ficarem alinhados horizontalmente. */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-zinc-500">
            <Loader2 className="animate-spin mr-2" size={16} />
            Carregando…
          </div>
        ) : actions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-10 text-center">
            <Zap size={28} className="mx-auto text-zinc-700 mb-3" />
            <p className="text-sm text-zinc-400 mb-1">Nenhuma ação cadastrada ainda.</p>
            <p className="text-xs text-zinc-600">
              Crie regras pra a IA aplicar tags, transferir ou escalar automaticamente.
            </p>
          </div>
        ) : (
          <ul
            className="grid gap-4 auto-rows-fr"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))' }}
          >
            {actions.map((a) => (
              <ActionCard
                key={a.id}
                action={a}
                onEdit={() => {
                  setEditing(a);
                  setCreating(false);
                }}
                onDelete={() => handleDelete(a)}
                onToggle={() => handleToggle(a)}
              />
            ))}
          </ul>
        )}

        {/* Modal de edição/criação */}
        {(creating || editing) && (
          <ActionEditor
            unitId={selectedUnitId}
            initial={editing ? actionToDraft(editing) : EMPTY_DRAFT}
            isEditing={!!editing}
            onSave={handleSave}
            onCancel={() => {
              setEditing(null);
              setCreating(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card de uma ação na lista.
// ---------------------------------------------------------------------------

function ActionCard({
  action,
  onEdit,
  onDelete,
  onToggle,
}: {
  action: UnitAction;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const steps = readSteps(action);
  return (
    <li
      className={clsx(
        // Card em flex-col + `h-full` faz ele ocupar a célula inteira do grid
        // (em conjunto com auto-rows-fr no container). Botões de ação ficam
        // grudados no rodapé via mt-auto, alinhados entre cards.
        'flex flex-col h-full rounded-xl border transition-all hover:border-zinc-700',
        action.enabled
          ? 'border-zinc-800 bg-zinc-900/40'
          : 'border-zinc-800/50 bg-zinc-900/20 opacity-60 hover:opacity-80',
      )}
    >
      {/* Header: status + título Quando */}
      <div className="px-5 pt-5 pb-2 flex items-start justify-between gap-2">
        <span
          className={clsx(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-semibold',
            action.enabled
              ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30'
              : 'bg-zinc-800/50 text-zinc-500 ring-1 ring-zinc-700/50',
          )}
        >
          {action.enabled ? 'Ativa' : 'Inativa'}
        </span>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-600">
          {steps.length} {steps.length === 1 ? 'ação' : 'ações'}
        </span>
      </div>

      {/* Corpo — cresce e empurra o footer pro fim */}
      <div className="px-5 pb-3 flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-1">
          Quando
        </div>
        <p className="text-sm text-zinc-200 leading-relaxed line-clamp-3" title={action.conditionDescription}>
          {action.conditionDescription}
        </p>

        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-1.5">
            Fazer
          </div>
          <ul className="space-y-1.5">
            {steps.map((step, i) => (
              <li key={i}>
                <StepSummary step={step} />
              </li>
            ))}
          </ul>
        </div>

        {action.notes && (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-1">
              Mais
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed italic line-clamp-2" title={action.notes}>
              {action.notes}
            </p>
          </div>
        )}
      </div>

      {/* Footer com botões — `mt-auto` cola no fim quando o card tá curto */}
      <div className="mt-auto px-3 py-2 border-t border-zinc-800/60 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={onToggle}
          title={action.enabled ? 'Desativar' : 'Ativar'}
          className={clsx(
            'p-1.5 rounded hover:bg-zinc-800',
            action.enabled ? 'text-emerald-400' : 'text-zinc-600',
          )}
        >
          <CheckCircle2 size={15} />
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="Editar"
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Excluir"
          className="p-1.5 rounded text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Editor (modal-ish) — usado tanto pra criar quanto pra editar.
// ---------------------------------------------------------------------------

function ActionEditor({
  unitId,
  initial,
  isEditing,
  onSave,
  onCancel,
}: {
  unitId: string | null;
  initial: DraftRule;
  isEditing: boolean;
  onSave: (d: DraftRule) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DraftRule>(initial);
  const [saving, setSaving] = useState(false);
  const [tagsData, setTagsData] = useState<KommoTagsResponse | null>(null);
  const [pipelinesData, setPipelinesData] = useState<KommoPipelinesResponse | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [loadingKommo, setLoadingKommo] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const valid = isValid(draft);

  // Traduz códigos crus do backend pra mensagens úteis ao usuário.
  function friendlyError(raw: string | undefined): string {
    if (!raw) return 'falha ao carregar do Kommo';
    if (raw === 'kommo_not_configured')
      return 'Unidade sem subdomínio/token do Kommo configurado. Vá em Unidades → conecte o Kommo.';
    if (/401|unauthor/i.test(raw))
      return 'Token do Kommo recusado (401). Gere um Long-lived token novo em Unidades.';
    if (/403|forbidden/i.test(raw))
      return 'Sem permissão pra ler tags/etapas (403). Cheque os escopos do token Kommo.';
    return raw;
  }

  // Carrega tags + pipelines do Kommo ao abrir o modal — lazy.
  // `reloadTick` permite recarregar manualmente sem fechar o modal.
  useEffect(() => {
    if (!unitId) return;
    let alive = true;
    setLoadingKommo(true);
    setTagsError(null);
    setPipelinesError(null);
    Promise.all([
      api.kommoTags(unitId).catch((err) => ({ _err: err } as const)),
      api.kommoPipelines(unitId).catch((err) => ({ _err: err } as const)),
    ]).then(([t, p]) => {
      if (!alive) return;
      // Diagnóstico — fica no console pra debug em produção.
      // eslint-disable-next-line no-console
      console.warn('[AcoesPanel] kommo fetch', { unitId, tags: t, pipelines: p });
      if ('_err' in t) {
        const e = t._err as { response?: { data?: { message?: string; error?: string } } };
        setTagsError(friendlyError(e?.response?.data?.message ?? e?.response?.data?.error));
      } else {
        setTagsData(t);
      }
      if ('_err' in p) {
        const e = p._err as { response?: { data?: { message?: string; error?: string } } };
        setPipelinesError(friendlyError(e?.response?.data?.message ?? e?.response?.data?.error));
      } else {
        setPipelinesData(p);
      }
      setLoadingKommo(false);
    });
    return () => {
      alive = false;
    };
  }, [unitId, reloadTick]);

  const tagsCount = tagsData?.tags?.length ?? 0;
  const pipelinesCount = (pipelinesData?.pipelines ?? []).filter((p) => !p.isArchive).length;
  const stagesCount = (pipelinesData?.pipelines ?? []).reduce(
    (acc, p) => acc + (p.isArchive ? 0 : p.statuses.length),
    0,
  );

  // Lista plana de etapas pro dropdown — agrupado por funil no `<optgroup>`.
  const pipelinesForSelect = useMemo(() => {
    return (pipelinesData?.pipelines ?? []).filter((p) => !p.isArchive);
  }, [pipelinesData]);

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl bg-zinc-900 ring-1 ring-zinc-800 shadow-2xl my-8">
        <div className="p-5 border-b border-zinc-800/60">
          <h2 className="text-lg font-display font-bold text-zinc-100">
            {isEditing ? 'Editar ação' : 'Nova ação'}
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Descreva a condição em português natural — a IA decide quando aplicar.
          </p>
        </div>

        <div className="p-5 space-y-4">
          {/* Diagnóstico Kommo — mostra contagem real e botão de recarregar.
              Útil pra distinguir "lista vazia da Kommo" vs "erro de fetch". */}
          <div
            className={clsx(
              'rounded-md text-[11px] px-3 py-2 flex items-center gap-2 border',
              loadingKommo
                ? 'border-zinc-800 bg-zinc-950/40 text-zinc-400'
                : tagsError || pipelinesError
                  ? 'border-amber-500/30 bg-amber-500/5 text-amber-200'
                  : 'border-zinc-800 bg-zinc-950/40 text-zinc-400',
            )}
          >
            {loadingKommo ? (
              <Loader2 size={12} className="animate-spin shrink-0" />
            ) : tagsError || pipelinesError ? (
              <AlertTriangle size={12} className="text-amber-300 shrink-0" />
            ) : (
              <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
            )}
            <span className="flex-1 leading-tight">
              {loadingKommo ? (
                <>Carregando dados do Kommo…</>
              ) : tagsError || pipelinesError ? (
                <>
                  {tagsError && <span className="block">Tags: {tagsError}</span>}
                  {pipelinesError && <span className="block">Etapas: {pipelinesError}</span>}
                </>
              ) : (
                <>
                  Kommo: <strong className="text-zinc-200">{tagsCount}</strong> tag(s),{' '}
                  <strong className="text-zinc-200">{pipelinesCount}</strong> funil(is),{' '}
                  <strong className="text-zinc-200">{stagesCount}</strong> etapa(s) ativas.
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setReloadTick((n) => n + 1)}
              disabled={loadingKommo}
              className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
              title="Recarregar tags e etapas da Kommo"
            >
              <RefreshCw size={11} className={loadingKommo ? 'animate-spin' : ''} />
              Recarregar
            </button>
          </div>

          {/* Quando */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5 block">
              Quando
            </label>
            <textarea
              value={draft.conditionDescription}
              onChange={(e) => setDraft({ ...draft, conditionDescription: e.target.value })}
              rows={3}
              placeholder={
                'ex: paciente mencionar que veio indicado por médico ou profissional de saúde'
              }
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 outline-none transition resize-y"
            />
          </div>

          {/* Fazer — lista de steps. Cada step tem seletor de tipo + params próprios. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
                Fazer ({draft.steps.length} ação{draft.steps.length !== 1 ? 'ões' : ''})
              </label>
              <button
                type="button"
                onClick={() =>
                  setDraft({ ...draft, steps: [...draft.steps, defaultStep('add_tag')] })
                }
                disabled={draft.steps.length >= 8}
                className="text-[11px] inline-flex items-center gap-1 text-brand-300 hover:text-brand-200 disabled:opacity-40"
                title="Adicionar mais uma ação à regra"
              >
                <Plus size={12} /> adicionar ação
              </button>
            </div>
            <p className="text-[11px] text-zinc-500 mb-2">
              Todas as ações da lista disparam JUNTAS quando a IA detectar a condição.
            </p>
            <div className="space-y-3">
              {draft.steps.map((step, idx) => (
                <StepEditor
                  key={idx}
                  index={idx}
                  step={step}
                  canRemove={draft.steps.length > 1}
                  onChange={(next) => {
                    const steps = [...draft.steps];
                    steps[idx] = next;
                    setDraft({ ...draft, steps });
                  }}
                  onRemove={() => {
                    const steps = draft.steps.filter((_, i) => i !== idx);
                    setDraft({ ...draft, steps });
                  }}
                  tagsData={tagsData}
                  pipelinesForSelect={pipelinesForSelect}
                  loadingKommo={loadingKommo}
                  tagsError={tagsError}
                  pipelinesError={pipelinesError}
                />
              ))}
            </div>
          </div>

          {/* Mais */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5 block">
              Mais (opcional)
            </label>
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              placeholder='ex: Frases como "meu médico me indicou", "Dr. X passou seu contato".'
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-700 outline-none transition resize-y"
            />
          </div>

          {/* Enabled toggle */}
          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="accent-emerald-500"
            />
            Ação ativa
          </label>
        </div>

        <div className="p-5 border-t border-zinc-800/60 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!valid || saving}
            className="inline-flex items-center gap-2 text-sm px-4 py-1.5 rounded-md bg-brand-600 hover:bg-brand-500 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {isEditing ? 'Salvar alterações' : 'Criar ação'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TagsPicker — multi-select de tags existentes na conta Kommo + entrada
// livre pra criar tags novas (a tool aplicar_tag aceita string arbitrária).
// ---------------------------------------------------------------------------

function TagsPicker({
  selected,
  onChange,
  available,
  loading,
  error,
}: {
  selected: string[];
  onChange: (tags: string[]) => void;
  available: Array<{ id: number; name: string; color: string | null }>;
  loading: boolean;
  error: string | null;
}) {
  const [customInput, setCustomInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Set pra checagem rápida + preservação de ordem do selected.
  const selectedSet = useMemo(() => new Set(selected.map((s) => s.toLowerCase())), [selected]);

  // Filtra tags por substring case-insensitive do nome.
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return available;
    return available.filter((t) => t.name.toLowerCase().includes(q));
  }, [available, searchQuery]);

  function toggleTag(name: string) {
    const lower = name.toLowerCase();
    if (selectedSet.has(lower)) {
      onChange(selected.filter((s) => s.toLowerCase() !== lower));
    } else {
      onChange([...selected, name]);
    }
  }

  function addCustom() {
    const name = customInput.trim();
    if (!name) return;
    if (selectedSet.has(name.toLowerCase())) {
      setCustomInput('');
      return;
    }
    onChange([...selected, name]);
    setCustomInput('');
  }

  return (
    <div className="space-y-2">
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
        Tags a aplicar
      </label>

      {/* Chips das selecionadas */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-200 text-[11px] ring-1 ring-amber-500/30 font-mono"
            >
              #{t}
              <button
                type="button"
                onClick={() => toggleTag(t)}
                className="hover:text-amber-100"
                title="Remover"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Busca — só aparece se tem o que filtrar */}
      {!loading && !error && available.length > 5 && (
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Buscar entre ${available.length} tags…`}
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md pl-3 pr-7 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
              title="Limpar busca"
            >
              <X size={11} />
            </button>
          )}
        </div>
      )}

      {/* Picker da Kommo */}
      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 max-h-44 overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-[11px] text-zinc-500 inline-flex items-center gap-2">
            <Loader2 className="animate-spin" size={11} />
            Carregando tags da Kommo…
          </div>
        )}
        {error && (
          <div className="px-3 py-2 text-[11px] text-amber-300/80">
            ⚠ {error}. Você ainda pode digitar tags manualmente abaixo.
          </div>
        )}
        {!loading && !error && available.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-zinc-500">
            Nenhuma tag cadastrada na conta Kommo. Use o campo abaixo pra criar uma nova.
          </div>
        )}
        {!loading && !error && available.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-zinc-500">
            Nenhuma tag bate com "{searchQuery}".
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <ul className="divide-y divide-zinc-800/40">
            {filtered.map((t) => {
              const checked = selectedSet.has(t.name.toLowerCase());
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => toggleTag(t.name)}
                    className={clsx(
                      'w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs transition',
                      checked
                        ? 'bg-amber-500/10 text-amber-100'
                        : 'text-zinc-300 hover:bg-zinc-900/50',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      readOnly
                      className="accent-amber-500 pointer-events-none"
                    />
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: t.color ?? '#52525b' }}
                    />
                    <span className="flex-1 truncate">{t.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Custom input (sempre disponível, incluindo no fallback de erro) */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="ou digite uma tag nova (Enter pra adicionar)"
          className="flex-1 bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-700 font-mono outline-none transition"
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={!customInput.trim()}
          className="text-xs px-3 py-1.5 rounded-md bg-zinc-800/80 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          Adicionar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StagePicker — dropdown de etapas agrupadas por funil (vindas da Kommo).
// ---------------------------------------------------------------------------

function StagePicker({
  selectedStatusId,
  selectedLabel,
  onChange,
  pipelines,
  loading,
  error,
}: {
  selectedStatusId: number | null;
  selectedLabel: string | null;
  onChange: (statusId: number | null, pipelineId: number | null, label: string | null) => void;
  pipelines: NonNullable<KommoPipelinesResponse['pipelines']>;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
        Mover pra qual etapa
      </label>

      {loading && (
        <div className="text-[11px] text-zinc-500 inline-flex items-center gap-2">
          <Loader2 className="animate-spin" size={11} />
          Carregando etapas da Kommo…
        </div>
      )}

      {error && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300/90">
          ⚠ {error}. Confira o token do Kommo na unidade.
        </div>
      )}

      {!loading && !error && pipelines.length === 0 && (
        <div className="text-[11px] text-zinc-500">
          Nenhum funil ativo encontrado na conta Kommo.
        </div>
      )}

      {!loading && !error && pipelines.length > 0 && (
        <select
          value={selectedStatusId ?? ''}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            if (!id) {
              onChange(null, null, null);
              return;
            }
            // Acha o pipeline+label correspondente.
            for (const p of pipelines) {
              const s = p.statuses.find((x) => x.id === id);
              if (s) {
                onChange(id, p.id, `${p.name} → ${s.name}`);
                return;
              }
            }
            onChange(id, null, null);
          }}
          className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-200 outline-none transition"
        >
          <option value="">— escolha uma etapa —</option>
          {pipelines.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}

      {selectedStatusId && selectedLabel && (
        <div className="text-[11px] text-zinc-500">
          Atual: <span className="text-sky-300 font-mono">{selectedLabel}</span>
          <span className="text-zinc-700 ml-2">(statusId {selectedStatusId})</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepEditor — UMA ação dentro da regra. Tipo + params + botão de remover.
// Usado pelo ActionEditor que renderiza N StepEditors numa lista.
// ---------------------------------------------------------------------------

function StepEditor({
  index,
  step,
  canRemove,
  onChange,
  onRemove,
  tagsData,
  pipelinesForSelect,
  loadingKommo,
  tagsError,
  pipelinesError,
}: {
  index: number;
  step: DraftStep;
  canRemove: boolean;
  onChange: (next: DraftStep) => void;
  onRemove: () => void;
  tagsData: KommoTagsResponse | null;
  pipelinesForSelect: NonNullable<KommoPipelinesResponse['pipelines']>;
  loadingKommo: boolean;
  tagsError: string | null;
  pipelinesError: string | null;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3 space-y-3">
      {/* Header com índice + remover */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
          Ação #{index + 1}
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-[11px] text-zinc-500 hover:text-rose-300 inline-flex items-center gap-1"
            title="Remover esta ação"
          >
            <X size={11} /> remover
          </button>
        )}
      </div>

      {/* Seletor de tipo */}
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(KIND_LABEL) as ActionKind[]).map((k) => {
          const meta = KIND_LABEL[k];
          const Icon = meta.icon;
          const active = step.kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onChange(defaultStep(k))}
              className={clsx(
                'flex items-center gap-2 p-2.5 rounded-md text-left transition border',
                active
                  ? 'border-brand-500/40 bg-brand-500/10 text-brand-100'
                  : 'border-zinc-800 bg-zinc-950/30 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700',
              )}
            >
              <Icon size={14} className={active ? 'text-brand-300' : meta.color} />
              <span className="text-[11px] font-medium leading-tight">{meta.label}</span>
            </button>
          );
        })}
      </div>

      {/* Params por tipo */}
      {step.kind === 'add_tag' && (
        <TagsPicker
          selected={step.tags ?? []}
          onChange={(tags) => onChange({ ...step, tags })}
          available={tagsData?.tags ?? []}
          loading={loadingKommo}
          error={tagsError}
        />
      )}
      {step.kind === 'move_stage' && (
        <StagePicker
          selectedStatusId={step.statusId ?? null}
          selectedLabel={step.statusLabel ?? null}
          onChange={(statusId, pipelineId, label) =>
            onChange({ ...step, statusId, pipelineId, statusLabel: label })
          }
          pipelines={pipelinesForSelect}
          loading={loadingKommo}
          error={pipelinesError}
        />
      )}
      {(step.kind === 'transfer_with_permission' || step.kind === 'transfer_without_permission') && (
        <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={step.includeSummary !== false}
            onChange={(e) => onChange({ ...step, includeSummary: e.target.checked })}
            className="accent-brand-500"
          />
          Incluir resumo da conversa pra o operador humano
        </label>
      )}
      {step.kind === 'summarize_to_note' && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
            Foco do resumo (opcional)
          </label>
          <input
            type="text"
            value={step.focusHint ?? ''}
            onChange={(e) => onChange({ ...step, focusHint: e.target.value })}
            placeholder="ex: foco em queixa clínica e preferência de horário"
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition"
          />
          <p className="text-[10px] text-zinc-600 leading-tight">
            A IA vai gerar um resumo do lead e postar como nota interna no Kommo (paciente NÃO vê).
            Use foco pra direcionar o que destacar. Sem foco, gera resumo equilibrado.
          </p>
        </div>
      )}
      {step.kind === 'send_message' && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
            Mensagem que a IA vai enviar
          </label>
          <textarea
            value={step.text ?? ''}
            onChange={(e) => onChange({ ...step, text: e.target.value })}
            rows={4}
            maxLength={2000}
            placeholder={'ex: Já estou te conectando com nossa equipe de agendamento, só um instante 💚'}
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition resize-y leading-relaxed"
          />
          <div className="flex items-center justify-between text-[10px] leading-tight">
            <p className="text-zinc-600">
              A IA envia <strong className="text-zinc-400">exatamente</strong> esse texto quando a regra bater
              (sem reformular). Pode incluir emoji.
            </p>
            <span className="text-zinc-600 font-mono shrink-0 ml-2">
              {(step.text ?? '').length}/2000
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepSummary — linha visual de UMA ação dentro de uma regra. Usada tanto
// no card da lista quanto no editor.
// ---------------------------------------------------------------------------

function StepSummary({ step }: { step: ActionStep }) {
  const meta = KIND_LABEL[step.kind] ?? KIND_LABEL.add_tag;
  const Icon = meta.icon;
  const params = (step.params ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(params.tags) ? (params.tags as string[]) : [];
  const stageStatusId = typeof params.statusId === 'number' ? params.statusId : null;
  const stageLabel = typeof params.statusLabel === 'string' ? params.statusLabel : null;
  const focusHint = typeof params.focusHint === 'string' ? params.focusHint : null;
  return (
    <div className={clsx('text-sm flex flex-wrap items-center gap-1.5', meta.color)}>
      <Icon size={14} className="shrink-0" />
      <span className="font-medium">{meta.label}</span>
      {step.kind === 'add_tag' &&
        tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-200 text-[11px] ring-1 ring-amber-500/30 font-mono"
          >
            #{t}
          </span>
        ))}
      {step.kind === 'move_stage' && stageStatusId && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-200 text-[11px] ring-1 ring-sky-500/30">
          → {stageLabel ?? `etapa #${stageStatusId}`}
        </span>
      )}
      {step.kind === 'summarize_to_note' && focusHint && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-200 text-[11px] ring-1 ring-violet-500/30 italic">
          foco: {focusHint}
        </span>
      )}
      {step.kind === 'send_message' && typeof params.text === 'string' && params.text.trim() && (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-100 text-[11px] ring-1 ring-cyan-500/30 italic max-w-full"
          title={params.text}
        >
          <span className="truncate">"{params.text.slice(0, 60)}{params.text.length > 60 ? '…' : ''}"</span>
        </span>
      )}
    </div>
  );
}
