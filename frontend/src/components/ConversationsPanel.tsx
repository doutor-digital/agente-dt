// ============================================================================
// ConversationsPanel — visão "WhatsApp" agrupada por lead.
//
// Lista à esquerda (conversas ordenadas por última mensagem), histórico
// completo no centro. Cada mensagem da IA mostra link pro feed do trace.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Bot, Brain, Loader2, MessageCircle, Phone, ThumbsDown, User2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { LeadMemory } from '../types/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { usePolling } from '../hooks/usePolling';
import type { ConversationDetail, ConversationMessage } from '../types/api';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function ConversationsPanel() {
  const { selectedUnitId } = useUnit();
  const fetcher = useMemo(() => () => api.listConversations(selectedUnitId), [selectedUnitId]);
  const { data: conversations, loading } = usePolling(fetcher, 4000, [selectedUnitId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);

  useEffect(() => {
    if (!selectedId && conversations && conversations.length > 0) {
      setSelectedId(conversations[0].id);
    }
  }, [conversations, selectedId]);

  // Reset quando trocar de unidade.
  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
  }, [selectedUnitId]);

  // Quando o usuário clica num lead pelo Dashboard (modal LeadsBucketModal),
  // ele dispara `app:openConversation` — selecionamos a conversa correspondente
  // ao ser montados.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ conversationId?: string }>;
      if (ev.detail?.conversationId) {
        setSelectedId(ev.detail.conversationId);
      }
    };
    window.addEventListener('app:openConversation', handler);
    return () => window.removeEventListener('app:openConversation', handler);
  }, []);

  const detailFetcher = useMemo(
    () => async () => (selectedId ? api.getConversation(selectedId) : null),
    [selectedId],
  );
  const { data: fetchedDetail } = usePolling(detailFetcher, 3000, [selectedId]);

  useEffect(() => {
    if (fetchedDetail) setDetail(fetchedDetail);
    if (!selectedId) setDetail(null);
  }, [fetchedDetail, selectedId]);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Lista de conversas */}
      <aside className="w-72 shrink-0 border-r border-zinc-800/80 bg-ink-900 flex flex-col">
        <div className="p-3 border-b border-zinc-800/80 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Conversas</span>
          {loading && <Loader2 className="animate-spin text-zinc-500" size={12} />}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {(conversations ?? []).length === 0 && !loading && (
            <div className="text-[11px] text-zinc-600 text-center mt-6 px-2">
              Nenhuma conversa{selectedUnitId ? ' nesta unidade' : ''} ainda.
            </div>
          )}
          <ul className="space-y-0.5">
            {(conversations ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-md transition border-l-2',
                    selectedId === c.id
                      ? 'bg-zinc-800/70 border-brand-500'
                      : 'border-transparent hover:bg-zinc-800/30',
                  )}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <User2 size={12} className="text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-200 truncate flex-1">
                      {c.contactName || `Lead #${c.leadId}`}
                    </span>
                    <span className="text-[10px] text-zinc-500">{timeAgo(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span className="px-1 py-0.5 rounded bg-zinc-800/60 text-zinc-400">
                      {c.channel}
                    </span>
                    <span>{c._count.messages} msgs</span>
                    {c.phone && <span className="truncate">{c.phone}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Histórico */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!detail ? (
          <div className="flex-1 grid place-items-center text-zinc-600 text-sm">
            <div className="flex flex-col items-center gap-2">
              <MessageCircle size={28} />
              <span>Selecione uma conversa</span>
            </div>
          </div>
        ) : (
          <>
            <div className="border-b border-zinc-800/80 px-5 py-3 bg-zinc-950/40">
              <div className="flex items-center gap-3">
                <div className="bg-brand-500/15 ring-1 ring-brand-500/30 rounded-md p-1.5">
                  <User2 size={16} className="text-brand-300" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-zinc-100 truncate">
                    {detail.contactName || `Lead #${detail.leadId}`}
                  </div>
                  <div className="text-[11px] text-zinc-500 flex items-center gap-2">
                    <span className="px-1 py-0.5 rounded bg-zinc-800/60">{detail.channel}</span>
                    {detail.phone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone size={10} />
                        {detail.phone}
                      </span>
                    )}
                    <span>· {detail.unit.name}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {detail.messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    m={m}
                    onFlagToggle={(flagged) => {
                      // Atualização otimista — refresh do detail quando o usuário trocar de conversa.
                      m.flagged = flagged;
                    }}
                  />
                ))}
              </div>
              <MemoryRail memory={detail.memory} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemoryRail — o que a IA lembra deste lead, ao lado do histórico.
//
// Separa DADO DURO (campo do Kommo, sob "Dados do CRM") do contexto que o
// resumo da IA inferiu ("Observado na conversa"). O operador precisa saber o
// que é fato registrado e o que é interpretação — não são a mesma coisa na
// hora de confiar.
// ---------------------------------------------------------------------------

// Chaves que vêm de campo do Kommo (dado duro). Espelha CAMPOS_IMPORTANTES do
// backend — se mudar lá, atualizar aqui.
const HARD_KEYS = new Set([
  'queixa', 'qualificacao', 'preferencia_horario', 'agendou', 'intencao', 'cidade', 'profissao', 'sexo',
]);

const LABELS: Record<string, string> = {
  queixa: 'Queixa',
  qualificacao: 'Qualificação',
  preferencia_horario: 'Preferência de horário',
  agendou: 'Agendou',
  intencao: 'Intenção',
  cidade: 'Cidade',
  profissao: 'Profissão',
  sexo: 'Sexo',
  // Último contato — a noção de tempo/desfecho que a IA usa pra retomar.
  ultimo_contato: 'Último contato',
  ultimo_desfecho: 'Como terminou',
  travou_em: 'Travou em',
};

/** Rótulo técnico do desfecho → frase que o dono entende na tela. */
const DESFECHO_LABEL: Record<string, string> = {
  agendou: 'Agendou',
  sumiu: 'Parou de responder',
  travou_preco: 'Travou no valor',
  pediu_humano: 'Pediu atendente',
  so_duvida: 'Só tirou dúvida',
};

/** Data crua não diz nada pro dono: vira "há 3 dias". */
function prettyValor(k: string, v: unknown): string {
  const s = String(v ?? '');
  if (k === 'ultimo_desfecho') return DESFECHO_LABEL[s] ?? s;
  if (k === 'ultimo_contato') {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return s;
    const dias = Math.floor((Date.now() - t) / 86_400_000);
    if (dias <= 0) return 'hoje';
    if (dias === 1) return 'ontem';
    if (dias < 30) return `há ${dias} dias`;
    const meses = Math.floor(dias / 30);
    return meses === 1 ? 'há um mês' : `há ${meses} meses`;
  }
  return s;
}

function prettyKey(k: string): string {
  return LABELS[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function MemoryRail({ memory }: { memory: LeadMemory | null }) {
  const facts = memory?.facts ?? {};
  const entries = Object.entries(facts).filter(
    ([, v]) => v !== null && v !== undefined && String(v).trim() !== '',
  );
  const hard = entries.filter(([k]) => HARD_KEYS.has(k));
  const soft = entries.filter(([k]) => !HARD_KEYS.has(k));
  const agendou = String(facts['agendou'] ?? '').toLowerCase() === 'sim';

  return (
    <aside className="w-72 shrink-0 border-l border-zinc-800/80 bg-ink-900/60 overflow-y-auto">
      <div className="px-4 py-3 border-b border-zinc-800/80 flex items-center gap-2 sticky top-0 bg-ink-900/95 backdrop-blur">
        <Brain size={14} className="text-brand-300" />
        <span className="text-xs font-semibold text-zinc-200">Memória do paciente</span>
      </div>

      {!memory ? (
        <div className="px-4 py-6 text-[11px] text-zinc-600 leading-relaxed">
          Ainda sem memória para este lead. Ela é montada depois de algumas
          mensagens — aparece aqui assim que a IA consolidar.
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {agendou && (
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-300 bg-emerald-500/10 ring-1 ring-emerald-500/25 rounded-md px-2.5 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Paciente agendado
            </div>
          )}

          {memory.summary && (
            <p className="text-[12.5px] leading-relaxed text-zinc-300">{memory.summary}</p>
          )}

          {hard.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-medium">
                Dados do CRM
              </div>
              {hard.map(([k, v]) => (
                <div key={k} className="text-[11.5px]">
                  <div className="text-zinc-500">{prettyKey(k)}</div>
                  <div className="text-zinc-200 leading-snug">{prettyValor(k, v)}</div>
                </div>
              ))}
            </div>
          )}

          {soft.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-medium">
                Observado na conversa
              </div>
              <div className="flex flex-wrap gap-1.5">
                {soft.map(([k, v]) => (
                  <span
                    key={k}
                    className="text-[10.5px] text-zinc-300 bg-zinc-800/60 rounded px-1.5 py-0.5"
                    title={prettyKey(k)}
                  >
                    {prettyKey(k)}: {prettyValor(k, v)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {memory.updatedAt && (
            <div className="text-[10px] text-zinc-600 pt-1">
              atualizada {timeAgo(memory.updatedAt)} atrás
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function MessageBubble({
  m,
  onFlagToggle,
}: {
  m: ConversationMessage;
  onFlagToggle: (flagged: boolean) => void;
}) {
  const isUser = m.role === 'user';
  const toast = useToast();
  const [flagged, setFlagged] = useState(!!m.flagged);
  const [busy, setBusy] = useState(false);

  async function toggleFlag() {
    const next = !flagged;
    setBusy(true);
    try {
      await api.flagMessage(m.id, next);
      setFlagged(next);
      onFlagToggle(next);
      toast.info(next ? 'Marcada como ruim — a IA vai evitar isso' : 'Flag removida');
    } catch {
      toast.error('Não foi possível atualizar a flag');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={clsx('flex group', isUser ? 'justify-start' : 'justify-end')}>
      <div
        className={clsx(
          'max-w-[70%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap relative',
          isUser
            ? 'bg-zinc-900 ring-1 ring-zinc-800 text-zinc-100'
            : flagged
              ? 'bg-rose-500/10 ring-1 ring-rose-500/40 text-rose-100'
              : 'bg-brand-500/15 ring-1 ring-brand-500/30 text-brand-100',
        )}
      >
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 mb-1">
          {isUser ? <User2 size={10} /> : <Bot size={10} />}
          <span>{isUser ? 'Paciente' : 'IA'}</span>
          <span>·</span>
          <span>{new Date(m.createdAt).toLocaleString('pt-BR')}</span>
          {flagged && (
            <span className="ml-auto text-[9px] uppercase tracking-wider text-rose-300/80">
              flaggada
            </span>
          )}
        </div>
        <div>{m.content}</div>
        {!isUser && (
          <button
            type="button"
            onClick={toggleFlag}
            disabled={busy}
            title={flagged ? 'Desmarcar' : 'Marcar como resposta ruim'}
            className={clsx(
              'absolute -bottom-2 -right-2 p-1 rounded-full bg-zinc-900 ring-1 transition opacity-0 group-hover:opacity-100',
              flagged
                ? 'ring-rose-500/50 text-rose-300 opacity-100'
                : 'ring-zinc-700 text-zinc-500 hover:text-rose-300 hover:ring-rose-500/40',
            )}
          >
            <ThumbsDown size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
