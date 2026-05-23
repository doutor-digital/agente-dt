// ============================================================================
// PlaygroundPanel — chat de teste no layout WhatsApp Web (3 colunas).
//
// LÓGICA DE ENGENHARIA
// --------------------
// 100% sandbox: nenhuma mensagem vai pro banco, nenhuma ação chega no Kommo.
// O backend (/units/:id/playground/run) recebe o histórico de mensagens,
// compõe o systemPrompt real da Unit e roda o LLM com tools "fakes" que
// só registram a chamada.
//
// Layout (estilo WhatsApp Web):
//   - Esquerda: lista de chats — 1 contato fixo "Paciente Teste" (sandbox)
//   - Centro:   conversa ativa — bolhas verdes/cinzas + tool calls inline
//                 como bolhas system (centralizadas, pequenas, clicáveis pra
//                 expandir args)
//   - Direita:  info do contato — persona da Unit + métricas da sessão
//                 (latência/tokens/custo cumulativos)
//
// Decisão de design — tool calls inline em vez de Timeline lateral:
// WhatsApp Web puro não tem espaço pra timeline. As tool calls viram bolhas
// "sistema" centralizadas no chat com emoji + label curto (ex: "🏷️ aplicou
// tag desqualificado"). Clicar expande args. Preserva debugabilidade sem
// coluna extra.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Filter,
  Hash,
  Loader2,
  MoreVertical,
  Paperclip,
  Phone,
  Plus,
  RotateCcw,
  Search,
  Send,
  Smile,
  Sparkles,
  TestTube2,
  Video,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { api, type PlaygroundTimelineEvent } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';

type ChatMessage = { role: 'user' | 'assistant'; content: string; ts: number };

// Item renderizado no centro do chat — derivado do `events`. Mensagens user/
// assistant viram bolhas; tool_calls viram pílulas system centralizadas.
type ChatItem =
  | { kind: 'user'; content: string; ts: number }
  | { kind: 'assistant'; content: string; ts: number }
  | {
      kind: 'tool';
      tool: string;
      args: Record<string, unknown>;
      result: string;
      ts: number;
    };

const TOOL_META: Record<
  string,
  {
    label: (args: Record<string, unknown>) => string;
    emoji: string;
    color: 'amber' | 'sky' | 'rose' | 'fuchsia' | 'violet' | 'zinc';
  }
> = {
  aplicar_tag: {
    emoji: '🏷️',
    color: 'amber',
    label: (a) => {
      const tags = (a.tags as string[] | undefined) ?? [];
      if (tags.length === 0) return 'aplicou tag';
      if (tags.length === 1) return `aplicou tag "${tags[0]}"`;
      return `aplicou ${tags.length} tags`;
    },
  },
  mover_etapa: {
    emoji: '🔀',
    color: 'sky',
    label: (a) => {
      const sid = a.statusId;
      return `moveu pra etapa ${typeof sid === 'number' ? `#${sid}` : ''}`.trim();
    },
  },
  pausar_ia: { emoji: '⏸️', color: 'rose', label: () => 'pausou a IA' },
  atualizar_titulo_lead: {
    emoji: '🪪',
    color: 'fuchsia',
    label: (a) => {
      const nome = a.nome;
      return typeof nome === 'string' ? `atualizou título: "${nome}"` : 'atualizou título';
    },
  },
  resumir_lead_para_sdr: {
    emoji: '📋',
    color: 'violet',
    label: () => 'gerou resumo pro SDR',
  },
};

const TOOL_BUBBLE_CLASSES: Record<string, string> = {
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-200 hover:bg-amber-500/15',
  sky: 'bg-sky-500/10 border-sky-500/30 text-sky-200 hover:bg-sky-500/15',
  rose: 'bg-rose-500/10 border-rose-500/30 text-rose-200 hover:bg-rose-500/15',
  fuchsia: 'bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-200 hover:bg-fuchsia-500/15',
  violet: 'bg-violet-500/10 border-violet-500/30 text-violet-200 hover:bg-violet-500/15',
  zinc: 'bg-zinc-800/80 border-zinc-700/60 text-zinc-300 hover:bg-zinc-800',
};

