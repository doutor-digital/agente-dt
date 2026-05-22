// ============================================================================
// PlaygroundPanel — chat de teste pra conversar com a IA da Unit selecionada.
//
// LÓGICA DE ENGENHARIA
// --------------------
// 100% sandbox: nenhuma mensagem vai pro banco, nenhuma ação chega no Kommo.
// O backend (/units/:id/playground/run) recebe o histórico de mensagens,
// compõe o systemPrompt real da Unit (com tudo do Wizard + RAG + templates)
// e roda o LLM com tools "fakes" que só registram a chamada.
//
// A UI mostra:
//   - Mockup de celular à esquerda com chat estilo WhatsApp dentro
//   - Timeline cronológica à direita com tudo que aconteceu por turno:
//     msg do lead → IA pensou (latência/tokens/custo) → tool calls → resposta
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BatteryFull,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  Mic,
  Paperclip,
  Phone,
  RotateCcw,
  Send,
  Signal,
  Smile,
  Sparkles,
  TestTube2,
  Video,
  Wifi,
} from 'lucide-react';
import clsx from 'clsx';
import { api, type PlaygroundTimelineEvent } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';

type ChatMessage = { role: 'user' | 'assistant'; content: string; ts: number };

const TOOL_META: Record<
  string,
  { label: string; emoji: string; color: 'amber' | 'sky' | 'rose' | 'fuchsia' | 'zinc' }
> = {
  aplicar_tag: { label: 'Tag aplicada', emoji: '🏷️', color: 'amber' },
  mover_etapa: { label: 'Etapa movida', emoji: '🔀', color: 'sky' },
  pausar_ia: { label: 'IA pausada', emoji: '⏸️', color: 'rose' },
  atualizar_titulo_lead: { label: 'Título atualizado', emoji: '🪪', color: 'fuchsia' },
};

const TOOL_COLOR_CLASSES: Record<string, string> = {
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
  sky: 'bg-sky-500/10 border-sky-500/30 text-sky-200',
  rose: 'bg-rose-500/10 border-rose-500/30 text-rose-200',
  fuchsia: 'bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-200',
  zinc: 'bg-zinc-900 border-zinc-800 text-zinc-300',
};

const TOOL_DOT_CLASSES: Record<string, string> = {
  amber: 'bg-amber-400',
  sky: 'bg-sky-400',
  rose: 'bg-rose-400',
  fuchsia: 'bg-fuchsia-400',
  zinc: 'bg-zinc-400',
};

const SUGGESTIONS: string[] = [
  '👋 Oi, tudo bem?',
  '💸 Quanto custa a consulta?',
  '⏰ Vocês atendem sábado?',
  '🙋 Sou a Maria, prazer!',
  '🆘 Quero falar com um atendente',
  '👀 Vi vocês no Instagram',
];

// Agregado da timeline (acumula todos os turnos do session).
type TurnMeta = {
  model: string;
  iterations: number;
  totalLatencyMs: number;
  tokens: { prompt: number; completion: number; total: number } | null;
  costUsd: number | null;
};

