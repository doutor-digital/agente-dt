// ============================================================================
// TrainingPanel — hub de treino da IA por unidade.
//
// PAPEL DESTE ARQUIVO
// -------------------
// Consolida, não reimplementa. As telas de Fontes (Conhecimento/Templates),
// Conversas (flag) e Wizard (persona) continuam donas do CRUD completo.
// Aqui: leitura agregada, entrada rápida dos dois itens mais frequentes,
// diagnóstico de cobertura e atalhos para as telas completas.
//
// DECISÕES QUE VALEM COMENTÁRIO
// -----------------------------
// 1. Não existe "nível de treino" por volume. Contar itens premia quem
//    despeja lixo e pune quem escreveu 6 respostas certas. O card de topo
//    mede COBERTURA de tópicos essenciais — verificável e acionável.
// 2. Correção (flag) não é sinal positivo. Nunca soma em progresso.
//    Ela abre um caminho: "ensinar a resposta certa" pré-preenche o
//    formulário de conhecimento. Flag sozinha é sinal fraco; flag + resposta
//    correta é sinal forte.
// 3. Carga tem guarda de corrida (sequência de request) e estado de erro
//    explícito. Falha silenciosa aqui exibiria "0 itens", que a usuária lê
//    como "meu treino sumiu".
// 4. Falha parcial é parcial: se só o endpoint de flags cair, o resto
//    renderiza e a seção quebrada avisa. Não engolimos o erro com catch(()=>[]).
// ============================================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Book,
  Check,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  Info,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  Wand2,
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

// ===========================================================================
// Texto — centralizado para revisão de copy sem caçar string no meio do JSX
// ===========================================================================

const COPY = {
  knowledge: {
    title: 'Conhecimento da clínica',
    subtitle:
      'Fatos que a IA consulta antes de responder: serviços, preços, convênios, regras. Ela busca o trecho mais parecido com a pergunta do lead.',
  },
  templates: {
    title: 'Respostas prontas',
    subtitle:
      'Texto fixo disparado por palavra-chave. Use quando a resposta não pode variar — valor de tabela, endereço, política de cancelamento.',
  },
  flagged: {
    title: 'Correções',
    subtitle:
      'Respostas que você marcou como ruins nas Conversas. A IA passa a evitar esse padrão — e você pode ensinar a resposta certa em um clique.',
  },
  persona: {
    title: 'Persona e comportamento',
    subtitle:
      'Tom de voz, saudação, uso de emoji, horário comercial, follow-up e qualificação. Vale para toda mensagem que a IA envia.',
  },
} as const;