const SUGGESTIONS: string[] = [
  '👋 Oi, tudo bem?',
  '💸 Quanto custa a consulta?',
  '⏰ Vocês atendem sábado?',
  '🙋 Sou a Maria, prazer!',
  '🆘 Quero falar com um atendente',
  '👀 Vi vocês no Instagram',
];

// Agregado da sessão (acumula todos os turnos).
type TurnMeta = {
  model: string;
  iterations: number;
  totalLatencyMs: number;
  tokens: { prompt: number; completion: number; total: number } | null;
  costUsd: number | null;
};

export function PlaygroundPanel() {
  const { selectedUnitId, selectedUnit } = useUnit();
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<PlaygroundTimelineEvent[]>([]);
  const [turns, setTurns] = useState<TurnMeta[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll quando chegam itens novos no chat.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, messages, loading]);

  // Reset quando troca de unidade.
  useEffect(() => {
    setMessages([]);
    setEvents([]);
    setTurns([]);
    setInput('');
  }, [selectedUnitId]);

  const canSend = useMemo(
    () => !!selectedUnitId && input.trim().length > 0 && !loading,
    [selectedUnitId, input, loading],
  );

  // Deriva os itens do chat (user/assistant/tool) a partir dos events. Os
  // events do servidor já vêm em ordem cronológica — só filtramos thinking
  // (ruído visual demais como bolha).
  const chatItems = useMemo<ChatItem[]>(() => {
    const items: ChatItem[] = [];
    for (const ev of events) {
      if (ev.kind === 'user_message') {
        items.push({ kind: 'user', content: ev.content, ts: ev.ts });
      } else if (ev.kind === 'assistant_message') {
        items.push({ kind: 'assistant', content: ev.content, ts: ev.ts });
      } else if (ev.kind === 'tool_call') {
        items.push({
          kind: 'tool',
          tool: ev.tool,
          args: ev.args,
          result: ev.result,
          ts: ev.ts,
        });
      }
    }
    // Durante o loading, a msg do user já foi pra `messages` mas ainda não
    // veio do server em `events`. Acrescenta no final pra não "sumir".
    if (loading && messages.length > 0) {
      const lastUserInMsgs = [...messages].reverse().find((m) => m.role === 'user');
      const lastUserInEvents = [...items].reverse().find((i) => i.kind === 'user') as
        | (ChatItem & { kind: 'user' })
        | undefined;
      if (
        lastUserInMsgs &&
        (!lastUserInEvents || lastUserInEvents.content !== lastUserInMsgs.content)
      ) {
        items.push({
          kind: 'user',
          content: lastUserInMsgs.content,
          ts: lastUserInMsgs.ts,
        });
      }
    }
    return items;
  }, [events, loading, messages]);

  async function send(text: string) {
    if (!selectedUnitId) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMsg: ChatMessage = { role: 'user', content: trimmed, ts: Date.now() };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    setLoading(true);

    try {
      const result = await api.playgroundRun(
        selectedUnitId,
        nextHistory.map((m) => ({ role: m.role, content: m.content })),
      );

      setMessages([...nextHistory, { role: 'assistant', content: result.reply, ts: Date.now() }]);
      setEvents((prev) => [...prev, ...result.timeline]);
      setTurns((prev) => [...prev, result.meta]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha no playground: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setEvents([]);
    setTurns([]);
    setInput('');
  }

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra testar a IA.
      </div>
    );
  }

  // Métricas agregadas da sessão.
  const totalLatency = turns.reduce((acc, t) => acc + t.totalLatencyMs, 0);
  const totalCost = turns.reduce((acc, t) => acc + (t.costUsd ?? 0), 0);
  const totalTokens = turns.reduce((acc, t) => acc + (t.tokens?.total ?? 0), 0);
  const lastModel = turns.length > 0 ? turns[turns.length - 1].model : null;

  // Preview da última mensagem pra mostrar na lista lateral.
  const lastChatItem = chatItems[chatItems.length - 1];
  const lastMessagePreview =
    lastChatItem?.kind === 'user'
      ? lastChatItem.content
      : lastChatItem?.kind === 'assistant'
        ? lastChatItem.content
        : lastChatItem?.kind === 'tool'
          ? `ação: ${TOOL_META[lastChatItem.tool]?.emoji ?? '⚙️'} ${lastChatItem.tool}`
          : null;

  const session: SessionMetrics = {
    turns: turns.length,
    totalLatencyMs: totalLatency,
    totalTokens,
    totalCostUsd: totalCost,
    lastModel,
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-zinc-950">
      {/* Header slim */}
      <SlimHeader
        onReset={reset}
        canReset={messages.length > 0 || events.length > 0}
      />

      {/* Corpo 3 colunas */}
      <div className="flex-1 overflow-hidden flex">
        <ChatListSidebar
          lastMessagePreview={lastMessagePreview}
          lastTs={lastChatItem?.ts ?? null}
        />
        <ChatCenter
          chatScrollRef={chatScrollRef}
          chatItems={chatItems}
          loading={loading}
          input={input}
          onInputChange={setInput}
          onSend={() => void send(input)}
          onSuggestion={(s) => void send(s)}
          canSend={canSend}
        />
        <ContactInfoSidebar unit={selectedUnit} session={session} />
      </div>
    </div>
  );
}

