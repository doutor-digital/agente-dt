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
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
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
  KommoPipelinesResponse,
  KommoTagsResponse,
  UnitAction,
  UnitActionInput,
} from '../types/api';

interface DraftAction {
  conditionDescription: string;
  actionKind: ActionKind;
  /** tags como array — picker da Kommo cuida do merge com strings custom. */
  tags: string[];
  /** move_stage params. */
  statusId: number | null;
  pipelineId: number | null;
  statusLabel: string | null;
  includeSummary: boolean;
  notes: string;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftAction = {
  conditionDescription: '',
  actionKind: 'add_tag',
  tags: [],
  statusId: null,
  pipelineId: null,
  statusLabel: null,
  includeSummary: true,
  notes: '',
  enabled: true,
};

function actionToDraft(a: UnitAction): DraftAction {
  const params = a.actionParams ?? {};
  const tagsArr = Array.isArray((params as { tags?: unknown }).tags)
    ? ((params as { tags: string[] }).tags ?? [])
    : [];
  const includeSummary = (params as { includeSummary?: boolean }).includeSummary !== false;
  const statusId =
    typeof (params as { statusId?: unknown }).statusId === 'number'
      ? ((params as { statusId: number }).statusId)
      : null;
  const pipelineId =
    typeof (params as { pipelineId?: unknown }).pipelineId === 'number'
      ? ((params as { pipelineId: number }).pipelineId)
      : null;
  const statusLabel =
    typeof (params as { statusLabel?: unknown }).statusLabel === 'string'
      ? ((params as { statusLabel: string }).statusLabel)
      : null;
  return {
    conditionDescription: a.conditionDescription,
    actionKind: a.actionKind,
    tags: tagsArr,
    statusId,
    pipelineId,
    statusLabel,
    includeSummary,
    notes: a.notes ?? '',
    enabled: a.enabled,
  };
}

function draftToInput(d: DraftAction): UnitActionInput {
  let params: Record<string, unknown>;
  if (d.actionKind === 'add_tag') {
    params = { tags: d.tags };
  } else if (d.actionKind === 'move_stage') {
    params = {
      statusId: d.statusId,
      ...(d.pipelineId ? { pipelineId: d.pipelineId } : {}),
      ...(d.statusLabel ? { statusLabel: d.statusLabel } : {}),
    };
  } else {
    params = { includeSummary: d.includeSummary };
  }
  return {
    conditionDescription: d.conditionDescription.trim(),
    actionKind: d.actionKind,
    actionParams: params,
    notes: d.notes.trim() || null,
    enabled: d.enabled,
  };
}

function isValid(d: DraftAction): boolean {
  if (d.conditionDescription.trim().length < 3) return false;
  if (d.actionKind === 'add_tag' && d.tags.length === 0) return false;
  if (d.actionKind === 'move_stage' && (!d.statusId || d.statusId <= 0)) return false;
  return true;
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

  async function handleSave(draft: DraftAction) {
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
      <div className="max-w-4xl mx-auto p-6 space-y-5">
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

        {/* Lista */}
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
          <ul className="space-y-3">
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
  const kind = KIND_LABEL[action.actionKind] ?? KIND_LABEL.add_tag;
  const Icon = kind.icon;
  const tags = Array.isArray((action.actionParams as { tags?: unknown }).tags)
    ? ((action.actionParams as { tags: string[] }).tags ?? [])
    : [];
  const stageStatusId =
    typeof (action.actionParams as { statusId?: unknown }).statusId === 'number'
      ? (action.actionParams as { statusId: number }).statusId
      : null;
  const stageLabel =
    typeof (action.actionParams as { statusLabel?: unknown }).statusLabel === 'string'
      ? (action.actionParams as { statusLabel: string }).statusLabel
      : null;
  return (
    <li
      className={clsx(
        'rounded-xl border p-4 transition-opacity',
        action.enabled
          ? 'border-zinc-800 bg-zinc-900/40'
          : 'border-zinc-800/50 bg-zinc-900/20 opacity-60',
      )}
    >
      <div className="flex items-start gap-3">
        <div className={clsx('mt-0.5', kind.color)}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
              Quando
            </span>
          </div>
          <p className="text-sm text-zinc-200 leading-relaxed">{action.conditionDescription}</p>

          <div className="mt-3">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
              Fazer
            </span>
            <p className={clsx('text-sm mt-1.5 flex flex-wrap items-center gap-1.5', kind.color)}>
              {kind.label}
              {action.actionKind === 'add_tag' &&
                tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-200 text-[11px] ring-1 ring-amber-500/30 font-mono"
                  >
                    #{t}
                  </span>
                ))}
              {action.actionKind === 'move_stage' && stageStatusId && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-200 text-[11px] ring-1 ring-sky-500/30">
                  → {stageLabel ?? `etapa #${stageStatusId}`}
                </span>
              )}
            </p>
          </div>

