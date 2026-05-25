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
  ArrowDown,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Compass,
  FileText,
  Flag,
  GitBranch,
  Loader2,
  MessageCircle,
  PauseCircle,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  TagsIcon,
  Trash2,
  UserCheck,
  UserCog,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { useKommoMeta } from '../context/KommoMetaContext';
import type {
  ActionKind,
  ActionStep,
  KommoLossReasonsResponse,
  KommoPipelinesResponse,
  KommoTagsResponse,
  KommoUsersResponse,
  UnitAction,
  UnitActionInput,
} from '../types/api';

/** Forma de UM passo do rascunho. Cada `kind` usa um subset dos campos. */
interface DraftStep {
  kind: ActionKind;
  /** add_tag */
  tags?: string[];
  /** move_stage + move_pipeline */
  statusId?: number | null;
  pipelineId?: number | null;
  statusLabel?: string | null;
  pipelineLabel?: string | null;
  /** transfer_* */
  includeSummary?: boolean;
  /** summarize_to_note */
  focusHint?: string;
  /** send_message */
  text?: string;
  /** respond_with_intent */
  instruction?: string;
  /** create_task */
  deadlineMinutes?: number;
  responsibleUserId?: number | null;
  responsibleUserName?: string | null;
  /** assign_responsible */
  userId?: number | null;
  userName?: string | null;
  /** remove_tag */
  singleTag?: string;
  /** set_lead_value */
  price?: number;
  /** mark_lead_status */
  status?: 'won' | 'lost';
  lossReasonId?: number | null;
  lossReasonLabel?: string | null;
  /** pause_ai */
  moveToStageId?: number | null;
  moveToPipelineId?: number | null;
  moveToStageLabel?: string | null;
  /** pause_in_stages — lista de etapas que pausam a IA (multi-stage). */
  pausedStages?: Array<{
    statusId: number;
    pipelineId?: number;
    statusLabel?: string;
    pipelineLabel?: string;
  }>;
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
  if (kind === 'respond_with_intent') return { kind, instruction: '' };
  if (kind === 'create_task') return { kind, text: '', deadlineMinutes: 60, responsibleUserId: null, responsibleUserName: null };
  if (kind === 'assign_responsible') return { kind, userId: null, userName: null };
  if (kind === 'remove_tag') return { kind, singleTag: '' };
  if (kind === 'set_lead_value') return { kind, price: 0 };
  if (kind === 'mark_lead_status') return { kind, status: 'won', lossReasonId: null, lossReasonLabel: null };
  if (kind === 'move_pipeline') return { kind, pipelineId: null, pipelineLabel: null, statusId: null, statusLabel: null };
  if (kind === 'pause_ai') return { kind, moveToStageId: null, moveToPipelineId: null, moveToStageLabel: null };
  if (kind === 'pause_in_stages') return { kind, pausedStages: [] };
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
  if (s.kind === 'respond_with_intent') {
    return { kind: s.kind, instruction: typeof params.instruction === 'string' ? params.instruction : '' };
  }
  if (s.kind === 'create_task') {
    return {
      kind: s.kind,
      text: typeof params.text === 'string' ? params.text : '',
      deadlineMinutes: typeof params.deadlineMinutes === 'number' ? params.deadlineMinutes : 60,
      responsibleUserId: typeof params.responsibleUserId === 'number' ? params.responsibleUserId : null,
      responsibleUserName: typeof params.responsibleUserName === 'string' ? params.responsibleUserName : null,
    };
  }
  if (s.kind === 'assign_responsible') {
    return {
      kind: s.kind,
      userId: typeof params.userId === 'number' ? params.userId : null,
      userName: typeof params.userName === 'string' ? params.userName : null,
    };
  }
  if (s.kind === 'remove_tag') {
    return { kind: s.kind, singleTag: typeof params.tag === 'string' ? params.tag : '' };
  }
  if (s.kind === 'set_lead_value') {
    return { kind: s.kind, price: typeof params.price === 'number' ? params.price : Number(params.price) || 0 };
  }
  if (s.kind === 'mark_lead_status') {
    const status: 'won' | 'lost' = params.status === 'lost' ? 'lost' : 'won';
    return {
      kind: s.kind,
      status,
      lossReasonId: typeof params.lossReasonId === 'number' ? params.lossReasonId : null,
      lossReasonLabel: typeof params.lossReasonLabel === 'string' ? params.lossReasonLabel : null,
    };
  }
  if (s.kind === 'move_pipeline') {
    return {
      kind: s.kind,
      pipelineId: typeof params.pipelineId === 'number' ? params.pipelineId : null,
      pipelineLabel: typeof params.pipelineLabel === 'string' ? params.pipelineLabel : null,
      statusId: typeof params.statusId === 'number' ? params.statusId : null,
      statusLabel: typeof params.statusLabel === 'string' ? params.statusLabel : null,
    };
  }
  if (s.kind === 'pause_ai') {
    return {
      kind: s.kind,
      moveToStageId: typeof params.moveToStageId === 'number' ? params.moveToStageId : null,
      moveToPipelineId: typeof params.moveToPipelineId === 'number' ? params.moveToPipelineId : null,
      moveToStageLabel: typeof params.moveToStageLabel === 'string' ? params.moveToStageLabel : null,
    };
  }
  if (s.kind === 'pause_in_stages') {
    const raw = Array.isArray(params.stages) ? (params.stages as Array<Record<string, unknown>>) : [];
    return {
      kind: s.kind,
      pausedStages: raw
        .filter((it) => typeof it.statusId === 'number' && (it.statusId as number) > 0)
        .map((it) => ({
          statusId: it.statusId as number,
          pipelineId: typeof it.pipelineId === 'number' ? (it.pipelineId as number) : undefined,
          statusLabel: typeof it.statusLabel === 'string' ? (it.statusLabel as string) : undefined,
          pipelineLabel: typeof it.pipelineLabel === 'string' ? (it.pipelineLabel as string) : undefined,
        })),
    };
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
  if (s.kind === 'respond_with_intent') {
    return { instruction: (s.instruction ?? '').trim() };
  }
  if (s.kind === 'create_task') {
    return {
      text: (s.text ?? '').trim(),
      deadlineMinutes: s.deadlineMinutes ?? 60,
      ...(s.responsibleUserId ? { responsibleUserId: s.responsibleUserId } : {}),
      ...(s.responsibleUserName ? { responsibleUserName: s.responsibleUserName } : {}),
    };
  }
  if (s.kind === 'assign_responsible') {
    return {
      userId: s.userId ?? 0,
      ...(s.userName ? { userName: s.userName } : {}),
    };
  }
  if (s.kind === 'remove_tag') {
    return { tag: (s.singleTag ?? '').trim() };
  }
  if (s.kind === 'set_lead_value') {
    return { price: typeof s.price === 'number' ? s.price : Number(s.price) || 0 };
  }
  if (s.kind === 'mark_lead_status') {
    return {
      status: s.status ?? 'won',
      ...(s.lossReasonId ? { lossReasonId: s.lossReasonId } : {}),
      ...(s.lossReasonLabel ? { lossReasonLabel: s.lossReasonLabel } : {}),
    };
  }
  if (s.kind === 'move_pipeline') {
    return {
      pipelineId: s.pipelineId ?? 0,
      ...(s.pipelineLabel ? { pipelineLabel: s.pipelineLabel } : {}),
      ...(s.statusId ? { statusId: s.statusId } : {}),
      ...(s.statusLabel ? { statusLabel: s.statusLabel } : {}),
    };
  }
  if (s.kind === 'pause_ai') {
    return {
      ...(s.moveToStageId ? { moveToStageId: s.moveToStageId } : {}),
      ...(s.moveToPipelineId ? { moveToPipelineId: s.moveToPipelineId } : {}),
      ...(s.moveToStageLabel ? { moveToStageLabel: s.moveToStageLabel } : {}),
    };
  }
  if (s.kind === 'pause_in_stages') {
    return { stages: s.pausedStages ?? [] };
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
  if (s.kind === 'respond_with_intent') return !!s.instruction && s.instruction.trim().length >= 5;
  if (s.kind === 'create_task')
    return !!s.text && s.text.trim().length >= 3 && !!s.deadlineMinutes && s.deadlineMinutes > 0;
  if (s.kind === 'assign_responsible') return !!s.userId && s.userId > 0;
  if (s.kind === 'remove_tag') return !!s.singleTag && s.singleTag.trim().length > 0;
  if (s.kind === 'set_lead_value') return typeof s.price === 'number' && s.price >= 0;
  if (s.kind === 'mark_lead_status') return s.status === 'won' || s.status === 'lost';
  if (s.kind === 'move_pipeline') return !!s.pipelineId && s.pipelineId > 0;
  if (s.kind === 'pause_ai') return true; // pause_ai é sempre válido, etapa é opcional
  if (s.kind === 'pause_in_stages') return (s.pausedStages?.length ?? 0) > 0;
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
    label: 'Enviar mensagem (literal)',
    icon: MessageCircle,
    color: 'text-cyan-300',
  },
  respond_with_intent: {
    label: 'Orientar resposta (intenção)',
    icon: Compass,
    color: 'text-sky-300',
  },
  create_task: {
    label: 'Criar tarefa pro SDR',
    icon: CalendarClock,
    color: 'text-orange-300',
  },
  assign_responsible: {
    label: 'Atribuir responsável',
    icon: UserCheck,
    color: 'text-teal-300',
  },
  remove_tag: {
    label: 'Remover tag',
    icon: TagsIcon,
    color: 'text-stone-300',
  },
  set_lead_value: {
    label: 'Definir valor (R$)',
    icon: CircleDollarSign,
    color: 'text-lime-300',
  },
  mark_lead_status: {
    label: 'Fechar lead (Won/Lost)',
    icon: Flag,
    color: 'text-fuchsia-300',
  },
  move_pipeline: {
    label: 'Mover de funil',
    icon: GitBranch,
    color: 'text-indigo-300',
  },
  pause_ai: {
    label: 'Pausar IA (Salesbot)',
    icon: PauseCircle,
    color: 'text-rose-300',
  },
  pause_in_stages: {
    label: 'Pausar IA em etapas (guard)',
    icon: PauseCircle,
    color: 'text-violet-300',
  },
};

/**
 * Renderiza o painel de ações em dois modos:
 *  - "unit"   (default): ações da Unit selecionada. Endpoints /units/:id/actions.
 *  - "global": regras que valem pra TODAS as units. Endpoints /global-actions.
 *
 * Visualmente só muda o título/subtítulo + dispensa exigência de
 * `selectedUnitId`. A UI de cards, editor e CRUD é a mesma.
 */
export interface AcoesPanelProps {
  scope?: 'unit' | 'global';
}

export function AcoesPanel({ scope = 'unit' }: AcoesPanelProps = {}) {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [actions, setActions] = useState<UnitAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<UnitAction | null>(null);
  const [creating, setCreating] = useState(false);

  const isGlobal = scope === 'global';

  const load = useCallback(async () => {
    if (!isGlobal && !selectedUnitId) {
      setActions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = isGlobal
        ? await api.listGlobalActions()
        : await api.listActions(selectedUnitId!);
      setActions(list);
    } finally {
      setLoading(false);
    }
  }, [isGlobal, selectedUnitId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(draft: DraftRule) {
    if (!isGlobal && !selectedUnitId) return;
    try {
      const input = draftToInput(draft);
      if (editing) {
        const updated = isGlobal
          ? await api.updateGlobalAction(editing.id, input)
          : await api.updateAction(selectedUnitId!, editing.id, input);
        setActions((cur) => cur.map((a) => (a.id === updated.id ? updated : a)));
        toast.success(isGlobal ? 'Regra global atualizada.' : 'Ação atualizada.');
      } else {
        const created = isGlobal
          ? await api.createGlobalAction(input)
          : await api.createAction(selectedUnitId!, input);
        setActions((cur) => [...cur, created]);
        toast.success(isGlobal ? 'Regra global criada.' : 'Ação criada.');
      }
      setEditing(null);
      setCreating(false);
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao salvar: ${e?.message ?? 'erro'}`);
    }
  }

  async function handleDelete(action: UnitAction) {
    if (!isGlobal && !selectedUnitId) return;
    if (!confirm(`Excluir esta ${isGlobal ? 'regra global' : 'ação'}?\n\n"${action.conditionDescription.slice(0, 80)}…"`)) return;
    try {
      if (isGlobal) await api.deleteGlobalAction(action.id);
      else await api.deleteAction(selectedUnitId!, action.id);
      setActions((cur) => cur.filter((a) => a.id !== action.id));
      toast.success(isGlobal ? 'Regra global excluída.' : 'Ação excluída.');
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao excluir: ${e?.message ?? 'erro'}`);
    }
  }

  async function handleToggle(action: UnitAction) {
    if (!isGlobal && !selectedUnitId) return;
    try {
      const updated = isGlobal
        ? await api.updateGlobalAction(action.id, { enabled: !action.enabled })
        : await api.updateAction(selectedUnitId!, action.id, { enabled: !action.enabled });
      setActions((cur) => cur.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha: ${e?.message ?? 'erro'}`);
    }
  }

  if (!isGlobal && !selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra configurar as Ações.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header — faixa com vidro + glow sutil, ícone em chip e contagem */}
        <div className="relative overflow-hidden rounded-2xl ring-1 ring-white/10 bg-gradient-to-br from-zinc-900/70 to-zinc-900/20 backdrop-blur p-6">
          <div
            className="pointer-events-none absolute -top-20 -right-12 w-64 h-64 rounded-full blur-3xl opacity-20"
            style={{
              background: isGlobal
                ? 'radial-gradient(circle, #8b5cf6 0%, transparent 70%)'
                : 'radial-gradient(circle, #7c4dff 0%, transparent 70%)',
            }}
          />
          <div className="relative flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3.5">
              <div
                className={clsx(
                  'w-12 h-12 rounded-2xl flex items-center justify-center ring-1 shadow-lg shrink-0',
                  isGlobal
                    ? 'bg-violet-500/15 ring-violet-500/30 text-violet-300 shadow-violet-500/10'
                    : 'bg-brand-500/15 ring-brand-400/30 text-brand-300 shadow-brand-500/10',
                )}
              >
                <Zap size={24} />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-zinc-100 tracking-tight flex items-center gap-2 flex-wrap">
                  {isGlobal ? 'Regras Globais' : 'Ações'}
                  {isGlobal && (
                    <span className="text-[10px] uppercase tracking-wider bg-violet-500/15 text-violet-300 px-2 py-0.5 rounded-full ring-1 ring-violet-500/30 font-normal">
                      Toda a plataforma
                    </span>
                  )}
                </h1>
                <p className="text-sm text-zinc-400 mt-1 max-w-2xl leading-relaxed">
                  {isGlobal
                    ? 'Regras "quando → faça" que valem pra TODAS as units. Têm prioridade sobre as ações da Unit — use pra segurança e compliance (handoff humano, emergência médica, ofensa, anti-diagnóstico).'
                    : 'Quando o cliente fizer X, a IA faz Y. O agente lê todas as regras a cada mensagem e decide quais se aplicam.'}
                </p>
                {!loading && actions.length > 0 && (
                  <div className="flex items-center gap-3 mt-3 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-emerald-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      {actions.filter((a) => a.enabled).length} ativa{actions.filter((a) => a.enabled).length === 1 ? '' : 's'}
                    </span>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-500">{actions.length} no total</span>
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setEditing(null);
              }}
              className={clsx(
                'inline-flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl text-white font-semibold shrink-0 shadow-lg transition-all hover:-translate-y-0.5 active:translate-y-0',
                isGlobal
                  ? 'bg-violet-600 hover:bg-violet-500 shadow-violet-600/25'
                  : 'bg-brand-600 hover:bg-brand-500 shadow-brand-600/25',
              )}
            >
              <Plus size={15} />
              {isGlobal ? 'Nova regra global' : 'Nova ação'}
            </button>
          </div>
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
          <div className="rounded-2xl ring-1 ring-white/10 bg-zinc-900/30 backdrop-blur p-12 text-center">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-brand-500/10 ring-1 ring-brand-400/20 flex items-center justify-center text-brand-300 mb-4">
              <Zap size={28} />
            </div>
            <p className="text-base text-zinc-200 font-semibold mb-1">Nenhuma ação ainda</p>
            <p className="text-sm text-zinc-500 max-w-md mx-auto leading-relaxed">
              Crie regras pra a IA aplicar tags, transferir pra um humano ou avançar etapas
              automaticamente — sem você mexer em nada.
            </p>
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setEditing(null);
              }}
              className={clsx(
                'mt-6 inline-flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl text-white font-semibold shadow-lg transition-all hover:-translate-y-0.5',
                isGlobal ? 'bg-violet-600 hover:bg-violet-500' : 'bg-brand-600 hover:bg-brand-500',
              )}
            >
              <Plus size={15} />
              {isGlobal ? 'Criar primeira regra' : 'Criar primeira ação'}
            </button>
          </div>
        ) : (
          <ul
            className="grid gap-4 auto-rows-fr"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))' }}
          >
            {actions.map((a, i) => (
              <ActionCard
                key={a.id}
                action={a}
                index={i}
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
  index = 0,
  onEdit,
  onDelete,
  onToggle,
}: {
  action: UnitAction;
  index?: number;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const steps = readSteps(action);
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 14) * 45}ms` }}
      className={clsx(
        // flex-col + h-full ocupa a célula inteira do grid (com auto-rows-fr);
        // footer colado no fim via mt-auto. Vidro + hover que levanta.
        'animate-fade-in-up group flex flex-col h-full rounded-2xl ring-1 backdrop-blur transition-all duration-300 hover:-translate-y-1',
        action.enabled
          ? 'ring-white/10 bg-zinc-900/50 hover:ring-brand-400/50 hover:shadow-xl hover:shadow-brand-500/5'
          : 'ring-white/5 bg-zinc-900/20 opacity-55 hover:opacity-90',
      )}
    >
      {/* Header: status + contagem */}
      <div className="px-5 pt-4 pb-1 flex items-center justify-between gap-2">
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase tracking-wider font-semibold',
            action.enabled
              ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30'
              : 'bg-zinc-800/50 text-zinc-500 ring-1 ring-zinc-700/50',
          )}
        >
          <span className={clsx('w-1.5 h-1.5 rounded-full', action.enabled ? 'bg-emerald-400' : 'bg-zinc-600')} />
          {action.enabled ? 'Ativa' : 'Inativa'}
        </span>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-600">
          {steps.length} {steps.length === 1 ? 'ação' : 'ações'}
        </span>
      </div>

      {/* Corpo — cresce e empurra o footer pro fim */}
      <div className="px-5 pb-3 flex-1 min-w-0">
        {/* QUANDO */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] uppercase tracking-wider font-bold text-amber-300/90">Quando</span>
          <span className="h-px flex-1 bg-gradient-to-r from-amber-400/30 to-transparent" />
        </div>
        <p className="text-sm text-zinc-200 leading-relaxed line-clamp-3" title={action.conditionDescription}>
          {action.conditionDescription}
        </p>

        {/* Conector visual Quando → Faça */}
        <div className="flex items-center gap-2 my-3 text-brand-300/70">
          <ArrowDown size={14} className="shrink-0" />
          <span className="h-px flex-1 bg-white/5" />
        </div>

        {/* A IA FAZ */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] uppercase tracking-wider font-bold text-brand-300">A IA faz</span>
          <span className="h-px flex-1 bg-gradient-to-r from-brand-400/30 to-transparent" />
        </div>
        <ul className="space-y-1.5">
          {steps.map((step, i) => (
            <li key={i} className="rounded-lg bg-white/[0.03] ring-1 ring-white/5 px-2.5 py-1.5">
              <StepSummary step={step} />
            </li>
          ))}
        </ul>

        {action.notes && (
          <p className="mt-3 text-xs text-zinc-500 leading-relaxed italic line-clamp-2" title={action.notes}>
            {action.notes}
          </p>
        )}
      </div>

      {/* Footer com botões — `mt-auto` cola no fim quando o card tá curto */}
      <div className="mt-auto px-3 py-2 border-t border-white/5 flex items-center justify-end gap-1">
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
  initial,
  isEditing,
  onSave,
  onCancel,
}: {
  initial: DraftRule;
  isEditing: boolean;
  onSave: (d: DraftRule) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DraftRule>(initial);
  const [saving, setSaving] = useState(false);
  // Lê metadados do Kommo do cache compartilhado — não refetch a cada abertura.
  const {
    tags: tagsData,
    pipelines: pipelinesData,
    users: usersData,
    lossReasons: lossReasonsData,
    loading: loadingKommo,
    tagsError,
    pipelinesError,
    refresh: refreshKommo,
  } = useKommoMeta();
  const valid = isValid(draft);

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
              onClick={() => refreshKommo()}
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
                  usersData={usersData}
                  lossReasonsData={lossReasonsData}
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
  usersData,
  lossReasonsData,
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
  usersData: KommoUsersResponse | null;
  lossReasonsData: KommoLossReasonsResponse | null;
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
      {step.kind === 'respond_with_intent' && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
            Orientação pra resposta (intenção)
          </label>
          <textarea
            value={step.instruction ?? ''}
            onChange={(e) => onChange({ ...step, instruction: e.target.value })}
            rows={5}
            maxLength={2000}
            placeholder={
              'ex: Explique em 1 frase que isso precisa ser avaliado pela fisioterapeuta presencialmente porque cada caso é único. Se o paciente pedir alívio imediato, diga que o ideal é agendar a consulta e até lá evitar esforço no local.'
            }
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition resize-y leading-relaxed"
          />
          <div className="flex items-center justify-between text-[10px] leading-tight">
            <p className="text-zinc-600">
              A IA <strong className="text-zinc-400">reformula com palavras dela</strong> seguindo
              essa orientação. Diferente de "Enviar mensagem" (que é literal). Aceita "se X então Y".
            </p>
            <span className="text-zinc-600 font-mono shrink-0 ml-2">
              {(step.instruction ?? '').length}/2000
            </span>
          </div>
        </div>
      )}
      {step.kind === 'create_task' && (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
              Tarefa (o que o SDR vai fazer)
            </label>
            <input
              type="text"
              value={step.text ?? ''}
              onChange={(e) => onChange({ ...step, text: e.target.value })}
              maxLength={500}
              placeholder="ex: Ligar pro paciente confirmando consulta"
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
              Prazo
            </label>
            <select
              value={step.deadlineMinutes ?? 60}
              onChange={(e) => onChange({ ...step, deadlineMinutes: Number(e.target.value) })}
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 outline-none transition"
            >
              <option value={30}>Em 30 minutos</option>
              <option value={60}>Em 1 hora</option>
              <option value={180}>Em 3 horas</option>
              <option value={1440}>Amanhã (24h)</option>
              <option value={2880}>Em 2 dias</option>
              <option value={4320}>Em 3 dias</option>
              <option value={10080}>Em 1 semana</option>
              <option value={20160}>Em 2 semanas</option>
            </select>
          </div>
          <UserPickerInline
            label="Responsável (opcional)"
            usersData={usersData}
            loading={loadingKommo}
            selectedId={step.responsibleUserId ?? null}
            onChange={(id, name) =>
              onChange({ ...step, responsibleUserId: id, responsibleUserName: name })
            }
          />
        </div>
      )}
      {step.kind === 'assign_responsible' && (
        <UserPickerInline
          label="Atribuir a"
          usersData={usersData}
          loading={loadingKommo}
          selectedId={step.userId ?? null}
          onChange={(id, name) => onChange({ ...step, userId: id, userName: name })}
        />
      )}
      {step.kind === 'remove_tag' && (
        <SingleTagPicker
          selected={step.singleTag ?? ''}
          onChange={(tag) => onChange({ ...step, singleTag: tag })}
          available={tagsData?.tags ?? []}
          loading={loadingKommo}
          error={tagsError}
        />
      )}
      {step.kind === 'set_lead_value' && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
            Valor do lead (R$)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-xs font-mono">
              R$
            </span>
            <input
              type="number"
              min={0}
              max={10_000_000}
              step={1}
              value={step.price ?? 0}
              onChange={(e) => onChange({ ...step, price: Number(e.target.value) })}
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md pl-9 pr-3 py-1.5 text-xs text-zinc-200 font-mono outline-none transition"
            />
          </div>
          <p className="text-[10px] text-zinc-600">
            Vai pro campo "price" do lead no Kommo. Alimenta as métricas do dashboard.
          </p>
        </div>
      )}
      {step.kind === 'mark_lead_status' && (
        <div className="space-y-2">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
            Fechar como
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() =>
                onChange({ ...step, status: 'won', lossReasonId: null, lossReasonLabel: null })
              }
              className={clsx(
                'p-2.5 rounded-md text-xs font-medium transition border text-left',
                step.status === 'won'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-zinc-800 bg-zinc-950/30 text-zinc-400 hover:border-zinc-700',
              )}
            >
              ✓ Venda realizada
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...step, status: 'lost' })}
              className={clsx(
                'p-2.5 rounded-md text-xs font-medium transition border text-left',
                step.status === 'lost'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                  : 'border-zinc-800 bg-zinc-950/30 text-zinc-400 hover:border-zinc-700',
              )}
            >
              ✗ Venda perdida
            </button>
          </div>
          {step.status === 'lost' && (
            <LossReasonPicker
              lossReasonsData={lossReasonsData}
              loading={loadingKommo}
              selectedId={step.lossReasonId ?? null}
              onChange={(id, name) =>
                onChange({ ...step, lossReasonId: id, lossReasonLabel: name })
              }
            />
          )}
        </div>
      )}
      {step.kind === 'move_pipeline' && (
        <PipelinePicker
          pipelines={pipelinesForSelect}
          loading={loadingKommo}
          error={pipelinesError}
          selectedPipelineId={step.pipelineId ?? null}
          selectedStatusId={step.statusId ?? null}
          onChange={(pipelineId, pipelineLabel, statusId, statusLabel) =>
            onChange({ ...step, pipelineId, pipelineLabel, statusId, statusLabel })
          }
        />
      )}
      {step.kind === 'pause_ai' && (
        <div className="space-y-2">
          <div className="rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-200/80 leading-relaxed">
            Desliga a IA pra esse lead — o Salesbot do Kommo para de ser
            acionado nos turnos seguintes. A IA não anuncia ao paciente.
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block mb-1.5">
              Mover pra etapa (opcional)
            </label>
            <p className="text-[10px] text-zinc-500 mb-2 leading-tight">
              Útil pra colocar o lead onde o SDR vai encontrar (ex: "Aguardando atendimento").
              Deixe vazio se for só pausar sem mexer no funil.
            </p>
            <StagePicker
              selectedStatusId={step.moveToStageId ?? null}
              selectedLabel={step.moveToStageLabel ?? null}
              onChange={(statusId, pipelineId, label) =>
                onChange({
                  ...step,
                  moveToStageId: statusId,
                  moveToPipelineId: pipelineId,
                  moveToStageLabel: label,
                })
              }
              pipelines={pipelinesForSelect}
              loading={loadingKommo}
              error={pipelinesError}
            />
          </div>
        </div>
      )}
      {step.kind === 'pause_in_stages' && (
        <div className="space-y-2">
          <div className="rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-[11px] text-violet-200/80 leading-relaxed">
            <strong className="text-violet-200">Guard automático.</strong> A IA é
            silenciada SEMPRE que o lead estiver em qualquer uma das etapas
            selecionadas — não vai pro prompt, é avaliado no recebimento do
            webhook. Use pra etapas terminais (fechado, perdido, em atendimento humano).
          </div>
          <MultiStagePicker
            selected={step.pausedStages ?? []}
            onChange={(stages) => onChange({ ...step, pausedStages: stages })}
            pipelines={pipelinesForSelect}
            loading={loadingKommo}
            error={pipelinesError}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MultiStagePicker — permite selecionar VÁRIAS etapas (de qualquer funil) e
// listá-las como chips removíveis. Usado pelo kind `pause_in_stages`.
// ---------------------------------------------------------------------------

function MultiStagePicker({
  selected,
  onChange,
  pipelines,
  loading,
  error,
}: {
  selected: Array<{ statusId: number; pipelineId?: number; statusLabel?: string; pipelineLabel?: string }>;
  onChange: (
    stages: Array<{ statusId: number; pipelineId?: number; statusLabel?: string; pipelineLabel?: string }>,
  ) => void;
  pipelines: NonNullable<KommoPipelinesResponse['pipelines']>;
  loading: boolean;
  error: string | null;
}) {
  function addStage(statusId: number) {
    // Se já tem essa stage, no-op.
    if (selected.some((s) => s.statusId === statusId)) return;
    for (const p of pipelines) {
      const st = p.statuses.find((x) => x.id === statusId);
      if (st) {
        onChange([
          ...selected,
          {
            statusId,
            pipelineId: p.id,
            statusLabel: st.name,
            pipelineLabel: p.name,
          },
        ]);
        return;
      }
    }
  }

  function removeStage(statusId: number) {
    onChange(selected.filter((s) => s.statusId !== statusId));
  }

  return (
    <div className="space-y-2">
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
        Etapas onde a IA fica silenciosa
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

      {/* Chips das etapas selecionadas */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((s) => (
            <span
              key={s.statusId}
              className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full bg-violet-500/10 text-violet-200 ring-1 ring-violet-500/30"
            >
              {s.pipelineLabel ? `${s.pipelineLabel} → ` : ''}
              {s.statusLabel ?? `etapa ${s.statusId}`}
              <button
                type="button"
                onClick={() => removeStage(s.statusId)}
                className="text-violet-100/70 hover:text-violet-50"
                title="Remover"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Seletor pra adicionar mais */}
      {!loading && !error && pipelines.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            if (id) addStage(id);
            // Reset visual do select pra "—".
            e.currentTarget.value = '';
          }}
          className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-violet-500/40 rounded-md px-3 py-2 text-sm text-zinc-200 outline-none transition"
        >
          <option value="">+ adicionar etapa…</option>
          {pipelines.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.statuses
                .filter((st) => !selected.some((sel) => sel.statusId === st.id))
                .map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      )}

      {selected.length === 0 && !loading && !error && (
        <p className="text-[11px] text-zinc-500">
          Nenhuma etapa selecionada. Use o seletor acima pra adicionar (você pode adicionar várias).
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picker reusável: usuário do Kommo (pra create_task + assign_responsible).
// ---------------------------------------------------------------------------

function UserPickerInline({
  label,
  usersData,
  loading,
  selectedId,
  onChange,
}: {
  label: string;
  usersData: KommoUsersResponse | null;
  loading: boolean;
  selectedId: number | null;
  onChange: (id: number | null, name: string | null) => void;
}) {
  const users = usersData?.users ?? [];
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
        {label}
      </label>
      {loading && !usersData ? (
        <div className="text-[11px] text-zinc-500 inline-flex items-center gap-2">
          <Loader2 className="animate-spin" size={11} />
          Carregando usuários…
        </div>
      ) : users.length === 0 ? (
        <div className="text-[11px] text-zinc-500">Nenhum usuário Kommo encontrado.</div>
      ) : (
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            const u = users.find((x) => x.id === id);
            onChange(id, u?.name ?? null);
          }}
          className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 outline-none transition"
        >
          <option value="">— sem responsável fixo —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.email ? ` (${u.email})` : ''}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picker reusável: motivo de perda (loss_reason).
// ---------------------------------------------------------------------------

function LossReasonPicker({
  lossReasonsData,
  loading,
  selectedId,
  onChange,
}: {
  lossReasonsData: KommoLossReasonsResponse | null;
  loading: boolean;
  selectedId: number | null;
  onChange: (id: number | null, name: string | null) => void;
}) {
  const reasons = lossReasonsData?.reasons ?? [];
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
        Motivo da perda (opcional)
      </label>
      {loading && !lossReasonsData ? (
        <div className="text-[11px] text-zinc-500 inline-flex items-center gap-2">
          <Loader2 className="animate-spin" size={11} />
          Carregando motivos…
        </div>
      ) : reasons.length === 0 ? (
        <div className="text-[11px] text-zinc-600 italic">
          Nenhum motivo cadastrado no Kommo. Você ainda pode fechar como Perdida sem motivo.
        </div>
      ) : (
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            const r = reasons.find((x) => x.id === id);
            onChange(id, r?.name ?? null);
          }}
          className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 outline-none transition"
        >
          <option value="">— sem motivo específico —</option>
          {reasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picker reusável: single-tag (pra remove_tag).
// ---------------------------------------------------------------------------

function SingleTagPicker({
  selected,
  onChange,
  available,
  loading,
  error,
}: {
  selected: string;
  onChange: (tag: string) => void;
  available: Array<{ id: number; name: string; color: string | null }>;
  loading: boolean;
  error: string | null;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((t) => t.name.toLowerCase().includes(q));
  }, [available, query]);
  return (
    <div className="space-y-2">
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
        Tag a remover
      </label>
      {available.length > 5 && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Buscar entre ${available.length} tags…`}
          className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition"
        />
      )}
      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 max-h-44 overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-[11px] text-zinc-500 inline-flex items-center gap-2">
            <Loader2 className="animate-spin" size={11} />
            Carregando tags…
          </div>
        )}
        {error && (
          <div className="px-3 py-2 text-[11px] text-amber-300/80">⚠ {error}</div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-zinc-500">
            {available.length === 0 ? 'Nenhuma tag cadastrada.' : `Nenhuma bate com "${query}".`}
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <ul className="divide-y divide-zinc-800/40">
            {filtered.map((t) => {
              const checked = selected.toLowerCase() === t.name.toLowerCase();
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onChange(t.name)}
                    className={clsx(
                      'w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs transition',
                      checked
                        ? 'bg-stone-500/10 text-stone-100'
                        : 'text-zinc-300 hover:bg-zinc-900/50',
                    )}
                  >
                    <input
                      type="radio"
                      checked={checked}
                      readOnly
                      className="accent-stone-400 pointer-events-none"
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
      <input
        type="text"
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        placeholder="ou digite nome exato"
        className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-700 font-mono outline-none transition"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picker reusável: pipeline+status agrupado (pra move_pipeline).
// ---------------------------------------------------------------------------

function PipelinePicker({
  pipelines,
  loading,
  error,
  selectedPipelineId,
  selectedStatusId,
  onChange,
}: {
  pipelines: NonNullable<KommoPipelinesResponse['pipelines']>;
  loading: boolean;
  error: string | null;
  selectedPipelineId: number | null;
  selectedStatusId: number | null;
  onChange: (
    pipelineId: number | null,
    pipelineLabel: string | null,
    statusId: number | null,
    statusLabel: string | null,
  ) => void;
}) {
  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);
  return (
    <div className="space-y-2">
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block">
        Funil destino
      </label>
      {loading && (
        <div className="text-[11px] text-zinc-500 inline-flex items-center gap-2">
          <Loader2 className="animate-spin" size={11} />
          Carregando funis…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300/90">
          ⚠ {error}
        </div>
      )}
      {!loading && !error && (
        <>
          <select
            value={selectedPipelineId ?? ''}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              const p = pipelines.find((x) => x.id === id);
              onChange(id, p?.name ?? null, null, null);
            }}
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-sm text-zinc-200 outline-none transition"
          >
            <option value="">— escolha um funil —</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isMain ? ' (principal)' : ''}
              </option>
            ))}
          </select>
          {selectedPipeline && (
            <div>
              <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold block mt-2 mb-1">
                Etapa inicial (opcional)
              </label>
              <select
                value={selectedStatusId ?? ''}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null;
                  const s = selectedPipeline.statuses.find((x) => x.id === id);
                  onChange(
                    selectedPipeline.id,
                    selectedPipeline.name,
                    id,
                    s ? `${selectedPipeline.name} → ${s.name}` : null,
                  );
                }}
                className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-sm text-zinc-200 outline-none transition"
              >
                <option value="">— primeira etapa (padrão) —</option>
                {selectedPipeline.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
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
      {step.kind === 'respond_with_intent' && typeof params.instruction === 'string' && params.instruction.trim() && (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded bg-sky-500/15 text-sky-100 text-[11px] ring-1 ring-sky-500/30 max-w-full"
          title={params.instruction}
        >
          <span className="truncate">→ {params.instruction.slice(0, 70)}{params.instruction.length > 70 ? '…' : ''}</span>
        </span>
      )}
      {step.kind === 'create_task' && typeof params.text === 'string' && (
        <>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-200 text-[11px] ring-1 ring-orange-500/30 italic max-w-full" title={params.text}>
            <span className="truncate">"{params.text.slice(0, 50)}{params.text.length > 50 ? '…' : ''}"</span>
          </span>
          {typeof params.deadlineMinutes === 'number' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-300 text-[11px] ring-1 ring-orange-500/20 font-mono">
              {humanDeadline(params.deadlineMinutes)}
            </span>
          )}
          {typeof params.responsibleUserName === 'string' && params.responsibleUserName && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-zinc-700/50 text-zinc-300 text-[11px] ring-1 ring-zinc-600/40">
              @{params.responsibleUserName}
            </span>
          )}
        </>
      )}
      {step.kind === 'assign_responsible' && typeof params.userName === 'string' && params.userName && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-teal-500/15 text-teal-200 text-[11px] ring-1 ring-teal-500/30">
          → {params.userName}
        </span>
      )}
      {step.kind === 'remove_tag' && typeof params.tag === 'string' && params.tag && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-stone-500/15 text-stone-200 text-[11px] ring-1 ring-stone-500/30 font-mono line-through">
          #{params.tag}
        </span>
      )}
      {step.kind === 'set_lead_value' && typeof params.price === 'number' && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-lime-500/15 text-lime-200 text-[11px] ring-1 ring-lime-500/30 font-mono">
          R$ {params.price.toLocaleString('pt-BR')}
        </span>
      )}
      {step.kind === 'mark_lead_status' && (
        <span
          className={clsx(
            'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] ring-1',
            params.status === 'won'
              ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30'
              : 'bg-rose-500/15 text-rose-200 ring-rose-500/30',
          )}
        >
          {params.status === 'won' ? '✓ Realizada' : '✗ Perdida'}
          {params.status === 'lost' && typeof params.lossReasonLabel === 'string' && params.lossReasonLabel
            ? ` (${params.lossReasonLabel})`
            : ''}
        </span>
      )}
      {step.kind === 'move_pipeline' && typeof params.pipelineLabel === 'string' && params.pipelineLabel && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-200 text-[11px] ring-1 ring-indigo-500/30">
          → {params.pipelineLabel}
          {typeof params.statusLabel === 'string' && params.statusLabel ? ` (${params.statusLabel})` : ''}
        </span>
      )}
      {step.kind === 'pause_ai' && typeof params.moveToStageLabel === 'string' && params.moveToStageLabel && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-200 text-[11px] ring-1 ring-rose-500/30">
          → {params.moveToStageLabel}
        </span>
      )}
    </div>
  );
}

/** Formatador humano de minutos pra rótulo curto (chip do card). */
function humanDeadline(m: number): string {
  if (m < 60) return `${m}min`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  const d = Math.floor(m / 1440);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}sem`;
}