// ===========================================================================
// Header slim — fica no topo, fora das 3 colunas
// ===========================================================================

function SlimHeader({
  onReset,
  canReset,
}: {
  onReset: () => void;
  canReset: boolean;
}) {
  return (
    <div className="px-6 py-3 border-b border-zinc-800/60 bg-zinc-950/95 backdrop-blur flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <TestTube2 size={18} className="text-emerald-300" />
        <h1 className="text-sm font-semibold text-zinc-100">Testar IA</h1>
        <span className="text-[10px] uppercase tracking-wider bg-emerald-500/15 text-emerald-300 px-2 py-0.5 rounded-full ring-1 ring-emerald-500/30">
          Sandbox 🧪
        </span>
        <span className="text-[11px] text-zinc-500 ml-2 hidden md:inline">
          Nada vai pro Kommo nem pro banco — as ações da IA aparecem como balões no chat.
        </span>
      </div>
      <button
        type="button"
        onClick={onReset}
        disabled={!canReset}
        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60 disabled:opacity-40 disabled:hover:bg-transparent"
        title="Reiniciar conversa"
      >
        <RotateCcw size={13} />
        Resetar
      </button>
    </div>
  );
}

// ===========================================================================
// Coluna esquerda — lista de chats (1 contato fixo)
// ===========================================================================

function ChatListSidebar({
  lastMessagePreview,
  lastTs,
}: {
  lastMessagePreview: string | null;
  lastTs: number | null;
}) {
  return (
    <aside className="w-[320px] shrink-0 flex flex-col border-r border-zinc-800/60 bg-zinc-950">
      {/* Header da lista — barra de busca decorativa */}
      <div className="px-4 py-3 border-b border-zinc-800/60 flex items-center gap-2">
        <div className="w-9 h-9 rounded-full bg-emerald-700/80 flex items-center justify-center text-white text-sm font-semibold ring-2 ring-emerald-500/30">
          DT
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-zinc-100">Conversas</div>
          <div className="text-[10px] text-zinc-500">sandbox · 1 chat</div>
        </div>
        <button
          type="button"
          className="w-8 h-8 rounded-full hover:bg-zinc-900/60 flex items-center justify-center text-zinc-500"
          title="Filtrar (decorativo)"
        >
          <Filter size={14} />
        </button>
      </div>

      {/* Barra de busca decorativa */}
      <div className="px-3 py-2 border-b border-zinc-800/60">
        <div className="flex items-center gap-2 bg-zinc-900/80 rounded-full px-3 py-1.5 ring-1 ring-zinc-800/80">
          <Search size={13} className="text-zinc-500 shrink-0" />
          <input
            type="text"
            disabled
            placeholder="Pesquisar conversa…"
            className="flex-1 bg-transparent text-[11.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>
      </div>

      {/* Item único — Paciente Teste */}
      <div className="flex-1 overflow-y-auto">
        <button
          type="button"
          className="w-full flex items-center gap-3 px-3 py-3 hover:bg-zinc-900/40 transition-colors bg-emerald-500/[0.04] border-l-2 border-emerald-500"
        >
          <div className="w-12 h-12 rounded-full bg-emerald-700/60 flex items-center justify-center text-white text-base font-semibold ring-2 ring-emerald-500/20 shrink-0">
            🤒
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="flex items-center gap-2">
              <div className="text-[13px] font-semibold text-zinc-100 truncate">
                Paciente Teste
              </div>
              <div className="ml-auto text-[10px] text-zinc-500 tabular-nums shrink-0">
                {lastTs ? formatClock(lastTs) : '—'}
              </div>
            </div>
            <div className="text-[11.5px] text-zinc-400 truncate mt-0.5">
              {lastMessagePreview ?? 'Comece uma conversa pra simular um lead.'}
            </div>
          </div>
        </button>

        <div className="px-4 py-6 text-center text-[11px] text-zinc-600 leading-relaxed">
          Só um contato no sandbox.
          <br />
          Pra testar mais cenários, resete e mande uma mensagem diferente.
        </div>
      </div>
    </aside>
  );
}