// ===========================================================================
// Utilitários de texto — normalização, similaridade, ordenação
// ===========================================================================

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): Set<string> {
  return new Set(normalize(value).split(' ').filter((word) => word.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  a.forEach((token) => {
    if (b.has(token)) intersection += 1;
  });
  return intersection / (a.size + b.size - intersection);
}

/**
 * Lê createdAt/updatedAt de forma defensiva: nem toda entidade expõe o campo.
 * Sem timestamp, retorna 0 e o sort estável preserva a ordem da API.
 */
function timestampOf(item: unknown): number {
  if (!item || typeof item !== 'object') return 0;
  const record = item as { createdAt?: unknown; updatedAt?: unknown };
  const raw = record.createdAt ?? record.updatedAt;
  if (typeof raw !== 'string' && typeof raw !== 'number') return 0;
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortRecent<T>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => timestampOf(b) - timestampOf(a));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ===========================================================================
// Cobertura — o que uma clínica precisa ter respondido antes de soltar a IA
// ===========================================================================

interface CoverageTopic {
  id: string;
  label: string;
  /** Pergunta sugerida ao clicar num tópico descoberto. */
  suggestedQuestion: string;
  keywords: readonly string[];
}

const COVERAGE_TOPICS: readonly CoverageTopic[] = [
  {
    id: 'precos',
    label: 'Preços e pagamento',
    suggestedQuestion: 'Quanto custa a consulta e quais formas de pagamento vocês aceitam?',
    keywords: ['preco', 'valor', 'custa', 'custo', 'pagamento', 'parcela', 'cartao', 'pix', 'tabela'],
  },
  {
    id: 'horarios',
    label: 'Horário de atendimento',
    suggestedQuestion: 'Qual o horário de atendimento da clínica?',
    keywords: ['horario', 'funciona', 'abre', 'fecha', 'atendimento', 'sabado', 'domingo', 'feriado'],
  },
  {
    id: 'local',
    label: 'Endereço e acesso',
    suggestedQuestion: 'Onde fica a clínica e tem estacionamento?',
    keywords: ['endereco', 'local', 'onde', 'chegar', 'estacionamento', 'bairro', 'rua', 'referencia'],
  },
  {
    id: 'convenios',
    label: 'Convênios',
    suggestedQuestion: 'Vocês atendem por convênio? Quais planos são aceitos?',
    keywords: ['convenio', 'plano', 'unimed', 'hapvida', 'amil', 'bradesco', 'reembolso', 'particular'],
  },
  {
    id: 'agendamento',
    label: 'Como agendar',
    suggestedQuestion: 'Como faço para agendar, remarcar ou cancelar uma consulta?',
    keywords: ['agendar', 'agenda', 'marcar', 'remarcar', 'cancelar', 'disponibilidade', 'vaga'],
  },
  {
    id: 'servicos',
    label: 'Serviços e especialidades',
    suggestedQuestion: 'Quais serviços e especialidades a clínica oferece?',
    keywords: ['servico', 'procedimento', 'tratamento', 'especialidade', 'exame', 'atende'],
  },
];

interface CoverageResult {
  covered: Set<string>;
  missing: CoverageTopic[];
}

function computeCoverage(
  knowledge: readonly KnowledgeEntry[],
  templates: readonly MessageTemplate[],
): CoverageResult {
  const haystack = normalize(
    [
      ...knowledge.map((entry) => `${entry.question} ${entry.answer}`),
      ...templates.map((template) => `${template.name} ${template.triggerKeywords.join(' ')}`),
    ].join(' '),
  );

  const covered = new Set<string>();
  const missing: CoverageTopic[] = [];

  for (const topic of COVERAGE_TOPICS) {
    const hit = topic.keywords.some((keyword) => haystack.includes(keyword));
    if (hit) covered.add(topic.id);
    else missing.push(topic);
  }

  return { covered, missing };
}

// ===========================================================================
// Estado de carga — guarda de corrida + falha parcial por seção
// ===========================================================================

type SectionKey = 'knowledge' | 'templates' | 'flagged';

interface TrainingData {
  knowledge: KnowledgeEntry[];
  templates: MessageTemplate[];
  flagged: FlaggedMessage[];
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: TrainingData; failed: SectionKey[] }
  | { status: 'error'; message: string };

const EMPTY_DATA: TrainingData = { knowledge: [], templates: [], flagged: [] };

function useTrainingData(unitId: string | null) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  // Cada carga incrementa o contador. Respostas de unidades antigas são
  // descartadas — trocar de unidade rápido não pinta dado errado na tela.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!unitId) {
      setState({ status: 'idle' });
      return;
    }
    const seq = ++requestSeq.current;
    setState({ status: 'loading' });

    const [knowledgeResult, templatesResult, flaggedResult] = await Promise.allSettled([
      api.listKnowledge(unitId),
      api.listTemplates(unitId),
      api.listFlaggedMessages(unitId),
    ]);

    if (seq !== requestSeq.current) return;

    // Conhecimento e templates são o núcleo. Se os dois caírem, é erro geral.
    if (knowledgeResult.status === 'rejected' && templatesResult.status === 'rejected') {
      setState({ status: 'error', message: errorMessage(knowledgeResult.reason) });
      return;
    }

    const failed: SectionKey[] = [];
    if (knowledgeResult.status === 'rejected') failed.push('knowledge');
    if (templatesResult.status === 'rejected') failed.push('templates');
    if (flaggedResult.status === 'rejected') failed.push('flagged');

    setState({
      status: 'ready',
      failed,
      data: {
        knowledge: knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : [],
        templates: templatesResult.status === 'fulfilled' ? templatesResult.value : [],
        flagged: flaggedResult.status === 'fulfilled' ? flaggedResult.value : [],
      },
    });
  }, [unitId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Insere localmente após criar, evitando 3 refetches por item adicionado. */
  const prepend = useCallback(
    <K extends 'knowledge' | 'templates'>(key: K, item: TrainingData[K][number]) => {
      setState((prev) => {
        if (prev.status !== 'ready') return prev;
        return {
          ...prev,
          data: { ...prev.data, [key]: [item, ...prev.data[key]] } as TrainingData,
        };
      });
    },
    [],
  );

  return { state, reload: load, prepend };
}

