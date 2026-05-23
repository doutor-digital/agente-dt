// ============================================================================
// TrainingPanel — Hub consolidado de "treinar a IA" por-unidade.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Não reimplementa. CONSOLIDA. As 4 telas existentes (Fontes/Conhecimento,
// Fontes/Templates, Conversas/Flag, Wizard/Persona) cada uma cuida do CRUD
// completo. Aqui é um hub que:
//   - Mostra contadores agregados pra dar sensação de progresso
//   - Permite quick-add inline pros 2 itens mais frequentes (Conhecimento +
//     Template) — uma usuária leiga não precisa sair daqui pra alimentar
//   - Mostra últimos itens recentes (visibilidade do que já tem)
//   - Deep-links pras telas completas pra ações avançadas (editar, deletar,
//     ver tudo)
//   - Mostra correções (flagged) read-only — flag em si vive na conversa
//
// Por que um hub? Treino estava espalhado em 4 lugares com mental models
// diferentes. Leiga não sabia "Knowledge é treino", "Template é treino",
// "Flag é treino". Aqui tudo é "treino" e o resto é só atalho.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Book,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  Loader2,
  MessageSquare,
  Plus,
  Sparkles,
  ThumbsDown,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import type { AppTab } from './AppSidebar';
import type {
  FlaggedMessage,
  KnowledgeEntry,
  MessageTemplate,
} from '../types/api';

interface TrainingPanelProps {
  onNavigate: (tab: AppTab) => void;
}

export function TrainingPanel({ onNavigate }: TrainingPanelProps) {
  const { selectedUnitId, selectedUnit } = useUnit();
  const toast = useToast();

  const [knowledge, setKnowledge] = useState<KnowledgeEntry[] | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [flagged, setFlagged] = useState<FlaggedMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!selectedUnitId) {
      setKnowledge(null);
      setTemplates(null);
      setFlagged(null);
      return;
    }
    setLoading(true);
    try {
      const [k, t, f] = await Promise.all([
        api.listKnowledge(selectedUnitId),
        api.listTemplates(selectedUnitId),
        api.listFlaggedMessages(selectedUnitId).catch(() => [] as FlaggedMessage[]),
      ]);
      setKnowledge(k);
      setTemplates(t);
      setFlagged(f);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao carregar treino: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [selectedUnitId, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra treinar a IA.
      </div>
    );
  }

  const counts = {
    knowledge: knowledge?.length ?? 0,
    templates: templates?.length ?? 0,
    flagged: flagged?.length ?? 0,
  };
  const totalSignals = counts.knowledge + counts.templates + counts.flagged;
  const trainingLevel = computeLevel(totalSignals);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <header className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-violet-500/10 ring-1 ring-violet-500/30 flex items-center justify-center shrink-0">
            <GraduationCap size={22} className="text-violet-300" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-zinc-100 flex items-center gap-2">
              Treinar IA
              {selectedUnit && (
                <span className="text-xs text-zinc-500 font-normal">
                  · {selectedUnit.personaCompanyName ?? selectedUnit.name}
                </span>
              )}
            </h1>
            <p className="text-sm text-zinc-400 mt-1 leading-relaxed">
              Quanto mais você "ensina" a IA, mais esperta ela fica. Aqui ficam reunidas as
              4 formas de treino — você só precisa preencher o que faz sentido pra sua clínica.
            </p>
          </div>
        </header>

        {/* Status de treino — barra de "nível" */}
        <LevelCard
          level={trainingLevel}
          knowledge={counts.knowledge}
          templates={counts.templates}
          flagged={counts.flagged}
          loading={loading && knowledge === null}
        />

        {/* Conhecimento */}
        <KnowledgeSection
          unitId={selectedUnitId}
          items={knowledge}
          onChange={reload}
          onSeeAll={() => onNavigate('sources')}
        />

        {/* Templates */}
        <TemplatesSection
          unitId={selectedUnitId}
          items={templates}
          onChange={reload}
          onSeeAll={() => onNavigate('sources')}
        />

        {/* Correções (flagged) */}
        <FlaggedSection
          items={flagged}
          onSeeAll={() => onNavigate('conversations')}
        />

        {/* Persona */}
        <PersonaSection onEdit={() => onNavigate('wizard')} />
      </div>
    </div>
  );
}

