// ============================================================================
// WizardPanel — Configuração "guiada" da IA pra leigos.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada feature do agente (qualificação automática, handoff humano, horário
// comercial, etc) tem um card aqui. Toggle pra ativar + inputs estruturados
// pra config. Saved no Unit via PATCH. O backend (prompt-composer) lê os
// campos e gera o systemPrompt automaticamente — usuário leigo não precisa
// nem ver o prompt.
//
// 8 features:
//   1. Persona (nome, tom, saudação)
//   2. Auto-qualificação Quente/Frio
//   3. Handoff humano por palavras-chave
//   4. Pipeline por intenção
//   5. Coleta de contato proativa
//   6. Cupom de boas-vindas
//   7. Horário comercial
//   8. Follow-up
// + 1 placeholder pra A/B (em construção)
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookText,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Clock,
  Coffee,
  Compass,
  Eye,
  EyeOff,
  Flame,
  Gift,
  Loader2,
  MessageSquarePlus,
  PhoneCall,
  Plus,
  Repeat,
  Save,
  Sparkles,
  TestTube,
  Trash2,
  UserCog,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import type {
  KnowledgeEntry,
  KommoLeadCustomField,
  KommoPipelinesResponse,
  MessageTemplate,
  Unit,
  UnitInput,
} from '../types/api';

type WizardDraft = Pick<
  Unit,
  | 'personaCompanyName'
  | 'personaTone'
  | 'personaGreeting'
  | 'personaResponseLength'
  | 'personaLanguage'
  | 'personaResponseDelaySec'
  | 'personaEmojis'
  | 'personaEmojiFrequency'
  | 'qualificationEnabled'
  | 'qualificationHotTag'
  | 'qualificationColdTag'
  | 'handoffEnabled'
  | 'handoffKeywords'
  | 'pipelineIntents'
  | 'contactCollectionEnabled'
  | 'contactCollectionAfterTurns'
  | 'collectSourceEnabled'
  | 'collectSourceOptions'
  | 'summaryCustomFieldId'
  | 'summaryCustomFieldName'
  | 'welcomeCouponEnabled'
  | 'welcomeCouponMessage'
  | 'businessHoursEnabled'
  | 'businessHoursStart'
  | 'businessHoursEnd'
  | 'businessHoursDays'
  | 'businessHoursTimezone'
  | 'outOfHoursMessage'
  | 'followUpEnabled'
  | 'followUpAfterHours'
  | 'followUpMessage'
>;

const DAYS: Array<{ id: string; label: string }> = [
  { id: 'sun', label: 'Dom' },
  { id: 'mon', label: 'Seg' },
  { id: 'tue', label: 'Ter' },
  { id: 'wed', label: 'Qua' },
  { id: 'thu', label: 'Qui' },
  { id: 'fri', label: 'Sex' },
  { id: 'sat', label: 'Sáb' },
];

const INTENTS: Array<{ key: string; label: string }> = [
  { key: 'asked_quote', label: 'Cliente pediu orçamento/preço' },
  { key: 'confirmed_order', label: 'Cliente confirmou que vai comprar' },
  { key: 'scheduled_meeting', label: 'Cliente agendou reunião/consulta' },
  { key: 'paid', label: 'Cliente confirmou pagamento' },
  { key: 'refused', label: 'Cliente recusou explicitamente' },
];

function unitToDraft(u: Unit): WizardDraft {
  return {
    personaCompanyName: u.personaCompanyName,
    personaTone: u.personaTone,
    personaGreeting: u.personaGreeting,
    personaResponseLength: u.personaResponseLength,
    personaLanguage: u.personaLanguage,
    personaResponseDelaySec: u.personaResponseDelaySec,
    personaEmojis: u.personaEmojis ?? [],
    personaEmojiFrequency: u.personaEmojiFrequency ?? 'normal',
    qualificationEnabled: u.qualificationEnabled,
    qualificationHotTag: u.qualificationHotTag,
    qualificationColdTag: u.qualificationColdTag,
    handoffEnabled: u.handoffEnabled,
    handoffKeywords: u.handoffKeywords ?? [],
    pipelineIntents: u.pipelineIntents,
    contactCollectionEnabled: u.contactCollectionEnabled,
    contactCollectionAfterTurns: u.contactCollectionAfterTurns,
    collectSourceEnabled: u.collectSourceEnabled,
    collectSourceOptions: u.collectSourceOptions ?? [],
    summaryCustomFieldId: u.summaryCustomFieldId,
    summaryCustomFieldName: u.summaryCustomFieldName,
    welcomeCouponEnabled: u.welcomeCouponEnabled,
    welcomeCouponMessage: u.welcomeCouponMessage,
    businessHoursEnabled: u.businessHoursEnabled,
    businessHoursStart: u.businessHoursStart,
    businessHoursEnd: u.businessHoursEnd,
    businessHoursDays: u.businessHoursDays ?? [],
    businessHoursTimezone: u.businessHoursTimezone,
    outOfHoursMessage: u.outOfHoursMessage,
    followUpEnabled: u.followUpEnabled,
    followUpAfterHours: u.followUpAfterHours,
    followUpMessage: u.followUpMessage,
  };
}