// ===========================================================================
// Pré-preenchimento do formulário de conhecimento
// ===========================================================================

interface KnowledgePrefill {
  /** Muda a cada solicitação — é o gatilho do efeito no filho. */
  token: number;
  question?: string;
  /** Contexto exibido acima do formulário (ex.: resposta ruim sendo corrigida). */
  context?: string;
}

// ===========================================================================
// Componente principal
// ===========================================================================

interface TrainingPanelProps {
  onNavigate: (tab: AppTab) => void;
}

export function TrainingPanel({ onNavigate }: TrainingPanelProps) {
  const { selectedUnitId, selectedUnit } = useUnit();
  const { state, reload, prepend } = useTrainingData(selectedUnitId ?? null);
  const [prefill, setPrefill] = useState<KnowledgePrefill | null>(null);
  const prefillSeq = useRef(0);

  const requestPrefill = useCallback((payload: Omit<KnowledgePrefill, 'token'>) => {
    setPrefill({ token: ++prefillSeq.current, ...payload });
  }, []);

  const data = state.status === 'ready' ? state.data : EMPTY_DATA;
  const failed = state.status === 'ready' ? state.failed : [];
  const isLoading = state.status === 'loading' || state.status === 'idle';

  const coverage = useMemo(
    () => computeCoverage(data.knowledge, data.templates),
    [data.knowledge, data.templates],
  );

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-zinc-500">Selecione uma unidade para treinar a IA.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-5">
        <header className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-xl bg-violet-500/10 ring-1 ring-violet-500/25 flex items-center justify-center shrink-0">
            <GraduationCap size={20} className="text-violet-300" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-zinc-100 tracking-tight">
              Treinar IA
              {selectedUnit && (
                <span className="ml-2 text-xs font-normal text-zinc-500">
                  {selectedUnit.personaCompanyName ?? selectedUnit.name}
                </span>
              )}
            </h1>
            <p className="text-sm text-zinc-400 mt-1 leading-relaxed max-w-2xl">
              Tudo que ensina a IA a atender como a sua clínica atende, reunido em um lugar.
              Comece pelos tópicos que os leads mais perguntam.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 disabled:opacity-40 transition-colors shrink-0"
          >
            <RefreshCw size={13} className={clsx(isLoading && 'animate-spin')} />
            Atualizar
          </button>
        </header>

        {state.status === 'error' ? (
          <ErrorPanel message={state.message} onRetry={() => void reload()} />
        ) : (
          <>
            <CoverageCard
              coverage={coverage}
              knowledgeCount={data.knowledge.length}
              templateCount={data.templates.length}
              flaggedCount={data.flagged.length}
              loading={isLoading}
              onFillTopic={(topic) =>
                requestPrefill({ question: topic.suggestedQuestion })
              }
            />

            <PrecedenceCard />

            <PersonaSection unit={selectedUnit} onEdit={() => onNavigate('wizard')} />

            <KnowledgeSection
              unitId={selectedUnitId}
              items={data.knowledge}
              loading={isLoading}
              failed={failed.includes('knowledge')}
              prefill={prefill}
              onCreated={(entry) => prepend('knowledge', entry)}
              onReload={() => void reload()}
              onSeeAll={() => onNavigate('sources')}
            />

            <TemplatesSection
              unitId={selectedUnitId}
              items={data.templates}
              loading={isLoading}
              failed={failed.includes('templates')}
              onCreated={(template) => prepend('templates', template)}
              onReload={() => void reload()}
              onSeeAll={() => onNavigate('sources')}
            />

            <FlaggedSection
              items={data.flagged}
              loading={isLoading}
              failed={failed.includes('flagged')}
              onTeach={(message) =>
                requestPrefill({
                  context: message.content,
                })
              }
              onSeeAll={() => onNavigate('conversations')}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Cobertura
// ===========================================================================

function CoverageCard({
  coverage,
  knowledgeCount,
  templateCount,
  flaggedCount,
  loading,
  onFillTopic,
}: {
  coverage: CoverageResult;
  knowledgeCount: number;
  templateCount: number;
  flaggedCount: number;
  loading: boolean;
  onFillTopic: (topic: CoverageTopic) => void;
}) {
  const total = COVERAGE_TOPICS.length;
  const done = coverage.covered.size;
  const pct = Math.round((done / total) * 100);

  const tone =
    done === total ? 'emerald' : done >= total / 2 ? 'sky' : done > 0 ? 'amber' : 'zinc';

  const bar: Record<string, string> = {
    zinc: 'bg-zinc-700',
    amber: 'bg-amber-500',
    sky: 'bg-sky-500',
    emerald: 'bg-emerald-500',
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-baseline gap-3 mb-3">
        <h2 className="text-sm font-semibold text-zinc-100">Cobertura dos tópicos essenciais</h2>
        <span className="ml-auto text-sm font-semibold text-zinc-100 tabular-nums">
          {loading ? '—' : `${done} de ${total}`}
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-4">
        <div
          className={clsx('h-full transition-all duration-500', bar[tone])}
          style={{ width: loading ? '0%' : `${pct}%` }}
        />
      </div>

      <ul className="flex flex-wrap gap-1.5 mb-4">
        {COVERAGE_TOPICS.map((topic) => {
          const isCovered = coverage.covered.has(topic.id);
          return (
            <li key={topic.id}>
              {isCovered ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20">
                  <Check size={11} />
                  {topic.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onFillTopic(topic)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-zinc-400 ring-1 ring-zinc-700 ring-dashed hover:text-zinc-100 hover:ring-zinc-500 hover:bg-zinc-800/60 transition-colors"
                >
                  <Plus size={11} />
                  {topic.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-zinc-500 leading-relaxed mb-4">
        {done === total
          ? 'Os tópicos básicos estão cobertos. A partir daqui, o ganho vem de corrigir respostas ruins nas Conversas.'
          : 'Clique num tópico em aberto para começar a resposta. A verificação é por palavra-chave — ela indica que existe conteúdo sobre o tema, não que a resposta esteja completa.'}
      </p>

      <dl className="grid grid-cols-3 gap-3 pt-4 border-t border-zinc-800/60">
        <Stat
          icon={<Book size={13} className="text-emerald-300" />}
          label="Conhecimento"
          value={knowledgeCount}
          loading={loading}
        />
        <Stat
          icon={<MessageSquare size={13} className="text-sky-300" />}
          label="Respostas prontas"
          value={templateCount}
          loading={loading}
        />
        <Stat
          icon={<ThumbsDown size={13} className="text-rose-300" />}
          label="Correções abertas"
          value={flaggedCount}
          loading={loading}
        />
      </dl>
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  loading,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  loading: boolean;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
        {icon}
        {label}
      </dt>
      <dd className="text-lg font-semibold text-zinc-100 tabular-nums">
        {loading ? <span className="text-zinc-700">—</span> : value}
      </dd>
    </div>
  );
}

// ===========================================================================
// Ordem de precedência — explica por que duas fontes podem "brigar"
// ===========================================================================

function PrecedenceCard() {
  const [open, setOpen] = useState(false);
  const contentId = 'training-precedence';

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={contentId}
        className="w-full flex items-center gap-2.5 px-5 py-3.5 text-left hover:bg-zinc-800/30 rounded-xl transition-colors"
      >
        <Info size={14} className="text-zinc-500 shrink-0" />
        <span className="text-sm text-zinc-300">Como a IA decide o que responder</span>
        {open ? (
          <ChevronDown size={14} className="text-zinc-500 ml-auto" />
        ) : (
          <ChevronRight size={14} className="text-zinc-500 ml-auto" />
        )}
      </button>
      {open && (
        <ol id={contentId} className="px-5 pb-4 pt-1 space-y-2 border-t border-zinc-800/60">
          {[
            ['Resposta pronta', 'Se a mensagem contém uma palavra-chave cadastrada, esse texto é usado como está.'],
            ['Conhecimento', 'Sem palavra-chave, a IA busca os trechos mais parecidos com a pergunta e responde com base neles.'],
            ['Persona', 'Define o tom, a saudação e as regras de horário de qualquer resposta gerada.'],
            ['Correções', 'Entram no prompt como exemplos do que não repetir.'],
          ].map(([title, description], index) => (
            <li key={title} className="flex gap-3 pt-2">
              <span className="text-xs font-semibold text-zinc-600 tabular-nums pt-0.5">
                {index + 1}
              </span>
              <div>
                <div className="text-xs font-semibold text-zinc-200">{title}</div>
                <p className="text-xs text-zinc-500 leading-relaxed mt-0.5">{description}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ===========================================================================
// Persona
// ===========================================================================

function PersonaSection({
  unit,
  onEdit,
}: {
  unit: { name: string; personaCompanyName?: string | null } | null | undefined;
  onEdit: () => void;
}) {
  // TODO(backend): expor no /units os campos de persona (tom, saudação,
  // horário) para trocar este sinal binário por um checklist real.
  const configured = Boolean(unit?.personaCompanyName);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-fuchsia-500/10 ring-1 ring-fuchsia-500/25 flex items-center justify-center shrink-0">
          <Sparkles size={14} className="text-fuchsia-300" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            {COPY.persona.title}
            <span
              className={clsx(
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ring-1',
                configured
                  ? 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/20'
                  : 'text-amber-300 bg-amber-500/10 ring-amber-500/20',
              )}
            >
              {configured ? 'Configurada' : 'Pendente'}
            </span>
          </h2>
          <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{COPY.persona.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-fuchsia-200 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 ring-1 ring-fuchsia-500/25 transition-colors shrink-0"
        >
          {configured ? 'Editar persona' : 'Configurar persona'}
          <ArrowRight size={12} />
        </button>
      </div>
    </section>
  );
}

// ===========================================================================
// Conhecimento
// ===========================================================================

function KnowledgeSection({
  unitId,
  items,
  loading,
  failed,
  prefill,
  onCreated,
  onReload,
  onSeeAll,
}: {
  unitId: string;
  items: KnowledgeEntry[];
  loading: boolean;
  failed: boolean;
  prefill: KnowledgePrefill | null;
  onCreated: (entry: KnowledgeEntry) => void;
  onReload: () => void;
  onSeeAll: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [context, setContext] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const questionRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const token = prefill?.token ?? 0;
  useEffect(() => {
    if (!prefill || token === 0) return;
    setOpen(true);
    if (prefill.question) setQuestion(prefill.question);
    setContext(prefill.context ?? null);
    // rAF: o painel só recebe foco depois que a seção termina de expandir.
    const frame = requestAnimationFrame(() => {
      questionRef.current?.focus();
      questionRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const duplicate = useMemo(() => {
    if (question.trim().length < 6) return null;
    const asked = tokenize(question);
    let best: { entry: KnowledgeEntry; score: number } | null = null;
    for (const entry of items) {
      const score = jaccard(asked, tokenize(entry.question));
      if (score >= 0.6 && (!best || score > best.score)) best = { entry, score };
    }
    return best?.entry ?? null;
  }, [question, items]);

  const canSubmit =
    question.trim().length >= 3 && answer.trim().length >= 3 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const created = await api.createKnowledge(unitId, {
        question: question.trim(),
        answer: answer.trim(),
      });
      setQuestion('');
      setAnswer('');
      setContext(null);
      toast.success('Conhecimento salvo. Já vale na próxima conversa.');
      if (created && typeof created === 'object' && 'id' in created) {
        onCreated(created as KnowledgeEntry);
      } else {
        onReload();
      }
    } catch (error) {
      toast.error(`Não foi possível salvar: ${errorMessage(error)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const recent = useMemo(() => sortRecent(items).slice(0, 4), [items]);

  return (
    <SectionCard
      icon={<Book size={15} className="text-emerald-300" />}
      title={COPY.knowledge.title}
      subtitle={COPY.knowledge.subtitle}
      counter={loading ? null : items.length}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onSeeAll={onSeeAll}
      seeAllLabel="Ver biblioteca"
    >
      <div className="space-y-3">
        {context && (
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wider text-rose-300 font-semibold mb-1">
              Corrigindo esta resposta
            </div>
            <p className="text-xs text-zinc-400 italic leading-relaxed line-clamp-3">
              {context}
            </p>
            <p className="text-xs text-zinc-500 mt-2">
              Escreva a pergunta do lead e a resposta que a IA deveria ter dado.
            </p>
          </div>
        )}

        <QuickAdd
          accent="emerald"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <Field label="Pergunta do lead">
            <input
              ref={questionRef}
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Vocês atendem Hapvida?"
              maxLength={500}
              disabled={submitting}
              className={inputClass('emerald')}
            />
          </Field>

          {duplicate && (
            <p className="text-xs text-amber-300/90 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Já existe algo parecido: “{duplicate.question}”. Duas respostas para a mesma
                pergunta deixam a IA inconsistente — prefira editar a existente.
              </span>
            </p>
          )}

          <Field label="Resposta" hint={`${answer.length}/4000`}>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Sim, atendemos Hapvida para consultas e exames. Traga carteirinha e documento com foto."
              rows={3}
              maxLength={4000}
              disabled={submitting}
              className={clsx(inputClass('emerald'), 'resize-none')}
            />
          </Field>

          <QuickAddFooter
            hint="Ctrl+Enter para salvar"
            accent="emerald"
            submitting={submitting}
            disabled={!canSubmit}
            onSubmit={() => void submit()}
            label="Salvar conhecimento"
          />
        </QuickAdd>

        <RecentList
          loading={loading}
          failed={failed}
          onRetry={onReload}
          total={items.length}
          emptyMessage="Nenhum conhecimento cadastrado. Comece pelas perguntas que mais chegam no WhatsApp."
        >
          {recent.map((entry) => (
            <RecentRow
              key={entry.id}
              accent="emerald"
              primary={entry.question}
              secondary={entry.answer}
            />
          ))}
        </RecentList>
      </div>
    </SectionCard>
  );
}

// ===========================================================================
// Respostas prontas
// ===========================================================================

function TemplatesSection({
  unitId,
  items,
  loading,
  failed,
  onCreated,
  onReload,
  onSeeAll,
}: {
  unitId: string;
  items: MessageTemplate[];
  loading: boolean;
  failed: boolean;
  onCreated: (template: MessageTemplate) => void;
  onReload: () => void;
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
      Array.from(
        new Set(
          keywords
            .split(/[,;\n]+/)
            .map((keyword) => keyword.trim())
            .filter(Boolean),
        ),
      ),
    [keywords],
  );

  /**
   * Colisão de gatilho é o bug mais caro desta tela: dois templates com a
   * mesma palavra tornam a resposta imprevisível. Avisamos antes de salvar.
   */
  const conflicts = useMemo(() => {
    const normalizedNew = parsedKeywords.map(normalize);
    const found: { keyword: string; template: string }[] = [];
    for (const template of items) {
      for (const existing of template.triggerKeywords) {
        const normalizedExisting = normalize(existing);
        if (normalizedNew.includes(normalizedExisting)) {
          found.push({ keyword: existing, template: template.name });
        }
      }
    }
    return found.slice(0, 3);
  }, [parsedKeywords, items]);

  const canSubmit =
    name.trim().length >= 2 &&
    parsedKeywords.length >= 1 &&
    response.trim().length >= 5 &&
    !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const created = await api.createTemplate(unitId, {
        name: name.trim(),
        triggerKeywords: parsedKeywords,
        response: response.trim(),
      });
      setName('');
      setKeywords('');
      setResponse('');
      toast.success('Resposta pronta salva.');
      if (created && typeof created === 'object' && 'id' in created) {
        onCreated(created as MessageTemplate);
      } else {
        onReload();
      }
    } catch (error) {
      toast.error(`Não foi possível salvar: ${errorMessage(error)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const recent = useMemo(() => sortRecent(items).slice(0, 4), [items]);

  return (
    <SectionCard
      icon={<MessageSquare size={15} className="text-sky-300" />}
      title={COPY.templates.title}
      subtitle={COPY.templates.subtitle}
      counter={loading ? null : items.length}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onSeeAll={onSeeAll}
      seeAllLabel="Ver todas"
    >
      <div className="space-y-3">
        <QuickAdd
          accent="sky"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <Field label="Nome interno">
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Valor da consulta"
              maxLength={120}
              disabled={submitting}
              className={inputClass('sky')}
            />
          </Field>

          <Field label="Palavras-chave que disparam" hint="separe por vírgula">
            <input
              type="text"
              value={keywords}
              onChange={(event) => setKeywords(event.target.value)}
              placeholder="preço, valor, quanto custa, quanto fica"
              maxLength={500}
              disabled={submitting}
              className={inputClass('sky')}
            />
          </Field>

          {conflicts.length > 0 && (
            <p className="text-xs text-amber-300/90 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                {conflicts.map((conflict) => `“${conflict.keyword}” (${conflict.template})`).join(', ')}
                {conflicts.length > 1 ? ' já disparam outras respostas.' : ' já dispara outra resposta.'}{' '}
                Com gatilho repetido, não dá para prever qual das duas a IA usa.
              </span>
            </p>
          )}

          <Field label="Texto enviado" hint={`${response.length}/2000`}>
            <textarea
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              placeholder="A consulta inicial é R$ 280, com retorno em até 30 dias incluso."
              rows={3}
              maxLength={2000}
              disabled={submitting}
              className={clsx(inputClass('sky'), 'resize-none')}
            />
          </Field>

          <QuickAddFooter
            hint={
              parsedKeywords.length > 0
                ? `${parsedKeywords.length} gatilho${parsedKeywords.length > 1 ? 's' : ''} · Ctrl+Enter para salvar`
                : 'Ctrl+Enter para salvar'
            }
            accent="sky"
            submitting={submitting}
            disabled={!canSubmit}
            onSubmit={() => void submit()}
            label="Salvar resposta"
          />
        </QuickAdd>

        <RecentList
          loading={loading}
          failed={failed}
          onRetry={onReload}
          total={items.length}
          emptyMessage="Nenhuma resposta pronta. Use para o que não pode sair errado: valores de tabela, endereço, política de cancelamento."
        >
          {recent.map((template) => (
            <RecentRow
              key={template.id}
              accent="sky"
              primary={template.name}
              secondary={`Dispara com: ${template.triggerKeywords.slice(0, 4).join(', ')}${
                template.triggerKeywords.length > 4 ? '…' : ''
              }`}
            />
          ))}
        </RecentList>
      </div>
    </SectionCard>
  );
}

// ===========================================================================
// Correções
// ===========================================================================

function FlaggedSection({
  items,
  loading,
  failed,
  onTeach,
  onSeeAll,
}: {
  items: FlaggedMessage[];
  loading: boolean;
  failed: boolean;
  onTeach: (message: FlaggedMessage) => void;
  onSeeAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const recent = useMemo(() => sortRecent(items).slice(0, 5), [items]);

  return (
    <SectionCard
      icon={<ThumbsDown size={15} className="text-rose-300" />}
      title={COPY.flagged.title}
      subtitle={COPY.flagged.subtitle}
      counter={loading ? null : items.length}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onSeeAll={onSeeAll}
      seeAllLabel="Abrir Conversas"
    >
      <RecentList
        loading={loading}
        failed={failed}
        onRetry={onSeeAll}
        total={items.length}
        emptyMessage="Nenhuma correção registrada. Nas Conversas, use o ⚑ ao lado de uma resposta ruim da IA."
        label="Marcadas recentemente"
      >
        {recent.map((message) => (
          <div
            key={message.id}
            className="rounded-md border border-rose-500/15 bg-rose-500/5 px-3 py-2.5"
          >
            <div className="flex items-center gap-2 text-[11px] text-rose-300/80 mb-1.5">
              <ThumbsDown size={10} />
              <span className="truncate">
                {message.conversation.contactName ?? `Lead #${message.conversation.leadId}`}
              </span>
              <span className="ml-auto text-zinc-600 shrink-0">
                {new Date(message.createdAt).toLocaleDateString('pt-BR', {
                  day: '2-digit',
                  month: '2-digit',
                })}
              </span>
            </div>
            <p className="text-xs text-zinc-400 italic line-clamp-2 leading-relaxed">
              {message.content}
            </p>
            <button
              type="button"
              onClick={() => onTeach(message)}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300 hover:text-emerald-200 transition-colors"
            >
              <Wand2 size={12} />
              Ensinar a resposta certa
            </button>
          </div>
        ))}
      </RecentList>
    </SectionCard>
  );
}

// ===========================================================================
// Primitivos de UI
// ===========================================================================

type Accent = 'emerald' | 'sky';

function inputClass(accent: Accent): string {
  return clsx(
    'w-full bg-zinc-950/60 ring-1 ring-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-100',
    'placeholder:text-zinc-600 outline-none transition',
    'focus:ring-2 disabled:opacity-50',
    accent === 'emerald' ? 'focus:ring-emerald-500/50' : 'focus:ring-sky-500/50',
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline gap-2 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">
          {label}
        </span>
        {hint && <span className="text-[11px] text-zinc-600 ml-auto tabular-nums">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function QuickAdd({
  accent,
  onKeyDown,
  children,
}: {
  accent: Accent;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      onKeyDown={onKeyDown}
      className={clsx(
        'rounded-lg border p-3.5 space-y-3',
        accent === 'emerald'
          ? 'border-emerald-500/15 bg-emerald-500/[0.04]'
          : 'border-sky-500/15 bg-sky-500/[0.04]',
      )}
    >
      {children}
    </div>
  );
}

function QuickAddFooter({
  hint,
  accent,
  submitting,
  disabled,
  onSubmit,
  label,
}: {
  hint: string;
  accent: Accent;
  submitting: boolean;
  disabled: boolean;
  onSubmit: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-0.5">
      <span className="text-[11px] text-zinc-500">{hint}</span>
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled}
        className={clsx(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors shrink-0',
          'disabled:bg-zinc-800 disabled:text-zinc-600',
          accent === 'emerald'
            ? 'bg-emerald-600 hover:bg-emerald-500'
            : 'bg-sky-600 hover:bg-sky-500',
        )}
      >
        {submitting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        {label}
      </button>
    </div>
  );
}

function SectionCard({
  icon,
  title,
  subtitle,
  counter,
  open,
  onToggle,
  onSeeAll,
  seeAllLabel,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  counter: number | null;
  open: boolean;
  onToggle: () => void;
  onSeeAll: () => void;
  seeAllLabel: string;
  children: ReactNode;
}) {
  const contentId = `training-section-${normalize(title).replace(/\s/g, '-')}`;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-start gap-3 p-4">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={contentId}
          className="flex-1 min-w-0 text-left group"
        >
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100 group-hover:text-white transition-colors">
              {title}
            </span>
            {counter !== null && (
              <span className="text-[10px] font-semibold tabular-nums bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full">
                {counter}
              </span>
            )}
            {open ? (
              <ChevronDown size={12} className="text-zinc-500" />
            ) : (
              <ChevronRight size={12} className="text-zinc-500" />
            )}
          </span>
          <span className="block text-xs text-zinc-500 mt-1 leading-relaxed max-w-2xl">
            {subtitle}
          </span>
        </button>
        <button
          type="button"
          onClick={onSeeAll}
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 px-2.5 py-1 rounded transition-colors whitespace-nowrap shrink-0"
        >
          {seeAllLabel}
          <ArrowRight size={11} />
        </button>
      </div>
      {open && (
        <div id={contentId} className="px-4 pb-4 pt-3 border-t border-zinc-800/60">
          {children}
        </div>
      )}
    </section>
  );
}

function RecentList({
  loading,
  failed,
  onRetry,
  total,
  emptyMessage,
  label = 'Adicionados recentemente',
  children,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  total: number;
  emptyMessage: string;
  label?: string;
  children: ReactNode;
}) {
  if (failed) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-3 flex items-center gap-2.5">
        <AlertTriangle size={14} className="text-amber-300 shrink-0" />
        <p className="text-xs text-amber-200/90 flex-1">
          Esta lista não carregou. Os números acima podem estar desatualizados.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-medium text-amber-200 hover:text-amber-100 underline underline-offset-2 shrink-0"
        >
          Tentar de novo
        </button>
      </div>
    );
  }

  if (loading) return <SkeletonRows />;

  if (total === 0) {
    return (
      <p className="text-xs text-zinc-500 text-center leading-relaxed py-4 px-6">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold px-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function RecentRow({
  primary,
  secondary,
  accent,
}: {
  primary: string;
  secondary: string;
  accent: Accent;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 flex items-start gap-2.5">
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full mt-1.5 shrink-0',
          accent === 'emerald' ? 'bg-emerald-400' : 'bg-sky-400',
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-zinc-200 truncate">{primary}</div>
        <div className="text-[11px] text-zinc-500 truncate mt-0.5">{secondary}</div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-12 rounded-md border border-zinc-800/60 bg-zinc-950/40 animate-pulse"
        />
      ))}
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-6 text-center">
      <AlertTriangle size={20} className="text-rose-300 mx-auto mb-3" />
      <h2 className="text-sm font-semibold text-zinc-100 mb-1">O treino desta unidade não carregou</h2>
      <p className="text-xs text-zinc-400 mb-4 max-w-md mx-auto leading-relaxed">
        Nada foi perdido — é a leitura que falhou. Detalhe técnico: {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 transition-colors"
      >
        <RefreshCw size={12} />
        Tentar de novo
      </button>
    </div>
  );
}