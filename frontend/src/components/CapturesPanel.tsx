// ============================================================================
// CapturesPanel — Captura de Dados (LeadFieldRule).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada regra = 1 tool dinâmica que o agente recebe. A tool sabe escrever
// num custom field específico do Kommo (texto, número, data, select, multi).
//
// PRINCÍPIOS DE UX
// ----------------
// 1) Tela cheia, container max-w (padrão do app). Sem drawer pra a edição —
//    o user pediu isso explicitamente.
// 2) Lista com cards informativos: badge do tipo, status pill, instrução
//    encurtada, exemplos preview, tool name. Estado vazio acolhedor.
// 3) Editor em 3 passos sutis (não wizard, só agrupamento visual):
//      • Campo do Kommo (com badge do tipo, opções pra select)
//      • Como a IA reconhece (instruction + valueHint + examples)
//      • Identidade (toolName, enabled)
// 4) Affordances UX:
//      • Toggle "Ativa" no card pra liga/desliga sem abrir editor.
//      • Toast verde/vermelho em toda ação.
//      • Loading skeleton enquanto carrega fields da Kommo.
//      • Mensagens de erro Kommo (token inválido) bem visíveis.
//      • Acessibilidade: cada control tem label, focus rings visíveis.
//      • Sem destructive sem confirmação.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Hash,
  Layers,
  List,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import type {
  KommoFieldType,
  KommoLeadCustomField,
  KommoLeadCustomFieldsResponse,
  LeadFieldRule,
  LeadFieldRuleInput,
} from '../types/api';

// ---------------------------------------------------------------------------
// Type meta: ícones e labels por tipo de field.
// ---------------------------------------------------------------------------

const FIELD_TYPE_META: Record<
  KommoFieldType,
  { label: string; icon: typeof Type; tint: string }
