// ============================================================================
// FontesPanel — 3 documentos longos que entram inteiros no system prompt.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Substitui a noção de "systemPrompt cru" por 3 docs estruturados que o dono
// da clínica edita como texto livre:
//
//   - Fatos importantes / papel  : papel da IA, fluxo SPIN, regras críticas
//                                  (CREFITO, comercial), bifurcação por horário
//   - Produtos e serviços        : condições tratadas, tecnologias, planos,
//                                  regra de valores
//   - Visão geral do negócio     : endereço, contatos, profissionais, horário
//                                  humano vs IA
//
// Os 3 são salvos diretamente em campos da Unit (sourcePapel, sourceProdutos,
// sourceNegocio) via PATCH /units/:id. O backend (`prompt-composer.ts`) lê e
// renderiza como 3 seções do system prompt antes das regras operacionais.
//
// Coexistem com a tabela `knowledge_base_entry` — Fontes é texto fixo no
// prompt; KB é RAG vetorizado pra FAQ.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, FileText, Loader2, Pencil, Save, Sparkles } from 'lucide-react';
import { RichTextEditor } from './RichTextEditor';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import type { Unit } from '../types/api';

type SourcesDraft = {
  sourcePapel: string;
  sourceProdutos: string;
  sourceNegocio: string;
};

const FIELDS: Array<{
  key: keyof SourcesDraft;
  label: string;
  hint: string;
  placeholder: string;
}> = [
  {
    key: 'sourcePapel',
    label: 'Fatos importantes — papel e fluxo',
    hint: 'Quem a IA é, como deve se comportar no primeiro contato, fluxo de conversa, regras críticas (limites profissionais, escalada pra humano).',
    placeholder:
      'Ex: Você se chama Sofia. Age como humana no primeiro contato. Se perguntarem se é IA, responda com honestidade...\n\nFLUXO DE CONVERSA (SPIN):\n- Acolhimento: cumprimenta e pergunta como pode ajudar\n- Situação: ...\n\nLIMITES CRÍTICOS:\n- Não diagnosticar\n- ...',
  },
  {
    key: 'sourceProdutos',
    label: 'Produtos e serviços',
    hint: 'Condições tratadas, tecnologias disponíveis, planos, regra de valores que a IA pode/não pode informar.',
    placeholder:
      'Ex: CONDIÇÕES QUE TRATAMOS:\n- Ombro: tendinite, bursite...\n- Joelho: condromalácia, LCA/LCP...\n\nNÃO TRATAMOS:\nOftalmologia, cardiologia...\n\nREGRA DE OURO SOBRE VALORES:\nVocê pode informar apenas R$150 antecipado / R$350 no dia. Não fale de valor de plano.',
  },
  {
    key: 'sourceNegocio',
    label: 'Visão geral do negócio',
    hint: 'Identidade da clínica: endereço, contatos, profissionais, horário humano vs IA, modalidade de atendimento.',
    placeholder:
      'Ex: A Clínica X é especializada em fisioterapia em Araguaína-TO.\n\nEndereço: Av. ..., 754\nWhatsApp: (63) 9126-8895\nInstagram: @...\n\nHORÁRIO HUMANO (Maria Eduarda): seg-sex 7h-19h\nHORÁRIO IA (Sofia): 24/7 — qualifica e agenda fora do expediente.\n\nIMPORTANTE: atendimento particular, sem convênio.',
  },
];

// Botão do segmentado Editar/Visualizar — sólido no ativo (aria-pressed),
// foco de teclado visível, transição ease-out de 150ms. Sem gradiente.
const SEG_BTN =
  'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded ' +
  'transition-[color,background-color] duration-150 ease-[cubic-bezier(0.16,0.84,0.44,1)] ' +
  'text-zinc-400 hover:text-zinc-100 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ' +
  'aria-pressed:bg-zinc-800 aria-pressed:text-zinc-50';

function unitToDraft(u: Unit): SourcesDraft {
  return {
    sourcePapel: u.sourcePapel ?? '',
    sourceProdutos: u.sourceProdutos ?? '',
    sourceNegocio: u.sourceNegocio ?? '',
  };
}