export function WizardPanel() {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [pipelines, setPipelines] = useState<KommoPipelinesResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ prompt: string; chars: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  // Campos custom do lead no Kommo — só usado pelo seletor "campo do resumo".
  // Carregado lazy junto com pipelines no load inicial; falha silencia (UI
  // mostra "Kommo não configurado ainda").
  const [kommoFields, setKommoFields] = useState<KommoLeadCustomField[] | null>(null);

  useEffect(() => {
    if (!selectedUnitId) {
      setUnit(null);
      setDraft(null);
      setPipelines(null);
      setKommoFields(null);
      return;
    }
    let alive = true;
    setUnit(null);
    setDraft(null);
    Promise.all([
      api.getUnit(selectedUnitId),
      api.kommoPipelines(selectedUnitId).catch(() => null),
      api.kommoLeadCustomFields(selectedUnitId).catch(() => null),
    ]).then(([u, p, f]) => {
      if (!alive) return;
      setUnit(u);
      setDraft(unitToDraft(u));
      setPipelines(p);
      setKommoFields(f?.ok && f.fields ? f.fields : null);
    });
    return () => {
      alive = false;
    };
  }, [selectedUnitId]);

  // Debounced live preview do prompt composto.
  useEffect(() => {
    if (!selectedUnitId || !draft || !showPreview) return;
    const handler = setTimeout(() => {
      setPreviewLoading(true);
      api
        .previewPrompt(selectedUnitId, draft as Record<string, unknown>)
        .then((p) => setPreview(p))
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 600); // 600ms debounce — não fica disparando a cada keystroke
    return () => clearTimeout(handler);
  }, [selectedUnitId, draft, showPreview]);

  const stages = useMemo(() => {
    const out: Array<{ id: number; label: string }> = [];
    for (const p of pipelines?.pipelines ?? []) {
      if (p.isArchive) continue;
      for (const s of p.statuses) out.push({ id: s.id, label: `${p.name} → ${s.name}` });
    }
    return out;
  }, [pipelines]);

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra configurar a IA.
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

  const dirty = JSON.stringify(draft) !== JSON.stringify(unitToDraft(unit));

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await api.updateUnit(selectedUnitId!, draft as Partial<UnitInput>);
      setUnit(updated);
      setDraft(unitToDraft(updated));
      toast.success('Configuração salva. A IA já vai usar na próxima mensagem.');
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao salvar: ${e?.message ?? 'erro'}`);
    } finally {
      setSaving(false);
    }
  }

  const update = (patch: Partial<WizardDraft>) => setDraft({ ...draft, ...patch });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        {/* Header sticky */}
        <div className="flex items-center justify-between sticky top-0 bg-zinc-950/95 backdrop-blur py-3 z-10 border-b border-zinc-800/60">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <Sparkles size={18} className="text-brand-300" />
              ✨ Configurar a IA
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Modo guiado: ative só o que quer, preencha os campos, e salve. A IA usa as novas
              configurações na próxima mensagem. 🚀
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shadow-lg shadow-brand-500/20"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Salvando…' : dirty ? 'Salvar alterações' : 'Salvo'}
          </button>
        </div>

        {/* 1. PERSONA */}
        <FeatureCard
          icon={<UserCog size={16} className="text-brand-300" />}
          title="🎭 Persona da IA"
          subtitle="Quem é o agente, como ele fala."
          enabled
          alwaysOn
        >
          <div className="grid md:grid-cols-2 gap-3">
            <TextField
              label="Nome da empresa"
              value={draft.personaCompanyName ?? ''}
              onChange={(v) => update({ personaCompanyName: v || null })}
              placeholder="ex: HM Tecnologia"
            />
            <SelectField
              label="Tom de voz"
              value={draft.personaTone ?? ''}
              onChange={(v) => update({ personaTone: (v || null) as WizardDraft['personaTone'] })}
              options={[
                { value: '', label: 'Equilibrado (padrão)' },
                { value: 'friendly', label: '😊 Amigável e caloroso' },
                { value: 'casual', label: '🤙 Descontraído' },
                { value: 'formal', label: '🎩 Formal e profissional' },
              ]}
            />
          </div>
          <TextField
            label="Saudação preferida (opcional)"
            value={draft.personaGreeting ?? ''}
            onChange={(v) => update({ personaGreeting: v || null })}
            placeholder='ex: "Olá, tudo bem? Sou o assistente virtual da HM Tecnologia, em que posso te ajudar?"'
          />
          <div className="grid md:grid-cols-3 gap-3 mt-2">
            <SelectField
              label="Tamanho da resposta"
              value={draft.personaResponseLength}
              onChange={(v) =>
                update({ personaResponseLength: v as WizardDraft['personaResponseLength'] })
              }
              options={[
                { value: 'curta', label: '✂️ Curta (1 frase)' },
                { value: 'normal', label: '📝 Normal (1-3 frases)' },
                { value: 'detalhada', label: '📄 Detalhada (parágrafo)' },
              ]}
            />
            <SelectField
              label="Idioma"
              value={draft.personaLanguage}
              onChange={(v) =>
                update({ personaLanguage: v as WizardDraft['personaLanguage'] })
              }
              options={[
                { value: 'pt-BR', label: '🇧🇷 Português (BR)' },
                { value: 'en-US', label: '🇺🇸 English (US)' },
                { value: 'es-ES', label: '🇪🇸 Español' },
                { value: 'fr-FR', label: '🇫🇷 Français' },
              ]}
            />
            <NumberField
              label="Pausa antes de responder (s)"
              value={draft.personaResponseDelaySec}
              onChange={(v) => update({ personaResponseDelaySec: v })}
              min={0}
              max={30}
              hint="0 = imediato. Simula 'digitando…' humano."
            />
          </div>
          <div className="mt-3">
            <EmojiPaletteField
              emojis={draft.personaEmojis}
              frequency={draft.personaEmojiFrequency}
              onChangeEmojis={(arr) => update({ personaEmojis: arr })}
              onChangeFrequency={(f) => update({ personaEmojiFrequency: f })}
            />
          </div>
        </FeatureCard>

        {/* 2. AUTO-QUALIFICAÇÃO */}
        <FeatureCard
          icon={<Flame size={16} className="text-orange-400" />}
          title="🔥 Auto-qualificação Quente/Frio"
          subtitle="A IA aplica tags automaticamente conforme o interesse do cliente."
          enabled={draft.qualificationEnabled}
          onToggle={(v) => update({ qualificationEnabled: v })}
        >
          <p className="text-[11px] text-zinc-400 mb-2">
            Quente: cliente demonstrou compra/urgência. Frio: cliente sem interesse ou pediu pra não
            ser contatado.
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <TextField
              label="Tag pra leads quentes"
              value={draft.qualificationHotTag}
              onChange={(v) => update({ qualificationHotTag: v })}
              placeholder="Quente"
            />
            <TextField
              label="Tag pra leads frios"
              value={draft.qualificationColdTag}
              onChange={(v) => update({ qualificationColdTag: v })}
              placeholder="Frio"
            />
          </div>
        </FeatureCard>

        {/* 3. HANDOFF HUMANO */}
        <FeatureCard
          icon={<PhoneCall size={16} className="text-rose-400" />}
          title="🙋‍♀️ Handoff humano automático"
          subtitle="Quando o cliente usa certas palavras, a IA pausa e chama um humano."
          enabled={draft.handoffEnabled}
          onToggle={(v) => update({ handoffEnabled: v })}
        >
          <p className="text-[11px] text-zinc-400 mb-2">
            Lista de palavras/frases. Se o cliente usar qualquer uma, a IA pausa imediatamente e
            envia: "Vou chamar alguém da equipe pra te atender. Um instante 🙏".
          </p>
          <KeywordList
            keywords={draft.handoffKeywords}
            onChange={(kws) => update({ handoffKeywords: kws })}
            placeholder="ex: humano, atendente, falar com pessoa"
          />
        </FeatureCard>

        {/* 3b. RESUMO EM CAMPO CUSTOM */}
        <FeatureCard
          icon={<BookText size={16} className="text-amber-400" />}
          title="📝 Resumo no campo do Kommo"
          subtitle="Quando a IA gera resumo (handoff/transfer), também grava num custom field do lead."
          enabled={!!draft.summaryCustomFieldId}
          alwaysOn
        >
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            A tool{' '}
            <code className="text-[10px] px-1 py-0.5 rounded bg-zinc-900 text-amber-300">
              resumir_lead_para_sdr
            </code>{' '}
            sempre posta o resumo como nota interna (histórico). Quando você escolhe um campo
            abaixo, o último resumo também aparece direto no card pra o SDR encontrar
            rapidamente. Sugestão: campo <em>Observações</em>.
          </p>
          <div className="mt-3">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
              Campo de destino
            </label>
            {kommoFields === null ? (
              <div className="text-[11px] text-zinc-500 italic px-3 py-2 rounded-md bg-zinc-950/60 border border-zinc-800/60">
                Configure o Kommo (subdomínio + token) primeiro pra listar os campos.
              </div>
            ) : (
              <select
                value={draft.summaryCustomFieldId ?? ''}
                onChange={(e) => {
                  const idStr = e.target.value;
                  if (!idStr) {
                    update({ summaryCustomFieldId: null, summaryCustomFieldName: null });
                    return;
                  }
                  const id = Number(idStr);
                  const field = kommoFields.find((f) => f.id === id);
                  if (!field) return;
                  update({
                    summaryCustomFieldId: id,
                    summaryCustomFieldName: field.name,
                  });
                }}
                className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-brand-500/40 rounded-md px-3 py-2 text-sm text-zinc-100 outline-none transition"
              >
                <option value="">— Nenhum (só nota interna) —</option>
                {kommoFields
                  .filter((f) => f.type === 'text' || f.type === 'textarea')
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.type})
                    </option>
                  ))}
              </select>
            )}
            <p className="text-[11px] text-zinc-600 mt-1">
              Mostra só campos do tipo <code>text</code>/<code>textarea</code> — os outros tipos
              não cabem texto livre.
            </p>
          </div>
        </FeatureCard>

        {/* 4. PIPELINE INTENTS */}
        <FeatureCard
          icon={<WorkflowIcon size={16} className="text-sky-400" />}
          title="🔀 Pipeline automático por intenção"
          subtitle="A IA move o lead de etapa baseado no que o cliente diz."
          enabled={!!draft.pipelineIntents && Object.keys(draft.pipelineIntents).length > 0}
          onToggle={(v) =>
            update({ pipelineIntents: v ? draft.pipelineIntents ?? {} : null })
          }
        >
          <p className="text-[11px] text-zinc-400 mb-3">
            Pra cada intenção, escolha pra qual etapa do funil o lead deve ir.
          </p>
          {stages.length === 0 && (
            <div className="text-[11px] text-amber-300 mb-2">
              ⚠ Etapas não carregaram. Confira o token do Kommo na aba Unidades.
            </div>
          )}
          <div className="space-y-2">
            {INTENTS.map((intent) => {
              const current = (draft.pipelineIntents ?? {})[intent.key] ?? null;
              return (
                <div key={intent.key} className="flex items-center gap-2">
                  <span className="text-xs text-zinc-300 flex-1">{intent.label}</span>
                  <select
                    value={current ?? ''}
                    onChange={(e) => {
                      const id = e.target.value ? Number(e.target.value) : null;
                      const next = { ...(draft.pipelineIntents ?? {}) };
                      if (id) next[intent.key] = id;
                      else delete next[intent.key];
                      update({ pipelineIntents: Object.keys(next).length ? next : null });
                    }}
                    className="w-72 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500"
                  >
                    <option value="">— não mover —</option>
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </FeatureCard>

        {/* 5. COLETA DE CONTATO */}
        <FeatureCard
          icon={<MessageSquarePlus size={16} className="text-emerald-400" />}
          title="📩 Coleta proativa de contato"
          subtitle="Depois de N turnos, a IA pede email/telefone com naturalidade."
          enabled={draft.contactCollectionEnabled}
          onToggle={(v) => update({ contactCollectionEnabled: v })}
        >
          <div className="grid md:grid-cols-2 gap-3">
            <NumberField
              label="Pedir contato após quantos turnos?"
              value={draft.contactCollectionAfterTurns}
              onChange={(v) => update({ contactCollectionAfterTurns: Math.max(1, v) })}
              min={1}
              max={20}
            />
          </div>
          <p className="text-[11px] text-zinc-500 mt-2">
            Em ${draft.contactCollectionAfterTurns} turnos, a IA pergunta o email/WhatsApp uma vez,
            só se ainda não tiver coletado.
          </p>
        </FeatureCard>

        {/* 5c. COLETAR ORIGEM (POR ONDE CONHECEU) */}
        <FeatureCard
          icon={<Compass size={16} className="text-teal-400" />}
          title="🧭 Como conheceu a clínica"
          subtitle="A IA pergunta a origem e aplica tag 'Origem: <fonte>' no lead."
          enabled={draft.collectSourceEnabled}
          onToggle={(v) => update({ collectSourceEnabled: v })}
        >
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            A IA faz UMA pergunta natural sobre por onde o lead chegou na clínica. Quando ele
            responder (Instagram, indicação, Google…), aplica uma tag{' '}
            <code className="text-[10px] px-1 py-0.5 rounded bg-zinc-900 text-teal-300">
              Origem: &lt;fonte&gt;
            </code>{' '}
            no Kommo pra você medir canais que mais convertem.
          </p>
          <div className="mt-3">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
              Opções sugeridas (a IA cita naturalmente)
            </label>
            <KeywordList
              keywords={draft.collectSourceOptions}
              onChange={(opts) => update({ collectSourceOptions: opts })}
              placeholder="ex: Instagram, Google, Indicação, TikTok"
            />
          </div>
          <div className="mt-2 rounded-md bg-zinc-950/60 border border-zinc-800/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">
              Exemplo de pergunta da IA
            </div>
            <div className="text-[11px] text-zinc-300 italic">
              "Aproveitando: por onde você nos conheceu? 🤔 (Instagram, indicação…)"
            </div>
          </div>
        </FeatureCard>

        {/* 6. CUPOM */}
        <FeatureCard
          icon={<Gift size={16} className="text-pink-400" />}
          title="🎁 Cupom de boas-vindas"
          subtitle="Primeiro contato? A IA oferece um cupom."
          enabled={draft.welcomeCouponEnabled}
          onToggle={(v) => update({ welcomeCouponEnabled: v })}
        >
          <TextareaField
            label="Mensagem do cupom"
            value={draft.welcomeCouponMessage ?? ''}
            onChange={(v) => update({ welcomeCouponMessage: v || null })}
            placeholder='ex: "Como é seu primeiro contato, tem 10% de desconto no primeiro pedido — código BEMVINDO10"'
            rows={2}
          />
        </FeatureCard>

        {/* 7. HORÁRIO COMERCIAL */}
        <FeatureCard
          icon={<Clock size={16} className="text-amber-400" />}
          title="🕒 Horário comercial"
          subtitle="Fora desse intervalo, a IA não responde — manda uma mensagem padrão."
          enabled={draft.businessHoursEnabled}
          onToggle={(v) => update({ businessHoursEnabled: v })}
        >
          <div className="grid md:grid-cols-3 gap-3">
            <NumberField
              label="Início (0-23)"
              value={draft.businessHoursStart}
              onChange={(v) => update({ businessHoursStart: Math.min(23, Math.max(0, v)) })}
              min={0}
              max={23}
            />
            <NumberField
              label="Fim (0-23)"
              value={draft.businessHoursEnd}
              onChange={(v) => update({ businessHoursEnd: Math.min(23, Math.max(0, v)) })}
              min={0}
              max={23}
            />
            <TextField
              label="Fuso"
              value={draft.businessHoursTimezone}
              onChange={(v) => update({ businessHoursTimezone: v })}
              placeholder="America/Sao_Paulo"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
              Dias da semana
            </label>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d) => {
                const checked = draft.businessHoursDays.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      const next = checked
                        ? draft.businessHoursDays.filter((x) => x !== d.id)
                        : [...draft.businessHoursDays, d.id];
                      update({ businessHoursDays: next });
                    }}
                    className={clsx(
                      'px-2.5 py-1 rounded-md text-xs transition',
                      checked
                        ? 'bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/40'
                        : 'bg-zinc-900 text-zinc-500 ring-1 ring-zinc-800 hover:text-zinc-300',
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
          <TextareaField
            label="Mensagem fora do horário"
            value={draft.outOfHoursMessage ?? ''}
            onChange={(v) => update({ outOfHoursMessage: v || null })}
            placeholder='ex: "Oi! Estamos atendendo de segunda a sexta, das 9h às 18h. Te respondemos amanhã cedo 🙏"'
            rows={2}
          />
        </FeatureCard>

        {/* 8. FOLLOW-UP */}
        <FeatureCard
          icon={<Repeat size={16} className="text-violet-400" />}
          title="🔁 Follow-up educado"
          subtitle="A IA termina conversas inacabadas com um follow-up cordial."
          enabled={draft.followUpEnabled}
          onToggle={(v) => update({ followUpEnabled: v })}
        >
          <p className="text-[11px] text-amber-300/80 mb-2">
            ⚠ Versão atual: a IA só MENCIONA follow-up no fim da conversa (ex: "Te chamo amanhã").
            O envio agendado automático ainda está em construção.
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <NumberField
              label="Voltar a falar após quantas horas?"
              value={draft.followUpAfterHours}
              onChange={(v) => update({ followUpAfterHours: Math.max(1, v) })}
              min={1}
              max={168}
            />
          </div>
          <TextareaField
            label="Mensagem de follow-up"
            value={draft.followUpMessage ?? ''}
            onChange={(v) => update({ followUpMessage: v || null })}
            placeholder='ex: "Sem pressão! Te chamo amanhã pra ver se posso ajudar em algo, tá bom?"'
            rows={2}
          />
        </FeatureCard>

        {/* 9. A/B PROMPTS (placeholder) */}
        <FeatureCard
          icon={<TestTube size={16} className="text-zinc-500" />}
          title="🧪 A/B test de prompts"
          subtitle="Compare versões do prompt e veja qual converte mais."
          enabled={false}
          disabled
          comingSoonNote="Em construção. O juiz LLM já existe (veja a aba Prompts) — falta linkar versões a conversas."
        >
          <div className="text-[11px] text-zinc-500">
            Quando ativada, esta feature vai permitir manter 2+ versões do prompt em paralelo,
            distribuir tráfego entre elas, e usar o juiz LLM existente pra comparar performance.
          </div>
        </FeatureCard>

        {/* 10. TEMPLATES DE MENSAGEM */}
        <TemplatesSection unitId={selectedUnitId} />

        {/* 11. BASE DE CONHECIMENTO (RAG) */}
        <KnowledgeSection unitId={selectedUnitId} />

        {/* Live preview do prompt composto */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview)}
            className="w-full flex items-center gap-2 p-4 text-left hover:bg-zinc-900/40 transition-colors"
          >
            {showPreview ? (
              <Eye size={16} className="text-emerald-400" />
            ) : (
              <EyeOff size={16} className="text-zinc-500" />
            )}
            <div className="flex-1">
              <div className="text-sm font-semibold text-zinc-100">
                Preview do prompt da IA
              </div>
              <div className="text-[11px] text-zinc-500 mt-0.5">
                Veja exatamente o que a IA vai ler quando o cliente mandar uma mensagem.
                Atualiza automaticamente conforme você muda os toggles acima.
              </div>
            </div>
            {previewLoading && <Loader2 size={14} className="animate-spin text-zinc-500" />}
            {preview && !previewLoading && (
              <span className="text-[10px] font-mono text-zinc-600">{preview.chars} chars</span>
            )}
            {showPreview ? (
              <ChevronDown size={14} className="text-zinc-600" />
            ) : (
              <ChevronRight size={14} className="text-zinc-600" />
            )}
          </button>
          {showPreview && (
            <div className="border-t border-zinc-800/40 p-4">
              {!preview ? (
                <div className="text-xs text-zinc-600 italic">Calculando preview…</div>
              ) : (
                <pre className="text-[11px] font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed bg-zinc-950 rounded-md p-3 border border-zinc-800/40 max-h-96 overflow-y-auto">
                  {preview.prompt || '<vazio>'}
                </pre>
              )}
            </div>
          )}
        </section>

        {/* Café no fim */}
        <div className="text-center text-zinc-700 text-xs py-4 flex items-center justify-center gap-2">
          <Coffee size={12} />
          Configurado tudo? Clica em "Salvar alterações" no topo.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponentes
// ---------------------------------------------------------------------------

function FeatureCard({
  icon,
  title,
  subtitle,
  enabled,
  onToggle,
  alwaysOn,
  disabled,
  comingSoonNote,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  enabled: boolean;
  onToggle?: (v: boolean) => void;
  alwaysOn?: boolean;
  disabled?: boolean;
  comingSoonNote?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(enabled || !!alwaysOn);
  useEffect(() => {
    if (enabled || alwaysOn) setOpen(true);
  }, [enabled, alwaysOn]);

  return (
    <section
      className={clsx(
        'rounded-xl border transition-colors',
        disabled
          ? 'border-zinc-800/60 bg-zinc-950/30 opacity-70'
          : enabled || alwaysOn
            ? 'border-brand-500/30 bg-brand-500/5'
            : 'border-zinc-800 bg-zinc-900/40',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-4 text-left"
        disabled={disabled}
      >
        <div className="shrink-0">{icon}</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            {title}
            {comingSoonNote && (
              <span className="text-[9px] uppercase tracking-wider bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                em breve
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</div>
        </div>
        {!alwaysOn && !disabled && onToggle && (
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle value={enabled} onChange={onToggle} />
          </div>
        )}
        {(open || alwaysOn) ? (
          <ChevronDown size={14} className="text-zinc-600" />
        ) : (
          <ChevronRight size={14} className="text-zinc-600" />
        )}
      </button>
      {(open || alwaysOn) && (enabled || alwaysOn || disabled) && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-zinc-800/40">
          {comingSoonNote && (
            <div className="text-[11px] text-zinc-500 italic">{comingSoonNote}</div>
          )}
          {children}
        </div>
      )}
    </section>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={clsx(
        'relative inline-flex h-5 w-9 items-center rounded-full transition',
        value ? 'bg-brand-500' : 'bg-zinc-700',
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition',
          value ? 'translate-x-5' : 'translate-x-1',
        )}
      />
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
        {label}
      </label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 font-mono focus:outline-none focus:border-brand-500"
      />
      {hint && <p className="text-[10px] text-zinc-500 mt-1">{hint}</p>}
    </div>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500 resize-vertical"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function KeywordList({
  keywords,
  onChange,
  placeholder,
}: {
  keywords: string[];
  onChange: (kws: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');

  function commit() {
    const v = input.trim();
    if (!v) return;
    if (keywords.includes(v)) {
      setInput('');
      return;
    }
    onChange([...keywords, v]);
    setInput('');
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {keywords.length === 0 && (
          <span className="text-[11px] text-zinc-600 italic">Nenhuma palavra cadastrada ainda.</span>
        )}
        {keywords.map((kw) => (
          <span
            key={kw}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-200 text-xs ring-1 ring-rose-500/30"
          >
            {kw}
            <button
              type="button"
              onClick={() => onChange(keywords.filter((x) => x !== kw))}
              className="text-rose-300 hover:text-rose-100"
              title="Remover"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="flex-1 px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500"
        />
        <button
          type="button"
          onClick={commit}
          disabled={!input.trim()}
          className="px-3 py-1.5 rounded-md bg-zinc-800 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
        >
          Adicionar
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// EmojiPaletteField — paleta de emojis configurável + frequência de uso.
// ===========================================================================

const EMOJI_SUGGESTIONS = [
  '😊', '😉', '🥰', '🤗', '🙏', '👋', '👏', '💜', '💙', '💚',
  '🌷', '🌸', '🌟', '✨', '🌈', '☀️', '☕', '🍃', '🌿', '🎉',
  '😄', '😅', '🙌', '👌', '👍', '💪', '🔥', '⚡', '💡', '🎯',
  '😢', '😔', '🥺', '🤔', '🙇', '🤝', '❤️‍🩹', '🩺', '💊', '🏥',
];

function EmojiPaletteField({
  emojis,
  frequency,
  onChangeEmojis,
  onChangeFrequency,
}: {
  emojis: string[];
  frequency: 'low' | 'normal' | 'high';
  onChangeEmojis: (arr: string[]) => void;
  onChangeFrequency: (f: 'low' | 'normal' | 'high') => void;
}) {
  const [input, setInput] = useState('');

  function addEmoji(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (emojis.includes(v)) {
      setInput('');
      return;
    }
    onChangeEmojis([...emojis, v]);
    setInput('');
  }

  function remove(emoji: string) {
    onChangeEmojis(emojis.filter((e) => e !== emoji));
  }

  const unusedSuggestions = EMOJI_SUGGESTIONS.filter((e) => !emojis.includes(e));

  return (
    <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-3">
      <div className="flex items-center justify-between mb-2">
        <label className="text-[10px] uppercase tracking-wider text-fuchsia-200 font-semibold">
          🎨 Paleta de emojis (use livremente)
        </label>
        <select
          value={frequency}
          onChange={(e) => onChangeFrequency(e.target.value as 'low' | 'normal' | 'high')}
          className="text-[11px] px-2 py-1 rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100 focus:outline-none focus:border-fuchsia-500"
        >
          <option value="low">🪶 Frequência baixa (1 por msg)</option>
          <option value="normal">✨ Normal (1-2 por msg)</option>
          <option value="high">🎉 Alta (2-4 por msg, bem caloroso)</option>
        </select>
      </div>

      <p className="text-[11px] text-zinc-400 mb-2">
        Adicione quantos emojis quiser. A IA vai usá-los livremente nas respostas pra deixar
        a conversa mais bonita e calorosa. ✨ Vazio = sem instrução, herda só do tom de voz.
      </p>

      {/* Emojis selecionados */}
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-9 p-2 rounded-md bg-zinc-950/60 border border-zinc-800/60">
        {emojis.length === 0 ? (
          <span className="text-[11px] text-zinc-600 italic self-center">
            Nenhum emoji ainda. Cole abaixo ou clique nas sugestões. 👇
          </span>
        ) : (
          emojis.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => remove(e)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-fuchsia-500/15 ring-1 ring-fuchsia-500/40 text-base hover:bg-rose-500/15 hover:ring-rose-500/40 transition-colors"
              title="Clique pra remover"
            >
              <span>{e}</span>
            </button>
          ))
        )}
      </div>

      {/* Input livre */}
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addEmoji(input);
            }
          }}
          placeholder="Cole ou digite qualquer emoji…  Enter pra adicionar"
          className="flex-1 px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-base text-zinc-100 focus:outline-none focus:border-fuchsia-500"
        />
        <button
          type="button"
          onClick={() => addEmoji(input)}
          disabled={!input.trim()}
          className="px-3 py-1.5 rounded-md bg-fuchsia-500/20 ring-1 ring-fuchsia-500/40 text-xs text-fuchsia-100 hover:bg-fuchsia-500/30 disabled:opacity-50"
        >
          Adicionar
        </button>
      </div>

      {/* Sugestões clicáveis */}
      {unusedSuggestions.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
            Sugestões (clique pra adicionar)
          </div>
          <div className="flex flex-wrap gap-1">
            {unusedSuggestions.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => addEmoji(e)}
                className="text-base px-1.5 py-0.5 rounded hover:bg-fuchsia-500/15 hover:ring-1 hover:ring-fuchsia-500/40 transition-colors"
                title="Adicionar à paleta"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// TemplatesSection — CRUD de respostas prontas (MessageTemplate)
// ===========================================================================

function TemplatesSection({ unitId }: { unitId: string | null }) {
  const toast = useToast();
  const [items, setItems] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!unitId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listTemplates(unitId);
      setItems(list);
    } catch {
      toast.error('Não foi possível carregar templates');
    } finally {
      setLoading(false);
    }
  }, [unitId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!unitId) return;
    setCreating(true);
    try {
      const t = await api.createTemplate(unitId, {
        name: 'Novo template',
        triggerKeywords: [],
        response: '',
      });
      setItems([...items, t]);
      toast.success('Template criado');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error === 'template_name_duplicate' ? 'Já existe um template com esse nome' : 'Falha ao criar');
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdate(t: MessageTemplate, patch: Partial<MessageTemplate>) {
    if (!unitId) return;
    const optimistic = items.map((x) => (x.id === t.id ? { ...x, ...patch } : x));
    setItems(optimistic);
    try {
      await api.updateTemplate(unitId, t.id, patch);
    } catch {
      toast.error('Falha ao salvar template');
      void load();
    }
  }

  async function handleDelete(t: MessageTemplate) {
    if (!unitId) return;
    if (!confirm(`Apagar template "${t.name}"?`)) return;
    setItems(items.filter((x) => x.id !== t.id));
    try {
      await api.deleteTemplate(unitId, t.id);
      toast.success('Template apagado');
    } catch {
      toast.error('Falha ao apagar');
      void load();
    }
  }

  return (
    <section className="rounded-xl border border-cyan-500/20 bg-cyan-500/5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-4 text-left"
      >
        <BookText size={16} className="text-cyan-300" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-zinc-100">Templates de mensagens</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            Respostas prontas que a IA usa quando detecta palavras-chave. Reduz alucinação em FAQs.
          </div>
        </div>
        <span className="text-[10px] text-zinc-500">{items.length} template(s)</span>
        {open ? <ChevronDown size={14} className="text-zinc-600" /> : <ChevronRight size={14} className="text-zinc-600" />}
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-zinc-800/40">
          {loading && <div className="text-[11px] text-zinc-600">Carregando…</div>}
          {!loading && items.length === 0 && (
            <div className="text-[11px] text-zinc-600 italic text-center py-2">
              Nenhum template ainda. Clique em "+ Novo" pra criar o primeiro.
            </div>
          )}
          {items.map((t) => (
            <div key={t.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={t.name}
                  onChange={(e) => handleUpdate(t, { name: e.target.value })}
                  className="flex-1 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 font-semibold focus:outline-none focus:border-brand-500"
                />
                <button
                  type="button"
                  onClick={() => handleDelete(t)}
                  className="text-rose-400 hover:text-rose-200 p-1"
                  title="Apagar template"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Palavras-chave de gatilho</label>
                <KeywordList
                  keywords={t.triggerKeywords}
                  onChange={(kws) => handleUpdate(t, { triggerKeywords: kws })}
                  placeholder="ex: preço, valor, quanto custa"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Resposta</label>
                <textarea
                  value={t.response}
                  onChange={(e) => handleUpdate(t, { response: e.target.value })}
                  rows={3}
                  placeholder="Resposta que a IA deve dar quando match"
                  className="w-full px-2 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500 resize-vertical"
                />
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !unitId}
            className="w-full inline-flex items-center justify-center gap-1 px-3 py-2 rounded-md border border-dashed border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-900/40 disabled:opacity-50"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Novo template
          </button>
        </div>
      )}
    </section>
  );
}


// ===========================================================================
// KnowledgeSection — CRUD da base de conhecimento (RAG semântico)
// ===========================================================================
// Cada entrada é embedda no backend (OpenAI text-embedding-3-small).
// O composer faz busca semântica em runtime e injeta as 3 mais
// relevantes no prompt. Diferente de templates (busca por keyword), aqui
// é busca por SIGNIFICADO.

function KnowledgeSection({ unitId }: { unitId: string | null }) {
  const toast = useToast();
  const [items, setItems] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ question: '', answer: '' });

  const load = useCallback(async () => {
    if (!unitId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listKnowledge(unitId);
      setItems(list);
    } catch {
      toast.error('Não foi possível carregar a base de conhecimento');
    } finally {
      setLoading(false);
    }
  }, [unitId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!unitId) return;
    if (!draft.question.trim() || !draft.answer.trim()) {
      toast.error('Preencha pergunta e resposta');
      return;
    }
    setCreating(true);
    try {
      const e = await api.createKnowledge(unitId, draft);
      setItems([e, ...items]);
      setDraft({ question: '', answer: '' });
      toast.success('Conhecimento adicionado');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error ?? 'Falha ao criar');
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdate(e: KnowledgeEntry, patch: Partial<KnowledgeEntry>) {
    if (!unitId) return;
    const optimistic = items.map((x) => (x.id === e.id ? { ...x, ...patch } : x));
    setItems(optimistic);
    try {
      await api.updateKnowledge(unitId, e.id, patch);
    } catch {
      toast.error('Falha ao atualizar');
      void load();
    }
  }

  async function handleDelete(e: KnowledgeEntry) {
    if (!unitId) return;
    if (!confirm(`Apagar conhecimento "${e.question.slice(0, 60)}..."?`)) return;
    setItems(items.filter((x) => x.id !== e.id));
    try {
      await api.deleteKnowledge(unitId, e.id);
      toast.success('Apagado');
    } catch {
      toast.error('Falha ao apagar');
      void load();
    }
  }

  return (
    <section className="rounded-xl border border-violet-500/20 bg-violet-500/5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-4 text-left"
      >
        <BrainCircuit size={16} className="text-violet-300" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-zinc-100">
            Base de conhecimento (RAG)
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            Perguntas e respostas reais. A IA busca por significado (não keyword)
            e usa as mais relevantes pra responder. Reduz alucinação a quase zero.
          </div>
        </div>
        <span className="text-[10px] text-zinc-500">{items.length} entrada(s)</span>
        {open ? <ChevronDown size={14} className="text-zinc-600" /> : <ChevronRight size={14} className="text-zinc-600" />}
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-zinc-800/40">
          {/* Form de criação */}
          <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
              Nova entrada
            </div>
            <input
              type="text"
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              placeholder="Pergunta típica (ex: 'qual o horário de funcionamento?')"
              className="w-full px-2 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-violet-500"
            />
            <textarea
              value={draft.answer}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
              rows={3}
              placeholder="Resposta oficial (ex: 'Atendemos de segunda a sexta, das 9h às 18h, no endereço X.')"
              className="w-full px-2 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-violet-500 resize-vertical"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !unitId || !draft.question.trim() || !draft.answer.trim()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-violet-500/20 text-violet-200 ring-1 ring-violet-500/40 text-xs hover:bg-violet-500/30 disabled:opacity-50"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Adicionar conhecimento
            </button>
          </div>

          {/* Lista existente */}
          {loading && <div className="text-[11px] text-zinc-600">Carregando…</div>}
          {!loading && items.length === 0 && (
            <div className="text-[11px] text-zinc-600 italic text-center py-2">
              Nenhuma entrada ainda. Comece adicionando perguntas frequentes acima.
            </div>
          )}
          {items.map((e) => (
            <details key={e.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 group">
              <summary className="px-3 py-2 text-xs text-zinc-200 cursor-pointer flex items-center gap-2 hover:bg-zinc-900/40">
                <span className="flex-1 truncate font-medium">{e.question}</span>
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.preventDefault();
                    void handleDelete(e);
                  }}
                  className="text-rose-400 hover:text-rose-200 opacity-0 group-hover:opacity-100"
                  title="Apagar"
                >
                  <Trash2 size={12} />
                </button>
              </summary>
              <div className="px-3 pb-3 pt-1 space-y-2 border-t border-zinc-800/40">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Pergunta</label>
                  <input
                    type="text"
                    value={e.question}
                    onChange={(ev) => handleUpdate(e, { question: ev.target.value })}
                    className="w-full px-2 py-1 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-violet-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Resposta</label>
                  <textarea
                    value={e.answer}
                    onChange={(ev) => handleUpdate(e, { answer: ev.target.value })}
                    rows={3}
                    className="w-full px-2 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-violet-500 resize-vertical"
                  />
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