          {action.notes && (
            <div className="mt-3">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
                Mais
              </span>
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed italic">{action.notes}</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
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
  initial: DraftAction;
  isEditing: boolean;
  onSave: (d: DraftAction) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DraftAction>(initial);
  const [saving, setSaving] = useState(false);
  const [tagsData, setTagsData] = useState<KommoTagsResponse | null>(null);
  const [pipelinesData, setPipelinesData] = useState<KommoPipelinesResponse | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [loadingKommo, setLoadingKommo] = useState(false);
  const valid = isValid(draft);

  // Carrega tags + pipelines do Kommo ao abrir o modal — lazy, só uma vez.
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
      if ('_err' in t) {
        const e = t._err as { response?: { data?: { message?: string; error?: string } } };
        setTagsError(e?.response?.data?.message ?? e?.response?.data?.error ?? 'falha ao carregar tags do Kommo');
      } else {
        setTagsData(t);
      }
      if ('_err' in p) {
        const e = p._err as { response?: { data?: { message?: string; error?: string } } };
        setPipelinesError(e?.response?.data?.message ?? e?.response?.data?.error ?? 'falha ao carregar etapas do Kommo');
      } else {
        setPipelinesData(p);
      }
      setLoadingKommo(false);
    });
    return () => {
      alive = false;
    };
  }, [unitId]);

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

          {/* Fazer — selector */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5 block">
              Fazer
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(KIND_LABEL) as ActionKind[]).map((k) => {
                const meta = KIND_LABEL[k];
                const Icon = meta.icon;
                const active = draft.actionKind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setDraft({ ...draft, actionKind: k })}
                    className={clsx(
                      'flex items-center gap-2 p-3 rounded-md text-left transition border',
                      active
                        ? 'border-brand-500/40 bg-brand-500/10 text-brand-100'
                        : 'border-zinc-800 bg-zinc-950/30 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700',
                    )}
                  >
                    <Icon size={16} className={active ? 'text-brand-300' : meta.color} />
                    <span className="text-xs font-medium leading-tight">{meta.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Params — add_tag: multi-picker da Kommo + texto custom */}
          {draft.actionKind === 'add_tag' && (
            <TagsPicker
              selected={draft.tags}
              onChange={(tags) => setDraft({ ...draft, tags })}
              available={tagsData?.tags ?? []}
              loading={loadingKommo}
              error={tagsError}
            />
          )}

          {/* Params — move_stage: dropdown agrupado por pipeline */}
          {draft.actionKind === 'move_stage' && (
            <StagePicker
              selectedStatusId={draft.statusId}
              selectedLabel={draft.statusLabel}
              onChange={(statusId, pipelineId, label) =>
                setDraft({ ...draft, statusId, pipelineId, statusLabel: label })
              }
              pipelines={pipelinesForSelect}
              loading={loadingKommo}
              error={pipelinesError}
            />
          )}

          {(draft.actionKind === 'transfer_with_permission' ||
            draft.actionKind === 'transfer_without_permission') && (
            <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.includeSummary}
                onChange={(e) => setDraft({ ...draft, includeSummary: e.target.checked })}
                className="accent-brand-500"
              />
              Incluir resumo da conversa pra o operador humano
            </label>
          )}

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

  // Set pra checagem rápida + preservação de ordem do selected.
  const selectedSet = useMemo(() => new Set(selected.map((s) => s.toLowerCase())), [selected]);

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
        {!loading && !error && available.length > 0 && (
          <ul className="divide-y divide-zinc-800/40">
            {available.map((t) => {
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