// ===========================================================================
// Centro — chat com bolhas + tool calls inline + composer
// ===========================================================================

function ChatCenter({
  chatScrollRef,
  chatItems,
  loading,
  input,
  onInputChange,
  onSend,
  onSuggestion,
  canSend,
}: {
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatItems: ChatItem[];
  loading: boolean;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onSuggestion: (s: string) => void;
  canSend: boolean;
}) {
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-[#0b141a]">
      {/* Header do chat — contato ativo */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800/60">
        <button
          type="button"
          className="md:hidden text-zinc-400 hover:text-zinc-100"
          title="Voltar (decorativo)"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="w-10 h-10 rounded-full bg-emerald-700/60 flex items-center justify-center text-white text-base font-semibold ring-2 ring-emerald-500/20">
          🤒
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-zinc-100">Paciente Teste</div>
          <div className="text-[10.5px] text-emerald-300/80">
            {loading ? 'digitando…' : 'online · sandbox 🧪'}
          </div>
        </div>
        <button
          type="button"
          className="w-9 h-9 rounded-full hover:bg-zinc-800/60 flex items-center justify-center text-zinc-400"
          title="Vídeo (decorativo)"
          disabled
        >
          <Video size={15} />
        </button>
        <button
          type="button"
          className="w-9 h-9 rounded-full hover:bg-zinc-800/60 flex items-center justify-center text-zinc-400"
          title="Chamada (decorativo)"
          disabled
        >
          <Phone size={14} />
        </button>
        <button
          type="button"
          className="w-9 h-9 rounded-full hover:bg-zinc-800/60 flex items-center justify-center text-zinc-400"
          title="Mais (decorativo)"
          disabled
        >
          <MoreVertical size={15} />
        </button>
      </div>

      {/* Stream do chat — wallpaper estilo WhatsApp */}
      <div
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto px-6 py-4 space-y-2"
        style={{
          backgroundColor: '#0b141a',
          backgroundImage:
            'radial-gradient(circle at 15% 20%, rgba(16,185,129,0.05) 0px, transparent 55%), radial-gradient(circle at 85% 80%, rgba(16,185,129,0.04) 0px, transparent 50%)',
        }}
      >
        {chatItems.length === 0 && !loading && (
          <EmptyChatState onSuggestion={onSuggestion} />
        )}

        {chatItems.map((item, i) => (
          <ChatItemRow key={`${item.ts}-${i}`} item={item} />
        ))}

        {loading && <TypingIndicator />}
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900/80 border-t border-zinc-800/60"
      >
        <button
          type="button"
          className="w-9 h-9 rounded-full hover:bg-zinc-800/60 flex items-center justify-center text-zinc-400 shrink-0"
          title="Emoji (decorativo)"
          disabled
        >
          <Smile size={18} />
        </button>
        <button
          type="button"
          className="w-9 h-9 rounded-full hover:bg-zinc-800/60 flex items-center justify-center text-zinc-400 shrink-0"
          title="Anexo (decorativo)"
          disabled
        >
          <Paperclip size={17} />
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Digite uma mensagem como se fosse o lead…"
          disabled={loading}
          className="flex-1 bg-zinc-800/80 rounded-full px-4 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 min-w-0"
        />
        <button
          type={canSend ? 'submit' : 'button'}
          disabled={!canSend}
          className="w-10 h-10 rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:opacity-50 flex items-center justify-center text-white shrink-0 transition-colors"
          title={canSend ? 'Enviar' : 'Digite uma mensagem'}
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </form>
    </div>
  );
}

function EmptyChatState({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center pt-10">
      <div className="text-[10px] text-emerald-100/60 bg-emerald-900/40 px-2.5 py-1 rounded-full mb-6 ring-1 ring-emerald-800/40">
        🔒 Mensagens fim-a-fim (sandbox)
      </div>
      <Bot size={48} className="text-emerald-700/30 mb-3" />
      <p className="text-[12px] text-zinc-400 text-center mb-4 max-w-sm">
        Mande uma mensagem como se fosse o lead.
        <br />A IA vai responder e as ações que ela tomar aparecem como balões no chat.
      </p>
      <div className="flex flex-wrap gap-1.5 justify-center max-w-md px-4">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggestion(s)}
            className="text-[11px] px-2.5 py-1 rounded-full bg-emerald-900/30 text-emerald-100 ring-1 ring-emerald-700/30 hover:bg-emerald-800/40 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatItemRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user' || item.kind === 'assistant') return <ChatBubble item={item} />;
  return <ToolSystemBubble item={item} />;
}

function ChatBubble({
  item,
}: {
  item: Extract<ChatItem, { kind: 'user' | 'assistant' }>;
}) {
  const isUser = item.kind === 'user';
  return (
    <div className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={clsx(
          'max-w-[65%] rounded-lg px-3 py-1.5 shadow-sm relative',
          isUser
            ? 'bg-emerald-700 text-white rounded-tr-sm'
            : 'bg-zinc-800/95 text-zinc-100 rounded-tl-sm',
        )}
      >
        <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
          {item.content}
        </div>
        <div
          className={clsx(
            'flex items-center gap-1 mt-1 text-[10px] justify-end tabular-nums',
            isUser ? 'text-emerald-100/70' : 'text-zinc-500',
          )}
        >
          <span>{formatClock(item.ts)}</span>
          {isUser && <CheckCheck size={12} className="text-emerald-100/80" />}
        </div>
      </div>
    </div>
  );
}

function ToolSystemBubble({
  item,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
}) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[item.tool] ?? {
    emoji: '⚙️',
    color: 'zinc' as const,
    label: () => item.tool,
  };
  const argsEntries = Object.entries(item.args).filter(([k]) => k !== 'leadId');

  return (
    <div className="flex justify-center my-1">
      <div
        className={clsx(
          'inline-flex flex-col max-w-[80%] rounded-full text-[11px]',
          'transition-colors',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={clsx(
            'inline-flex items-center gap-1.5 px-3 py-1 rounded-full border',
            TOOL_BUBBLE_CLASSES[meta.color] ?? TOOL_BUBBLE_CLASSES.zinc,
          )}
          title="Detalhes da ação da IA"
        >
          <span>{meta.emoji}</span>
          <span className="font-medium">{meta.label(item.args)}</span>
          <span className="opacity-50 text-[10px] tabular-nums">{formatClock(item.ts)}</span>
          {open ? (
            <ChevronDown size={11} className="opacity-60" />
          ) : (
            <ChevronRight size={11} className="opacity-60" />
          )}
        </button>
        {open && (
          <div
            className={clsx(
              'mt-1 rounded-md border px-3 py-2 text-[10.5px] font-mono space-y-1',
              TOOL_BUBBLE_CLASSES[meta.color] ?? TOOL_BUBBLE_CLASSES.zinc,
            )}
          >
            <div className="text-[10px] opacity-60 uppercase tracking-wider">
              {item.tool}
            </div>
            {argsEntries.length === 0 ? (
              <div className="opacity-60">(sem args além de leadId)</div>
            ) : (
              argsEntries.map(([k, v]) => (
                <div key={k} className="break-all">
                  <span className="opacity-60">{k}=</span>
                  {JSON.stringify(v)}
                </div>
              ))
            )}
            <div className="mt-1 pt-1 border-t border-current/10 opacity-80 break-words">
              <span className="opacity-60">→ </span>
              {item.result}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-zinc-800/95 rounded-lg rounded-tl-sm px-3 py-2 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" />
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.3s]" />
      </div>
    </div>
  );
}

// ===========================================================================
// Coluna direita — info do contato + métricas da sessão
// ===========================================================================

interface SessionMetrics {
  turns: number;
  totalLatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  lastModel: string | null;
}

function ContactInfoSidebar({
  unit,
  session,
}: {
  unit: ReturnType<typeof useUnit>['selectedUnit'];
  session: SessionMetrics;
}) {
  const personaTone = unit?.personaTone ?? '—';
  const personaCompany = unit?.personaCompanyName ?? unit?.name ?? '—';

  return (
    <aside className="w-[320px] shrink-0 flex flex-col border-l border-zinc-800/60 bg-zinc-950 overflow-y-auto">
      {/* Hero — avatar grande + nome */}
      <div className="px-6 pt-8 pb-5 text-center border-b border-zinc-800/60">
        <div className="w-24 h-24 rounded-full bg-emerald-700/40 flex items-center justify-center text-3xl ring-4 ring-emerald-500/15 mx-auto mb-3">
          🤒
        </div>
        <div className="text-[15px] font-semibold text-zinc-100">Paciente Teste</div>
        <div className="text-[11px] text-zinc-500 mt-0.5">WhatsApp · sandbox 🧪</div>
      </div>

      {/* Persona ativa */}
      <Section icon={<Sparkles size={13} className="text-violet-300" />} title="Persona ativa">
        <SectionRow label="Empresa" value={personaCompany} />
        <SectionRow label="Tom" value={String(personaTone)} />
        {unit?.personaGreeting && (
          <div className="px-3 pb-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
              Saudação
            </div>
            <div className="text-[11px] text-zinc-300 italic line-clamp-3">
              "{unit.personaGreeting}"
            </div>
          </div>
        )}
      </Section>

      {/* Setup do agente */}
      <Section icon={<Zap size={13} className="text-amber-300" />} title="Setup do agente">
        <SectionRow
          label="Tools sandbox"
          value="5"
          hint="tag · etapa · pausa · título · resumo"
        />
        <SectionRow
          label="Coleta de nome"
          value={unit?.collectNameEnabled ? 'on' : 'off'}
        />
        <SectionRow
          label="Coleta de origem"
          value={unit?.collectSourceEnabled ? 'on' : 'off'}
        />
        <SectionRow
          label="Horário comercial"
          value={unit?.businessHoursEnabled ? 'on' : 'off'}
        />
        <SectionRow
          label="Resumo→campo"
          value={
            unit?.summaryCustomFieldName
              ? `"${unit.summaryCustomFieldName}"`
              : '(só nota)'
          }
        />
      </Section>

      {/* Métricas da sessão */}
      <Section icon={<Hash size={13} className="text-sky-300" />} title="Sessão atual">
        <SectionRow label="Turnos" value={String(session.turns)} />
        <SectionRow
          label="Latência total"
          value={session.totalLatencyMs > 0 ? formatLatency(session.totalLatencyMs) : '—'}
        />
        <SectionRow
          label="Tokens"
          value={session.totalTokens > 0 ? formatNumber(session.totalTokens) : '—'}
        />
        <SectionRow
          label="Custo"
          value={session.totalCostUsd > 0 ? `$${session.totalCostUsd.toFixed(4)}` : '—'}
        />
        {session.lastModel && (
          <SectionRow label="Último modelo" value={session.lastModel} mono />
        )}
      </Section>

      {/* Dica */}
      <div className="px-4 py-4 mt-auto border-t border-zinc-800/60">
        <div className="flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed">
          <BookOpen size={13} className="text-zinc-600 shrink-0 mt-0.5" />
          <p>
            Os balões coloridos centralizados no chat são <strong>ações da IA</strong> — clique
            num pra ver os argumentos.
          </p>
        </div>
      </div>
    </aside>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-zinc-800/60">
      <div className="px-4 pt-4 pb-2 flex items-center gap-2">
        {icon}
        <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
          {title}
        </h3>
      </div>
      <div className="pb-2 space-y-1">{children}</div>
    </div>
  );
}

function SectionRow({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="px-4 py-1.5 flex items-baseline gap-3">
      <div className="text-[11px] text-zinc-500 shrink-0 w-[110px]">{label}</div>
      <div className="flex-1 min-w-0">
        <div
          className={clsx(
            'text-[12px] text-zinc-200 truncate',
            mono && 'font-mono text-[11px]',
          )}
          title={value}
        >
          {value}
        </div>
        {hint && <div className="text-[10px] text-zinc-600 truncate">{hint}</div>}
      </div>
    </div>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Re-export pra evitar warning de import não utilizado em casos parciais.
// (Plus é placeholder se quisermos um botão "novo chat" no futuro.)
void Plus;