export function FontesPanel() {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [draft, setDraft] = useState<SourcesDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'edit' | 'view'>('edit');

  const load = useCallback(async () => {
    if (!selectedUnitId) {
      setUnit(null);
      setDraft(null);
      return;
    }
    const u = await api.getUnit(selectedUnitId);
    setUnit(u);
    setDraft(unitToDraft(u));
  }, [selectedUnitId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!unit || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(unitToDraft(unit));
  }, [unit, draft]);

  async function handleSave() {
    if (!selectedUnitId || !draft) return;
    setSaving(true);
    try {
      const updated = await api.updateUnit(selectedUnitId, {
        sourcePapel: draft.sourcePapel.trim() || null,
        sourceProdutos: draft.sourceProdutos.trim() || null,
        sourceNegocio: draft.sourceNegocio.trim() || null,
      });
      setUnit(updated);
      setDraft(unitToDraft(updated));
      toast.success('Fontes salvas. A IA já vai usar na próxima mensagem.');
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao salvar: ${e?.message ?? 'erro'}`);
    } finally {
      setSaving(false);
    }
  }

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra editar as Fontes.
      </div>
    );
  }

  if (!unit || !draft) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        <Loader2 className="animate-spin mr-2" size={18} />
        Carregando…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-5">
        {/* Header sticky */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold text-zinc-100 tracking-tight flex items-center gap-2">
              <FileText size={22} className="text-brand-300" />
              Fontes
            </h1>
            <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
              Documentos longos que a IA usa como contexto fixo em toda conversa.
              Cole aqui o que ela precisa saber — papel, produtos, identidade do negócio.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Segmentado Editar | Visualizar — roving via Tab natural, estado
                via aria-pressed (preenchido), foco de teclado visível. */}
            <div
              role="group"
              aria-label="Modo de exibição"
              className="inline-flex rounded-md bg-zinc-900 ring-1 ring-zinc-800 p-0.5"
            >
              <button
                type="button"
                onClick={() => setMode('edit')}
                aria-pressed={mode === 'edit'}
                className={SEG_BTN}
              >
                <Pencil size={13} /> Editar
              </button>
              <button
                type="button"
                onClick={() => setMode('view')}
                aria-pressed={mode === 'view'}
                className={SEG_BTN}
              >
                <Eye size={13} /> Visualizar
              </button>
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-2 text-sm px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {dirty ? 'Salvar alterações' : 'Salvo'}
            </button>
          </div>
        </div>

        {/* Aviso de contexto */}
        <div className="flex items-start gap-3 rounded-xl border border-brand-500/20 bg-brand-500/5 p-4 text-sm">
          <Sparkles size={16} className="text-brand-300 mt-0.5 shrink-0" />
          <div className="text-zinc-300 leading-relaxed">
            <strong className="text-brand-100">Como funciona:</strong>{' '}
            os 3 documentos abaixo entram <em>inteiros</em> no prompt da IA, antes das regras
            operacionais. Para perguntas frequentes específicas (Q&amp;A), use a aba{' '}
            <em>Conhecimento</em> (RAG vetorizado).
          </div>
        </div>

        {/* 3 textareas */}
        {FIELDS.map((field) => (
          <SourceField
            key={field.key}
            label={field.label}
            hint={field.hint}
            placeholder={field.placeholder}
            value={draft[field.key]}
            onChange={(v) => setDraft({ ...draft, [field.key]: v })}
            mode={mode}
          />
        ))}
      </div>
    </div>
  );
}

function SourceField({
  label,
  hint,
  placeholder,
  value,
  onChange,
  mode,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  mode: 'edit' | 'view';
}) {
  const chars = value.length;
  const MAX = 20_000;
  const tooBig = chars > MAX;
  const isView = mode === 'view';
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-sm font-display font-semibold text-zinc-100">{label}</label>
        {/* Contador é afordância de edição — fica fora do modo leitura. */}
        {!isView && (
          <span
            className={
              tooBig
                ? 'text-[11px] font-mono tabular-nums text-rose-300'
                : 'text-[11px] font-mono tabular-nums text-zinc-600'
            }
          >
            {chars.toLocaleString('pt-BR')} / {MAX.toLocaleString('pt-BR')}
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-500 mb-3">{hint}</p>
      <RichTextEditor value={value} onChange={onChange} placeholder={placeholder} readOnly={isView} />
    </section>
  );
}