// ===========================================================================
// Level card
// ===========================================================================

function computeLevel(signals: number): { label: string; color: string; pct: number } {
  // Heurística simples — não é ciência. Mostra progresso pra dar feedback
  // motivacional pra leiga ver que está "construindo" algo.
  if (signals === 0) return { label: 'Sem treino ainda', color: 'zinc', pct: 0 };
  if (signals < 5) return { label: 'Iniciante', color: 'amber', pct: 25 };
  if (signals < 15) return { label: 'Em formação', color: 'sky', pct: 50 };
  if (signals < 30) return { label: 'Bem treinada', color: 'violet', pct: 75 };
  return { label: 'Esperta 🎓', color: 'emerald', pct: 100 };
}

function LevelCard({
  level,
  knowledge,
  templates,
  flagged,
  loading,
}: {
  level: { label: string; color: string; pct: number };
  knowledge: number;
  templates: number;
  flagged: number;
  loading: boolean;
}) {
  const barColor: Record<string, string> = {
    zinc: 'bg-zinc-600',
    amber: 'bg-amber-500',
    sky: 'bg-sky-500',
    violet: 'bg-violet-500',
    emerald: 'bg-emerald-500',
  };
  const textColor: Record<string, string> = {
    zinc: 'text-zinc-300',
    amber: 'text-amber-300',
    sky: 'text-sky-300',
    violet: 'text-violet-300',
    emerald: 'text-emerald-300',
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center gap-3 mb-3">
        <Sparkles size={14} className={textColor[level.color] ?? 'text-zinc-300'} />
        <div className="text-sm font-semibold text-zinc-100">Nível de treino</div>
        <div className={clsx('text-[11px] uppercase tracking-wider font-semibold ml-auto', textColor[level.color])}>
          {loading ? '…' : level.label}
        </div>
      </div>
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden mb-4">
        <div
          className={clsx('h-full transition-all', barColor[level.color] ?? 'bg-zinc-600')}
          style={{ width: `${level.pct}%` }}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          icon={<Book size={14} className="text-emerald-300" />}
          label="Conhecimento"
          value={knowledge}
          hint="perguntas e respostas"
        />
        <StatCard
          icon={<MessageSquare size={14} className="text-sky-300" />}
          label="Respostas prontas"
          value={templates}
          hint="modelos com gatilho"
        />
        <StatCard
          icon={<ThumbsDown size={14} className="text-rose-300" />}
          label="Correções"
          value={flagged}
          hint="exemplos a evitar"
        />
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <div className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold">
          {label}
        </div>
      </div>
      <div className="text-xl font-semibold text-zinc-100 tabular-nums">{value}</div>
      <div className="text-[10.5px] text-zinc-600">{hint}</div>
    </div>
  );
}

// ===========================================================================
// Knowledge section — quick add Q&A
// ===========================================================================