> = {
  text: { label: 'Texto', icon: Type, tint: 'text-zinc-300 bg-zinc-500/15 ring-zinc-500/30' },
  textarea: {
    label: 'Texto longo',
    icon: FileText,
    tint: 'text-zinc-300 bg-zinc-500/15 ring-zinc-500/30',
  },
  numeric: {
    label: 'Número',
    icon: Hash,
    tint: 'text-emerald-300 bg-emerald-500/15 ring-emerald-500/30',
  },
  date: {
    label: 'Data',
    icon: Calendar,
    tint: 'text-sky-300 bg-sky-500/15 ring-sky-500/30',
  },
  birthday: {
    label: 'Aniversário',
    icon: Calendar,
    tint: 'text-pink-300 bg-pink-500/15 ring-pink-500/30',
  },
  select: {
    label: 'Seleção única',
    icon: List,
    tint: 'text-amber-300 bg-amber-500/15 ring-amber-500/30',
  },
  multiselect: {
    label: 'Múltipla escolha',
    icon: Layers,
    tint: 'text-violet-300 bg-violet-500/15 ring-violet-500/30',
  },
  radiobutton: {
    label: 'Rádio',
    icon: List,
    tint: 'text-amber-300 bg-amber-500/15 ring-amber-500/30',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugifyToolName(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base ? `salvar_${base}`.slice(0, 48) : 'salvar_campo';
}

function fieldDefaultHint(field: KommoLeadCustomField): string {
  switch (field.type) {
    case 'numeric':
      return 'Número (inteiro ou decimal). Converta o que o paciente disser.';
    case 'date':
    case 'birthday':
      return 'Data em ISO 8601 (YYYY-MM-DD). Ex: "14/03/1985" → "1985-03-14".';
    case 'select':
    case 'radiobutton':
      return `Escolha uma de: ${field.enums.map((e) => `"${e.value}"`).join(', ')}.`;
    case 'multiselect':
      return `Uma ou mais de: ${field.enums.map((e) => `"${e.value}"`).join(', ')}.`;
    default:
      return 'Texto livre. O sistema remove emojis 4-byte automaticamente.';
  }
}

function summarizeInstruction(s: string, max = 110): string {
  const clean = s.trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

type EditState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; rule: LeadFieldRule };

// ===========================================================================
// Panel principal
// ===========================================================================

export function CapturesPanel() {
  const { selectedUnitId, selectedUnit } = useUnit();
  const toast = useToast();

  const [rules, setRules] = useState<LeadFieldRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [fieldsData, setFieldsData] = useState<KommoLeadCustomFieldsResponse | null>(null);
  const [loadingFields, setLoadingFields] = useState(false);
  const [edit, setEdit] = useState<EditState>({ mode: 'closed' });
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!selectedUnitId) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listLeadFieldRules(selectedUnitId);
      setRules(list);
    } finally {
      setLoading(false);
    }
  }, [selectedUnitId]);

  const loadFields = useCallback(async () => {
    if (!selectedUnitId) {
      setFieldsData(null);
      return;
    }
    setLoadingFields(true);
    try {
      const data = await api.kommoLeadCustomFields(selectedUnitId);
      setFieldsData(data);
    } finally {
      setLoadingFields(false);
    }
  }, [selectedUnitId]);

  useEffect(() => {
    void load();
    void loadFields();
  }, [load, loadFields]);

  // Reset edit ao trocar unidade.
  useEffect(() => {
    setEdit({ mode: 'closed' });
    setSearch('');
  }, [selectedUnitId]);

  async function handleSave(input: LeadFieldRuleInput, ruleId?: string) {
    if (!selectedUnitId) return;
    try {
      if (ruleId) {
        const updated = await api.updateLeadFieldRule(selectedUnitId, ruleId, input);
        setRules((cur) => cur.map((r) => (r.id === updated.id ? updated : r)));
        toast.success('Captura atualizada.');
      } else {
        const created = await api.createLeadFieldRule(selectedUnitId, input);
        setRules((cur) => [...cur, created]);
        toast.success('Captura criada.');
      }
      setEdit({ mode: 'closed' });
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const code = e?.response?.data?.error;
      if (code === 'tool_name_already_used_in_unit') {
        toast.error('Já existe uma captura com esse nome de tool. Escolha outro.');
      } else {
        toast.error(`Falha ao salvar: ${code ?? e?.message ?? 'erro'}`);
      }
      throw err;
    }
  }

  async function handleDelete(rule: LeadFieldRule) {
    if (!selectedUnitId) return;
    if (
      !confirm(
        `Apagar a captura "${rule.kommoFieldName}"?\n\nA tool ${rule.toolName} deixa de existir pra IA — o campo no Kommo NÃO é afetado.`,
      )
    )
      return;
    try {
      await api.deleteLeadFieldRule(selectedUnitId, rule.id);
      setRules((cur) => cur.filter((r) => r.id !== rule.id));
      toast.success('Captura apagada.');
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao apagar: ${e?.message ?? 'erro'}`);
    }
  }

  async function handleToggle(rule: LeadFieldRule) {
    if (!selectedUnitId) return;
    try {
      const updated = await api.updateLeadFieldRule(selectedUnitId, rule.id, {
        enabled: !rule.enabled,
      });
      setRules((cur) => cur.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha: ${e?.message ?? 'erro'}`);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter(
      (r) =>
        r.kommoFieldName.toLowerCase().includes(q) ||
        r.toolName.toLowerCase().includes(q) ||
        r.instruction.toLowerCase().includes(q),
    );
  }, [rules, search]);

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra configurar capturas.
      </div>
    );
  }

  // Modo edição em tela cheia (padrão do app)
  if (edit.mode !== 'closed') {
    return (
      <CaptureEditor
        initialRule={edit.mode === 'edit' ? edit.rule : null}
        fields={fieldsData?.fields ?? []}
        fieldsLoading={loadingFields}
        fieldsError={
          fieldsData && !fieldsData.ok
            ? fieldsData.message ?? fieldsData.error ?? 'falha ao acessar Kommo'
            : null
        }
        onReloadFields={() => void loadFields()}
        onCancel={() => setEdit({ mode: 'closed' })}
        onSave={(input) => handleSave(input, edit.mode === 'edit' ? edit.rule.id : undefined)}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-5">
        {/* Header */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold text-zinc-100 tracking-tight flex items-center gap-2">
              <Database size={22} className="text-brand-300" />
              Captura de Dados
            </h1>
            <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
              Configure quais informações da conversa a IA deve capturar e gravar em{' '}
              <strong>custom fields do Kommo</strong>. Cada regra vira uma{' '}
              <span className="text-brand-300 font-mono">tool</span> que o agente chama em silêncio
              quando detecta a informação.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEdit({ mode: 'create' })}
            disabled={!selectedUnit?.kommoSubdomain || !selectedUnit?.kommoAccessToken}
            className="inline-flex items-center gap-2 text-sm px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 text-white font-medium shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              !selectedUnit?.kommoSubdomain
                ? 'Configure o Kommo da unidade primeiro'
                : 'Criar nova captura'
            }
          >
            <Plus size={14} />
            Nova captura
          </button>
        </div>

        {/* Aviso se Kommo não configurado */}
        {!selectedUnit?.kommoSubdomain && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200/90">
            <div className="font-semibold mb-1">⚠ Kommo não configurado nesta unidade</div>
            Pra capturar dados precisamos saber a conta Kommo. Vá em{' '}
            <strong>Unidades</strong> e preencha subdomínio + access token.
          </div>
        )}

        {/* Aviso se fetch dos fields falhou */}
        {fieldsData && !fieldsData.ok && selectedUnit?.kommoSubdomain && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-200/90">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Não consegui ler os custom fields do Kommo</div>
                <div className="text-rose-200/70 mt-1">
                  {fieldsData.message ?? fieldsData.error ?? 'Erro desconhecido'}. Confira o token
                  da unidade.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Busca — só mostra quando há regras */}
        {rules.length > 0 && (
          <div className="relative max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por campo, tool ou instrução…"
              className="w-full bg-zinc-900/60 border border-zinc-800 rounded-md text-sm pl-9 pr-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
            />
          </div>
        )}

        {/* Lista */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-zinc-500">
            <Loader2 className="animate-spin mr-2" size={16} />
            Carregando capturas…
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            disabled={!selectedUnit?.kommoSubdomain || !selectedUnit?.kommoAccessToken}
            onCreate={() => setEdit({ mode: 'create' })}
          />
        ) : filtered.length === 0 ? (
          <div className="text-center text-sm text-zinc-500 py-12">
            Nenhuma captura bate com a busca.
          </div>
        ) : (
          <ul className="space-y-3">
            {filtered.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onEdit={() => setEdit({ mode: 'edit', rule })}
                onDelete={() => handleDelete(rule)}
                onToggle={() => handleToggle(rule)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// EmptyState
// ===========================================================================

function EmptyState({ disabled, onCreate }: { disabled: boolean; onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-10 text-center">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-brand-500/10 ring-1 ring-brand-500/30 mb-4">
        <Sparkles size={26} className="text-brand-300" />
      </div>
      <p className="text-base font-semibold text-zinc-200 mb-1">
        Nenhuma captura configurada ainda
      </p>
      <p className="text-sm text-zinc-500 mb-5 max-w-md mx-auto leading-relaxed">
        Crie regras pra a IA extrair dados estruturados da conversa e gravar direto em campos do
        Kommo — idade, cidade, procedimento de interesse, data de nascimento, etc.
      </p>
      <button
        type="button"
        onClick={onCreate}
        disabled={disabled}
        className="inline-flex items-center gap-2 text-sm px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={14} />
        Criar primeira captura
      </button>
    </div>
  );
}

// ===========================================================================
// RuleCard — uma regra na lista
// ===========================================================================

function RuleCard({
  rule,
  onEdit,
  onDelete,
  onToggle,
}: {
  rule: LeadFieldRule;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const meta = FIELD_TYPE_META[rule.kommoFieldType] ?? FIELD_TYPE_META.text;
  const Icon = meta.icon;
  return (
    <li
      className={clsx(
        'rounded-xl border p-4 transition',
        rule.enabled
          ? 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
          : 'border-zinc-800/50 bg-zinc-900/20 opacity-60',
      )}
    >
      <div className="flex items-start gap-3">
        {/* Type icon */}
        <div
          className={clsx(
            'w-10 h-10 shrink-0 rounded-lg ring-1 inline-flex items-center justify-center',
            meta.tint,
          )}
        >
          <Icon size={18} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Header line */}
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <span className="text-sm font-semibold text-zinc-100 truncate">
              {rule.kommoFieldName}
            </span>
            <span
              className={clsx(
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 font-semibold',
                meta.tint,
              )}
            >
              {meta.label}
            </span>
            {!rule.enabled && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                Desativada
              </span>
            )}
          </div>

          {/* Instruction summary */}
          <p className="text-sm text-zinc-300 leading-relaxed">
            {summarizeInstruction(rule.instruction)}
          </p>

          {/* Examples preview + tool name */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
            <span className="font-mono text-brand-300 bg-brand-500/10 px-1.5 py-0.5 rounded">
              {rule.toolName}()
            </span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500 font-mono">field #{rule.kommoFieldId}</span>
            {rule.examples.length > 0 && (
              <>
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-500 truncate">
                  Gatilhos: {rule.examples.slice(0, 3).join(' • ')}
                  {rule.examples.length > 3 && ` (+${rule.examples.length - 3})`}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onToggle}
            title={rule.enabled ? 'Desativar' : 'Ativar'}
            className={clsx(
              'p-1.5 rounded hover:bg-zinc-800 transition',
              rule.enabled ? 'text-emerald-400' : 'text-zinc-600',
            )}
          >
            {rule.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
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
            title="Apagar"
            className="p-1.5 rounded text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}

// ===========================================================================
// CaptureEditor — tela cheia
// ===========================================================================

interface DraftRule {
  kommoFieldId: number | null;
  kommoFieldName: string;
  kommoFieldType: KommoFieldType;
  kommoFieldEnums: Array<{ id: number; value: string }> | null;
  toolName: string;
  instruction: string;
  valueHint: string;
  examples: string[];
  enabled: boolean;
}

function ruleToDraft(rule: LeadFieldRule): DraftRule {
  return {
    kommoFieldId: rule.kommoFieldId,
    kommoFieldName: rule.kommoFieldName,
    kommoFieldType: rule.kommoFieldType,
    kommoFieldEnums: rule.kommoFieldEnums,
    toolName: rule.toolName,
    instruction: rule.instruction,
    valueHint: rule.valueHint ?? '',
    examples: rule.examples,
    enabled: rule.enabled,
  };
}

const EMPTY_DRAFT: DraftRule = {
  kommoFieldId: null,
  kommoFieldName: '',
  kommoFieldType: 'text',
  kommoFieldEnums: null,
  toolName: '',
  instruction: '',
  valueHint: '',
  examples: [],
  enabled: true,
};

function CaptureEditor({
  initialRule,
  fields,
  fieldsLoading,
  fieldsError,
  onReloadFields,
  onCancel,
  onSave,
}: {
  initialRule: LeadFieldRule | null;
  fields: KommoLeadCustomField[];
  fieldsLoading: boolean;
  fieldsError: string | null;
  onReloadFields: () => void;
  onCancel: () => void;
  onSave: (input: LeadFieldRuleInput) => Promise<void>;
}) {
  const isEditing = initialRule !== null;
  const [draft, setDraft] = useState<DraftRule>(
    initialRule ? ruleToDraft(initialRule) : EMPTY_DRAFT,
  );
  const [exampleInput, setExampleInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const selectedField = useMemo(() => {
    if (!draft.kommoFieldId) return null;
    return fields.find((f) => f.id === draft.kommoFieldId) ?? null;
  }, [fields, draft.kommoFieldId]);

  // Quando escolhe campo, preenche tipo/nome/enums e sugere toolName/hint.
  function pickField(field: KommoLeadCustomField) {
    const newToolName =
      isEditing && draft.toolName ? draft.toolName : slugifyToolName(field.name);
    const newHint = draft.valueHint || fieldDefaultHint(field);
    setDraft({
      ...draft,
      kommoFieldId: field.id,
      kommoFieldName: field.name,
      kommoFieldType: field.type,
      kommoFieldEnums: field.enums.length > 0 ? field.enums : null,
      toolName: newToolName,
      valueHint: newHint,
    });
  }

  function addExample() {
    const v = exampleInput.trim();
    if (!v) return;
    if (draft.examples.includes(v)) {
      setExampleInput('');
      return;
    }
    setDraft({ ...draft, examples: [...draft.examples, v] });
    setExampleInput('');
  }
  function removeExample(idx: number) {
    setDraft({ ...draft, examples: draft.examples.filter((_, i) => i !== idx) });
  }

  const valid =
    !!draft.kommoFieldId &&
    /^[a-z][a-z0-9_]{1,48}$/.test(draft.toolName) &&
    draft.instruction.trim().length >= 3;

  async function submit() {
    if (!valid || saving || !draft.kommoFieldId) return;
    setSaving(true);
    try {
      const input: LeadFieldRuleInput = {
        kommoFieldId: draft.kommoFieldId,
        kommoFieldName: draft.kommoFieldName,
        kommoFieldType: draft.kommoFieldType,
        kommoFieldEnums: draft.kommoFieldEnums,
        toolName: draft.toolName,
        instruction: draft.instruction.trim(),
        valueHint: draft.valueHint.trim() || null,
        examples: draft.examples,
        enabled: draft.enabled,
      };
      await onSave(input);
    } catch {
      // erro já tratado pelo callback
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        {/* Header sticky */}
        <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur-sm flex items-center gap-3 pb-4 mb-2 border-b border-zinc-800/60">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1.5 rounded hover:bg-zinc-900/60"
          >
            <ArrowLeft size={14} />
            Voltar
          </button>
          <h2 className="text-base font-semibold text-zinc-100 flex-1 truncate">
            {isEditing ? `Editar captura · ${initialRule!.kommoFieldName}` : 'Nova captura'}
          </h2>
          <button
            type="button"
            onClick={submit}
            disabled={!valid || saving}
            className="text-xs px-3 py-1.5 rounded bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/30 inline-flex items-center gap-1 hover:bg-brand-500/30 disabled:opacity-50"
          >
            {saving ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />}
            {isEditing ? 'Salvar alterações' : 'Criar captura'}
          </button>
        </div>

        {/* Step 1 — Campo */}
        <Section
          number={1}
          title="Qual campo do Kommo você quer preencher?"
          subtitle="Escolha um dos custom fields da sua conta. O tipo determina como a IA interpreta o valor."
        >
          {fieldsLoading ? (
            <div className="text-xs text-zinc-500 inline-flex items-center gap-2">
              <Loader2 className="animate-spin" size={12} />
              Carregando campos da Kommo…
            </div>
          ) : fieldsError ? (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-200 flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold">Não consegui ler os campos da Kommo</div>
                <div className="text-rose-200/70 mt-1">{fieldsError}</div>
                <button
                  type="button"
                  onClick={onReloadFields}
                  className="mt-2 underline text-rose-200 hover:text-rose-100"
                >
                  Tentar novamente
                </button>
              </div>
            </div>
          ) : fields.length === 0 ? (
            <div className="text-xs text-zinc-500">
              Sua conta Kommo não tem custom fields suportados (texto, número, data ou seleção).
            </div>
          ) : (
            <FieldPicker
              fields={fields}
              selectedId={draft.kommoFieldId}
              onPick={pickField}
            />
          )}

          {/* Info do campo selecionado */}
          {selectedField && (
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
              <div className="text-zinc-500 mb-1">Campo selecionado</div>
              <div className="text-zinc-100 flex items-center gap-2 flex-wrap">
                <strong>{selectedField.name}</strong>
                <span
                  className={clsx(
                    'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1',
                    FIELD_TYPE_META[selectedField.type].tint,
                  )}
                >
                  {FIELD_TYPE_META[selectedField.type].label}
                </span>
                <span className="text-zinc-600 font-mono">#{selectedField.id}</span>
              </div>
              {selectedField.enums.length > 0 && (
                <div className="mt-2">
                  <div className="text-zinc-500 mb-1">Opções disponíveis:</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedField.enums.map((e) => (
                      <span
                        key={e.id}
                        className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-300"
                      >
                        {e.value}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* Step 2 — Como a IA reconhece */}
        <Section
          number={2}
          title="Como a IA deve detectar e capturar?"
          subtitle="Descreva em português natural — a IA decide quando aplicar usando isso + os exemplos."
        >
          <div>
            <Label>Quando capturar</Label>
            <textarea
              value={draft.instruction}
              onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
              rows={3}
              placeholder='ex: "Quando o paciente disser a idade dele, capture o número de anos."'
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 outline-none transition resize-y"
            />
          </div>

          <div>
            <Label>Formato esperado (opcional)</Label>
            <input
              type="text"
              value={draft.valueHint}
              onChange={(e) => setDraft({ ...draft, valueHint: e.target.value })}
              placeholder={selectedField ? fieldDefaultHint(selectedField) : 'ex: número inteiro entre 0 e 120'}
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 outline-none transition"
            />
            <p className="text-[11px] text-zinc-600 mt-1">
              Diz pra IA o formato/transformação que você espera (ex: "número inteiro", "data ISO",
              "uma palavra").
            </p>
          </div>

          <div>
            <Label>Frases-gatilho de exemplo</Label>
            <p className="text-[11px] text-zinc-500 mb-2">
              Liste 2-5 jeitos típicos que o paciente diz isso. Ajuda muito a precisão.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {draft.examples.map((ex, i) => (
                <span
                  key={`${ex}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-800/80 text-zinc-200 text-[12px] ring-1 ring-zinc-700"
                >
                  {ex}
                  <button
                    type="button"
                    onClick={() => removeExample(i)}
                    className="hover:text-rose-300"
                    title="Remover"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={exampleInput}
                onChange={(e) => setExampleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addExample();
                  }
                }}
                placeholder='ex: "tenho 34 anos"'
                className="flex-1 bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-700 outline-none transition"
              />
              <button
                type="button"
                onClick={addExample}
                disabled={!exampleInput.trim()}
                className="text-xs px-3 py-1.5 rounded-md bg-zinc-800/80 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
              >
                Adicionar
              </button>
            </div>
          </div>
        </Section>

        {/* Step 3 — Identidade */}
        <Section
          number={3}
          title="Identidade da ferramenta"
          subtitle="Como a tool aparece pra IA internamente. Geramos um nome decente automaticamente."
        >
          <div>
            <Label>Nome da tool (snake_case)</Label>
            <input
              type="text"
              value={draft.toolName}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  toolName: e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9_]/g, '')
                    .slice(0, 48),
                })
              }
              placeholder="salvar_idade"
              className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-100 font-mono placeholder:text-zinc-700 outline-none transition"
            />
            <p className="text-[11px] text-zinc-600 mt-1">
              Só letras minúsculas, números e <code>_</code>. Único por unidade. A IA vê esse nome
              ao decidir chamar.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="accent-emerald-500"
            />
            Captura ativa (a tool fica disponível pra IA)
          </label>
        </Section>

        {/* Preview opcional */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30">
          <button
            type="button"
            onClick={() => setShowPreview((s) => !s)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left text-xs text-zinc-300 hover:bg-zinc-900/60"
          >
            {showPreview ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="font-semibold">Onde isto aparece pra IA?</span>
            <span className="text-zinc-500">prévia do bloco no system prompt</span>
          </button>
          {showPreview && (
            <pre className="px-4 pb-4 text-[11px] text-zinc-300 whitespace-pre-wrap font-mono overflow-auto max-h-72">
{previewPromptBlock(draft)}
            </pre>
          )}
        </div>

        {/* Footer ações duplicadas (UX: usuário não precisa rolar pra topo) */}
        <div className="flex items-center justify-between pt-2 pb-6">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-zinc-400 hover:text-zinc-100 px-3 py-1.5"
          >
            Cancelar
          </button>
          <div className="flex items-center gap-2">
            {!valid && (
              <span className="text-[11px] text-zinc-500">
                Preencha campo, instrução e nome da tool.
              </span>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={!valid || saving}
              className="text-xs px-4 py-2 rounded bg-brand-600 hover:bg-brand-500 text-white font-medium inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="animate-spin" size={12} /> : <CheckCircle2 size={12} />}
              {isEditing ? 'Salvar alterações' : 'Criar captura'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// FieldPicker — dropdown searchable (combobox simples)
// ===========================================================================

function FieldPicker({
  fields,
  selectedId,
  onPick,
}: {
  fields: KommoLeadCustomField[];
  selectedId: number | null;
  onPick: (f: KommoLeadCustomField) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.name.toLowerCase().includes(q));
  }, [fields, filter]);

  const selected = fields.find((f) => f.id === selectedId);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="w-full flex items-center gap-2 bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-200 outline-none hover:ring-zinc-700"
      >
        {selected ? (
          <>
            {(() => {
              const Icon = FIELD_TYPE_META[selected.type].icon;
              return <Icon size={14} className="text-zinc-400" />;
            })()}
            <span className="flex-1 truncate text-left">{selected.name}</span>
            <span
              className={clsx(
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1',
                FIELD_TYPE_META[selected.type].tint,
              )}
            >
              {FIELD_TYPE_META[selected.type].label}
            </span>
          </>
        ) : (
          <span className="text-zinc-500 flex-1 text-left">Escolha um campo do Kommo…</span>
        )}
        <ChevronDown size={14} className="text-zinc-500" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 shadow-xl max-h-72 overflow-hidden flex flex-col">
          <div className="p-2 border-b border-zinc-800">
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrar…"
              className="w-full bg-zinc-900/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none"
            />
          </div>
          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-3 text-xs text-zinc-500 text-center">Nada encontrado.</div>
            ) : (
              filtered.map((f) => {
                const Icon = FIELD_TYPE_META[f.type].icon;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      onPick(f);
                      setOpen(false);
                      setFilter('');
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-900/80',
                      selectedId === f.id && 'bg-brand-500/10 text-brand-100',
                    )}
                  >
                    <Icon size={13} className="text-zinc-500 shrink-0" />
                    <span className="flex-1 truncate text-zinc-200">{f.name}</span>
                    <span
                      className={clsx(
                        'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 shrink-0',
                        FIELD_TYPE_META[f.type].tint,
                      )}
                    >
                      {FIELD_TYPE_META[f.type].label}
                    </span>
                    <span className="text-[10px] text-zinc-600 font-mono shrink-0">#{f.id}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Helpers visuais
// ===========================================================================

function Section({
  number,
  title,
  subtitle,
  children,
}: {
  number: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5 mb-4">
      <div className="flex items-center gap-2.5 mb-1">
        <span className="w-6 h-6 rounded-full bg-brand-500/15 ring-1 ring-brand-500/30 text-brand-300 text-[11px] font-mono font-bold inline-flex items-center justify-center">
          {number}
        </span>
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      </div>
      {subtitle && <p className="text-[12px] text-zinc-500 mb-3 ml-8">{subtitle}</p>}
      <div className="ml-8 space-y-3">{children}</div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5 block">
      {children}
    </label>
  );
}

function previewPromptBlock(draft: DraftRule): string {
  const lines: string[] = [];
  lines.push(`# CAPTURA DE DADOS`);
  lines.push(`- As tools abaixo gravam informações estruturadas no card do paciente.`);
  lines.push(``);
  lines.push(
    `1. ${draft.toolName || '<tool>'} → grava em "${draft.kommoFieldName || '<campo>'}" (${draft.kommoFieldType})`,
  );
  lines.push(`   Quando usar: ${draft.instruction || '<descreva quando usar>'}`);
  if (draft.valueHint.trim()) lines.push(`   Formato: ${draft.valueHint.trim()}`);
  if (draft.kommoFieldEnums && draft.kommoFieldEnums.length > 0) {
    lines.push(
      `   Opções permitidas: ${draft.kommoFieldEnums.map((e) => `"${e.value}"`).join(', ')}`,
    );
  }
  if (draft.examples.length > 0) {
    lines.push(`   Gatilhos: ${draft.examples.slice(0, 5).map((e) => `"${e}"`).join('; ')}`);
  }
  return lines.join('\n');
}