export function PlaygroundPanel() {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<PlaygroundTimelineEvent[]>([]);
  const [turns, setTurns] = useState<TurnMeta[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const phoneScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll do chat quando chegam mensagens novas.
  useEffect(() => {
    const el = phoneScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // Auto-scroll da timeline pra mostrar o evento mais recente.
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, loading]);

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

  // Métricas agregadas pro header da timeline.
  const totalLatency = turns.reduce((acc, t) => acc + t.totalLatencyMs, 0);
  const totalCost = turns.reduce((acc, t) => acc + (t.costUsd ?? 0), 0);
  const totalTokens = turns.reduce((acc, t) => acc + (t.tokens?.total ?? 0), 0);
  const lastModel = turns.length > 0 ? turns[turns.length - 1].model : null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header sticky compartilhado */}
      <div className="px-6 pt-5 pb-3 border-b border-zinc-800/60 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <TestTube2 size={18} className="text-emerald-300" />
              Testar IA
              <span className="text-[10px] uppercase tracking-wider bg-emerald-500/15 text-emerald-300 px-2 py-0.5 rounded-full ring-1 ring-emerald-500/30">
                Sandbox 🧪
              </span>
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Converse no celular simulado. Nada vai pro Kommo nem pro banco — a timeline ao lado mostra cada passo. ✨
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            disabled={messages.length === 0 && events.length === 0}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60 disabled:opacity-40 disabled:hover:bg-transparent"
            title="Reiniciar conversa"
          >
            <RotateCcw size={13} />
            Resetar
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {/* Coluna esquerda — phone frame */}
        <div className="flex-1 min-w-0 flex items-center justify-center px-6 py-6 bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,0.06),transparent_60%)]">
          <PhoneFrame
            messages={messages}
            loading={loading}
            input={input}
            onInputChange={setInput}
            onSend={() => void send(input)}
            onSuggestion={(s) => void send(s)}
            canSend={canSend}
          />
        </div>

        {/* Coluna direita — timeline */}
        <aside className="w-[420px] shrink-0 flex flex-col border-l border-zinc-800/60 bg-zinc-950/70">
          <div className="px-4 py-3 border-b border-zinc-800/60">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={14} className="text-violet-300" />
              <h2 className="text-sm font-semibold text-zinc-100">Timeline da resposta</h2>
              <span className="text-[10px] text-zinc-500 ml-auto">
                {events.length} {events.length === 1 ? 'evento' : 'eventos'}
              </span>
            </div>
            {turns.length > 0 ? (
              <div className="grid grid-cols-4 gap-1.5 text-[10px]">
                <MetricChip label="Modelo" value={lastModel ?? '—'} accent="violet" />
                <MetricChip
                  label="Latência"
                  value={formatLatency(totalLatency)}
                  accent="emerald"
                />
                <MetricChip
                  label="Tokens"
                  value={totalTokens > 0 ? formatNumber(totalTokens) : '—'}
                  accent="sky"
                />
                <MetricChip
                  label="Custo"
                  value={totalCost > 0 ? `$${totalCost.toFixed(4)}` : '—'}
                  accent="amber"
                />
              </div>
            ) : (
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Cada mensagem cria uma linha do tempo aqui: o que o lead disse, quanto a IA pensou, quais ações ela tomaria, e a resposta final. 👇
              </p>
            )}
          </div>

          <div ref={timelineScrollRef} className="flex-1 overflow-y-auto px-4 py-3">
            {events.length === 0 ? (
              <div className="text-center py-10 border border-dashed border-zinc-800 rounded-lg">
                <Brain size={22} className="text-zinc-700 mx-auto mb-2" />
                <p className="text-[11px] text-zinc-600 px-4">
                  Mande uma mensagem no celular pra ver o passo a passo da decisão.
                </p>
              </div>
            ) : (
              <ol className="relative space-y-2.5">
                {/* Linha vertical conectando os pontos */}
                <span
                  aria-hidden
                  className="absolute left-[11px] top-1.5 bottom-1.5 w-px bg-gradient-to-b from-zinc-800 via-zinc-800/60 to-transparent"
                />
                {events.map((ev, i) => (
                  <TimelineRow key={i} event={ev} />
                ))}
                {loading && <TimelineLoadingRow />}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PhoneFrame — mockup de smartphone com status bar, header WhatsApp e chat.
// ---------------------------------------------------------------------------

interface PhoneFrameProps {
  messages: ChatMessage[];
  loading: boolean;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onSuggestion: (s: string) => void;
  canSend: boolean;
}

function PhoneFrame({
  messages,
  loading,
  input,
  onInputChange,
  onSend,
  onSuggestion,
  canSend,
}: PhoneFrameProps) {
  const phoneScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = phoneScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const now = useNow();

  return (
    <div
      className="relative shadow-2xl shadow-emerald-500/10"
      style={{ width: 360, height: 720 }}
    >
      {/* Bezel externo do celular */}
      <div className="absolute inset-0 rounded-[44px] bg-zinc-900 ring-1 ring-zinc-700/60 p-[10px]">
        {/* Botões laterais decorativos */}
        <span className="absolute top-24 -left-[3px] w-[3px] h-10 rounded-l-sm bg-zinc-800" />
        <span className="absolute top-40 -left-[3px] w-[3px] h-16 rounded-l-sm bg-zinc-800" />
        <span className="absolute top-32 -right-[3px] w-[3px] h-20 rounded-r-sm bg-zinc-800" />

        {/* Tela */}
        <div className="relative h-full w-full rounded-[34px] overflow-hidden bg-zinc-950 flex flex-col">
          {/* Dynamic Island */}
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-[100px] h-[26px] rounded-full bg-black z-30" />

          {/* Status bar */}
          <div className="flex items-center justify-between px-6 pt-2.5 pb-1 text-[11px] font-medium text-white relative z-20">
            <span className="tracking-tight">{formatClock(now)}</span>
            <div className="flex items-center gap-1 opacity-90">
              <Signal size={11} />
              <Wifi size={11} />
              <BatteryFull size={13} />
            </div>
          </div>

          {/* Header WhatsApp */}
          <div className="flex items-center gap-3 px-3 py-2.5 bg-emerald-700/95 border-b border-emerald-800/50">
            <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center ring-2 ring-emerald-300/30">
              <Bot size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-white truncate">DT IA</div>
              <div className="text-[10px] text-emerald-100/80">
                {loading ? 'digitando…' : 'online'}
              </div>
            </div>
            <Video size={16} className="text-emerald-100/80" />
            <Phone size={15} className="text-emerald-100/80" />
          </div>

          {/* Chat — wallpaper */}
          <div
            ref={phoneScrollRef}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
            style={{
              backgroundColor: '#0b1410',
              backgroundImage:
                'radial-gradient(circle at 20% 30%, rgba(16,185,129,0.08) 0px, transparent 60%), radial-gradient(circle at 80% 70%, rgba(16,185,129,0.05) 0px, transparent 50%)',
            }}
          >
            {messages.length === 0 && !loading && (
              <div className="flex flex-col items-center pt-6">
                <div className="text-[10px] text-emerald-100/60 bg-emerald-900/40 px-2 py-1 rounded-full mb-4">
                  🔒 Mensagens fim-a-fim (sandbox)
                </div>
                <MessageSquare size={28} className="text-emerald-700/40 mb-2" />
                <p className="text-[11px] text-zinc-400 text-center mb-3 px-6">
                  Comece como se fosse um lead falando.
                </p>
                <div className="flex flex-wrap gap-1.5 justify-center px-2">
                  {SUGGESTIONS.slice(0, 4).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onSuggestion(s)}
                      className="text-[10px] px-2 py-1 rounded-full bg-emerald-900/40 text-emerald-100 ring-1 ring-emerald-700/40 hover:bg-emerald-800/50 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <PhoneBubble key={i} message={m} />
            ))}

            {loading && <PhoneTypingIndicator />}
          </div>

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
            className="flex items-center gap-1.5 px-2 py-2 bg-zinc-900 border-t border-zinc-800"
          >
            <div className="flex-1 flex items-center gap-1.5 bg-zinc-800/80 rounded-full px-3 py-1.5 ring-1 ring-zinc-700/60">
              <Smile size={15} className="text-zinc-500 shrink-0" />
              <input
                type="text"
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder="Mensagem"
                className="flex-1 bg-transparent text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none min-w-0"
                disabled={loading}
              />
              <Paperclip size={14} className="text-zinc-500 shrink-0" />
            </div>
            <button
              type={canSend ? 'submit' : 'button'}
              disabled={!canSend}
              className="w-9 h-9 rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:opacity-60 flex items-center justify-center text-white transition-colors"
              title={canSend ? 'Enviar' : 'Digite uma mensagem'}
            >
              {loading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : canSend ? (
                <Send size={14} />
              ) : (
                <Mic size={14} />
              )}
            </button>
          </form>

          {/* Home indicator */}
          <div className="flex justify-center py-1.5 bg-zinc-900">
            <span className="w-28 h-1 rounded-full bg-zinc-600/80" />
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={clsx(
          'max-w-[78%] rounded-lg px-2.5 py-1.5 shadow-sm relative',
          isUser
            ? 'bg-emerald-700/95 text-white rounded-tr-sm'
            : 'bg-zinc-800/90 text-zinc-100 rounded-tl-sm',
        )}
      >
        <div className="text-[12.5px] leading-snug whitespace-pre-wrap break-words">
          {message.content}
        </div>
        <div
          className={clsx(
            'text-[9px] mt-0.5 text-right tabular-nums',
            isUser ? 'text-emerald-100/70' : 'text-zinc-500',
          )}
        >
          {formatClock(message.ts)} {isUser && '✓✓'}
        </div>
      </div>
    </div>
  );
}

function PhoneTypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-zinc-800/90 rounded-lg rounded-tl-sm px-3 py-2 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" />
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.3s]" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline rows.
// ---------------------------------------------------------------------------

function TimelineRow({ event }: { event: PlaygroundTimelineEvent }) {
  switch (event.kind) {
    case 'user_message':
      return <UserMessageRow event={event} />;
    case 'thinking':
      return <ThinkingRow event={event} />;
    case 'tool_call':
      return <ToolCallRow event={event} />;
    case 'assistant_message':
      return <AssistantMessageRow event={event} />;
  }
}

function TimelineDot({ accent }: { accent: string }) {
  return (
    <span
      className={clsx(
        'absolute left-[7px] top-2.5 w-[10px] h-[10px] rounded-full ring-2 ring-zinc-950 z-10',
        accent,
      )}
    />
  );
}

function UserMessageRow({
  event,
}: {
  event: Extract<PlaygroundTimelineEvent, { kind: 'user_message' }>;
}) {
  return (
    <li className="relative pl-7">
      <TimelineDot accent="bg-sky-400" />
      <div className="rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-sky-300">
            Lead enviou
          </span>
          <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">
            {formatClock(event.ts)}
          </span>
        </div>
        <div className="text-[12px] text-zinc-200 leading-snug break-words">
          “{event.content}”
        </div>
      </div>
    </li>
  );
}

function ThinkingRow({
  event,
}: {
  event: Extract<PlaygroundTimelineEvent, { kind: 'thinking' }>;
}) {
  return (
    <li className="relative pl-7">
      <TimelineDot accent="bg-violet-400" />
      <div className="rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <Brain size={11} className="text-violet-300" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-violet-300">
            IA processou (iter #{event.iteration})
          </span>
          <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">
            {formatClock(event.ts)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px]">
          <span className="px-1.5 py-0.5 rounded bg-zinc-900 ring-1 ring-zinc-800 text-zinc-300 font-mono">
            {event.model}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 ring-1 ring-emerald-500/20 text-emerald-200 tabular-nums">
            ⏱ {formatLatency(event.durationMs)}
          </span>
          {event.tokens && (
            <span
              className="px-1.5 py-0.5 rounded bg-sky-500/10 ring-1 ring-sky-500/20 text-sky-200 tabular-nums"
              title={`prompt ${event.tokens.prompt} · completion ${event.tokens.completion}`}
            >
              🪙 {formatNumber(event.tokens.total)} tok
            </span>
          )}
          {event.costUsd !== undefined && event.costUsd > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 ring-1 ring-amber-500/20 text-amber-200 tabular-nums">
              💲 ${event.costUsd.toFixed(5)}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function ToolCallRow({
  event,
}: {
  event: Extract<PlaygroundTimelineEvent, { kind: 'tool_call' }>;
}) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[event.tool] ?? {
    label: event.tool,
    emoji: '⚙️',
    color: 'zinc' as const,
  };
  const argsEntries = Object.entries(event.args).filter(([k]) => k !== 'leadId');

  return (
    <li className="relative pl-7">
      <TimelineDot accent={TOOL_DOT_CLASSES[meta.color] ?? TOOL_DOT_CLASSES.zinc} />
      <div
        className={clsx(
          'rounded-md border px-3 py-2',
          TOOL_COLOR_CLASSES[meta.color] ?? TOOL_COLOR_CLASSES.zinc,
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 text-left"
        >
          <span className="text-sm">{meta.emoji}</span>
          <span className="text-[11px] font-semibold">{meta.label}</span>
          <code className="text-[9px] font-mono opacity-60">{event.tool}</code>
          <span className="ml-auto text-[10px] opacity-70 tabular-nums">
            {formatClock(event.ts)}
          </span>
          {open ? (
            <ChevronDown size={11} className="opacity-70" />
          ) : (
            <ChevronRight size={11} className="opacity-70" />
          )}
        </button>

        {open && (
          <div className="mt-2 pt-2 border-t border-current/20 space-y-1 text-[10.5px] font-mono">
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
            <div className="mt-1 pt-1 border-t border-current/10 opacity-75">
              <span className="opacity-60">→ </span>
              {event.result}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function AssistantMessageRow({
  event,
}: {
  event: Extract<PlaygroundTimelineEvent, { kind: 'assistant_message' }>;
}) {
  return (
    <li className="relative pl-7">
      <TimelineDot accent="bg-emerald-400" />
      <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <Bot size={11} className="text-emerald-300" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-300">
            IA respondeu
          </span>
          <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">
            {formatClock(event.ts)}
          </span>
        </div>
        <div className="text-[12px] text-zinc-200 leading-snug whitespace-pre-wrap break-words">
          {event.content}
        </div>
      </div>
    </li>
  );
}

function TimelineLoadingRow() {
  return (
    <li className="relative pl-7">
      <span className="absolute left-[7px] top-2.5 w-[10px] h-[10px] rounded-full ring-2 ring-zinc-950 bg-violet-500 animate-pulse z-10" />
      <div className="rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-2 flex items-center gap-2">
        <Loader2 size={11} className="text-violet-300 animate-spin" />
        <span className="text-[11px] text-violet-200">IA pensando…</span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// MetricChip — bloquinhos do header da timeline.
// ---------------------------------------------------------------------------

function MetricChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: 'violet' | 'emerald' | 'sky' | 'amber';
}) {
  const cls: Record<typeof accent, string> = {
    violet: 'border-violet-500/20 bg-violet-500/5 text-violet-200',
    emerald: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200',
    sky: 'border-sky-500/20 bg-sky-500/5 text-sky-200',
    amber: 'border-amber-500/20 bg-amber-500/5 text-amber-200',
  };
  return (
    <div className={clsx('rounded-md border px-2 py-1', cls[accent])}>
      <div className="text-[9px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-[11px] font-mono truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

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