function KnowledgeSection({
  unitId,
  items,
  onChange,
  onSeeAll,
}: {
  unitId: string;
  items: KnowledgeEntry[] | null;
  onChange: () => void | Promise<void>;
  onSeeAll: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const canSubmit = question.trim().length >= 3 && answer.trim().length >= 3 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.createKnowledge(unitId, {
        question: question.trim(),
        answer: answer.trim(),
      });
      setQuestion('');
      setAnswer('');
      toast.success('Conhecimento adicionado!');
      await onChange();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  const recent = useMemo(() => (items ?? []).slice(0, 4), [items]);

  return (
    <SectionCard
      icon={<Book size={16} className="text-emerald-300" />}
      title="📚 Conhecimento da clínica"
      subtitle="Ensina fatos: serviços, preços, horários, perguntas frequentes. A IA puxa o trecho mais relevante na hora de responder."
      open={open}
      onToggle={() => setOpen((v) => !v)}
      onSeeAll={onSeeAll}
      seeAllLabel="Ver biblioteca →"
      counter={items?.length ?? null}
    >
      <div className="space-y-3">
        {/* Quick add */}
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="text-[10.5px] uppercase tracking-wider text-emerald-300 font-semibold mb-2">
            ✨ Adicionar agora
          </div>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder='Pergunta — ex: "Vocês aceitam plano Hapvida?"'
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-emerald-500/40 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition mb-2"
            maxLength={500}
            disabled={submitting}
          />
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder='Resposta — ex: "Sim, atendemos Hapvida com cobertura completa..."'
            rows={3}
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-emerald-500/40 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition resize-none mb-2"
            maxLength={4000}
            disabled={submitting}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] text-zinc-500">
              Vira embedding e fica disponível na próxima conversa.
            </span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
            >
              {submitting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Plus size={12} />
              )}
              Adicionar
            </button>
          </div>
        </div>

        {/* Recent items */}
        {items === null ? (
          <SkeletonRows />
        ) : items.length === 0 ? (
          <div className="text-center py-4 text-[11px] text-zinc-500">
            Nenhum item ainda. Adicione o primeiro acima.
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold px-1">
              Recentes ({Math.min(items.length, 4)} de {items.length})
            </div>
            {recent.map((entry) => (
              <RecentRow
                key={entry.id}
                primary={entry.question}
                secondary={entry.answer}
                accent="emerald"
              />
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ===========================================================================
// Templates section — quick add response template
// ===========================================================================

function TemplatesSection({
  unitId,
  items,
  onChange,
  onSeeAll,
}: {
  unitId: string;
  items: MessageTemplate[] | null;
  onChange: () => void | Promise<void>;
  onSeeAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [response, setResponse] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const parsedKeywords = useMemo(
    () =>
      keywords
        .split(/[,;\n]+/)
        .map((k) => k.trim())
        .filter(Boolean),
    [keywords],
  );

  const canSubmit =
    name.trim().length >= 2 &&
    parsedKeywords.length >= 1 &&
    response.trim().length >= 5 &&
    !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.createTemplate(unitId, {
        name: name.trim(),
        triggerKeywords: parsedKeywords,
        response: response.trim(),
      });
      setName('');
      setKeywords('');
      setResponse('');
      toast.success('Resposta pronta criada!');
      await onChange();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  const recent = useMemo(() => (items ?? []).slice(0, 4), [items]);

  return (
    <SectionCard
      icon={<MessageSquare size={16} className="text-sky-300" />}
      title="💬 Respostas prontas"
      subtitle='Quando o lead disser uma das palavras-chave, a IA usa exatamente o texto que você gravou. Útil pra perguntas repetitivas ("quanto custa", "horário", "endereço").'
      open={open}
      onToggle={() => setOpen((v) => !v)}
      onSeeAll={onSeeAll}
      seeAllLabel="Ver todos →"
      counter={items?.length ?? null}
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
          <div className="text-[10.5px] uppercase tracking-wider text-sky-300 font-semibold mb-2">
            ✨ Adicionar agora
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Nome — ex: "Preço da consulta"'
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-sky-500/40 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition mb-2"
            maxLength={120}
            disabled={submitting}
          />
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="Palavras-chave (separadas por vírgula) — ex: preço, valor, quanto custa, quanto fica"
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-sky-500/40 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition mb-2"
            maxLength={500}
            disabled={submitting}
          />
          <textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder='Resposta exata — ex: "A consulta inicial é R$280..."'
            rows={3}
            className="w-full bg-zinc-950/60 ring-1 ring-zinc-800 focus:ring-sky-500/40 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition resize-none mb-2"
            maxLength={2000}
            disabled={submitting}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] text-zinc-500">
              {parsedKeywords.length > 0
                ? `${parsedKeywords.length} palavra(s)-chave detectada(s)`
                : 'Separe palavras-chave por vírgula.'}
            </span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
            >
              {submitting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Plus size={12} />
              )}
              Adicionar
            </button>
          </div>
        </div>

        {items === null ? (
          <SkeletonRows />
        ) : items.length === 0 ? (
          <div className="text-center py-4 text-[11px] text-zinc-500">
            Nenhuma resposta pronta ainda.
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold px-1">
              Recentes ({Math.min(items.length, 4)} de {items.length})
            </div>
            {recent.map((t) => (
              <RecentRow
                key={t.id}
                primary={t.name}
                secondary={`gatilhos: ${t.triggerKeywords.slice(0, 4).join(', ')}${
                  t.triggerKeywords.length > 4 ? `…` : ''
                }`}
                accent="sky"
              />
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ===========================================================================
// Flagged section — read-only, link pra Conversas
// ===========================================================================

function FlaggedSection({
  items,
  onSeeAll,
}: {
  items: FlaggedMessage[] | null;
  onSeeAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const recent = useMemo(() => (items ?? []).slice(0, 5), [items]);

  return (
    <SectionCard
      icon={<ThumbsDown size={16} className="text-rose-300" />}
      title="⚠️ Correções (exemplos a evitar)"
      subtitle='Quando você flagga uma resposta da IA como ruim (botão ⚑ nas Conversas), ela vira "exemplo a evitar" no prompt — a IA aprende a não repetir o estilo nos próximos turnos.'
      open={open}
      onToggle={() => setOpen((v) => !v)}
      onSeeAll={onSeeAll}
      seeAllLabel="Flaggar em Conversas →"
      counter={items?.length ?? null}
    >
      {items === null ? (
        <SkeletonRows />
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-center">
          <AlertTriangle size={18} className="text-zinc-700 mx-auto mb-2" />
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Nenhuma correção registrada ainda. Vá em <strong>Conversas</strong>, abra um lead,
            clique no ⚑ ao lado de uma resposta ruim da IA.
            <br />A IA passa a evitar esse estilo automaticamente.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold px-1">
            Últimas {Math.min(items.length, 5)} flaggadas
          </div>
          {recent.map((f) => (
            <div
              key={f.id}
              className="rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-2"
            >
              <div className="text-[10.5px] text-rose-300/80 mb-1 flex items-center gap-2">
                <ThumbsDown size={10} />
                <span>
                  Lead{' '}
                  {f.conversation.contactName ?? `#${f.conversation.leadId}`}
                </span>
                <span className="ml-auto text-zinc-600">
                  {new Date(f.createdAt).toLocaleDateString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </span>
              </div>
              <div className="text-[12px] text-zinc-300 italic line-clamp-2 leading-relaxed">
                "{f.content}"
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ===========================================================================
// Persona section — apenas deep link
// ===========================================================================

function PersonaSection({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-fuchsia-500/10 ring-1 ring-fuchsia-500/30 flex items-center justify-center">
          <Sparkles size={14} className="text-fuchsia-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-zinc-100">🎭 Persona & comportamento</div>
          <p className="text-[11.5px] text-zinc-500 mt-0.5">
            Tom, saudação, emojis, horário comercial, follow-up, qualificação automática.
            Configurado no Wizard.
          </p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-fuchsia-200 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 ring-1 ring-fuchsia-500/30 transition-colors"
        >
          Editar persona <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Helpers — SectionCard, RecentRow, SkeletonRows
// ===========================================================================

function SectionCard({
  icon,
  title,
  subtitle,
  open,
  onToggle,
  onSeeAll,
  seeAllLabel,
  counter,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  onSeeAll: () => void;
  seeAllLabel: string;
  counter: number | null;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <header className="flex items-center gap-3 p-4">
        {icon}
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={onToggle}
            className="text-left w-full"
          >
            <div className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              {title}
              {counter !== null && (
                <span className="text-[10px] uppercase tracking-wider bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full">
                  {counter}
                </span>
              )}
              {open ? (
                <ChevronDown size={12} className="text-zinc-500" />
              ) : (
                <ChevronRight size={12} className="text-zinc-500" />
              )}
            </div>
            <p className="text-[11.5px] text-zinc-500 mt-0.5 leading-relaxed">{subtitle}</p>
          </button>
        </div>
        <button
          type="button"
          onClick={onSeeAll}
          className="text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 px-2.5 py-1 rounded transition-colors whitespace-nowrap"
        >
          {seeAllLabel}
        </button>
      </header>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-zinc-800/40">
          {children}
        </div>
      )}
    </section>
  );
}

function RecentRow({
  primary,
  secondary,
  accent,
}: {
  primary: string;
  secondary: string;
  accent: 'emerald' | 'sky';
}) {
  const dotColor = accent === 'emerald' ? 'bg-emerald-400' : 'bg-sky-400';
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 flex items-start gap-2.5">
      <span className={clsx('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', dotColor)} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-zinc-200 truncate font-medium">{primary}</div>
        <div className="text-[10.5px] text-zinc-500 truncate mt-0.5">{secondary}</div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-1.5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-12 rounded-md border border-zinc-800/60 bg-zinc-950/40 animate-pulse"
        />
      ))}
    </div>
  );
}
