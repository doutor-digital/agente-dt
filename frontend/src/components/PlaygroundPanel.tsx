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
//   - Bolhas estilo WhatsApp à esquerda (IA) e à direita (eu, simulando o lead)
//   - Indicador "digitando…" enquanto espera resposta
//   - Painel lateral à direita com as ações que a IA TOMARIA no Kommo real
//   - Botão pra resetar o histórico
//
// Estado vive em useState — recarregar a página apaga tudo (que é o desejado).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  TestTube2,
  User,
  Wrench,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';

type ChatMessage = { role: 'user' | 'assistant'; content: string; ts: number };
type Action = { tool: string; args: Record<string, unknown>; result: string; ts: number };

const TOOL_META: Record<
  string,
  { label: string; emoji: string; color: string }
> = {
  aplicar_tag: { label: 'Tag aplicada', emoji: '🏷️', color: 'amber' },
  mover_etapa: { label: 'Etapa movida', emoji: '🔀', color: 'sky' },
  pausar_ia: { label: 'IA pausada', emoji: '⏸️', color: 'rose' },
  atualizar_titulo_lead: { label: 'Título atualizado', emoji: '🪪', color: 'fuchsia' },
};

const SUGGESTIONS: string[] = [
  '👋 Oi, tudo bem?',
  '💸 Quanto custa a consulta?',
  '⏰ Vocês atendem sábado?',
  '🙋 Sou a Maria, prazer!',
  '🆘 Quero falar com um atendente',
  '👀 Vi vocês no Instagram',
];

export function PlaygroundPanel() {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll quando chegam mensagens novas.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // Reset quando troca de unidade.
  useEffect(() => {
    setMessages([]);
    setActions([]);
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
      const { reply, actions: newActions } = await api.playgroundRun(
        selectedUnitId,
        nextHistory.map((m) => ({ role: m.role, content: m.content })),
      );

      setMessages([...nextHistory, { role: 'assistant', content: reply, ts: Date.now() }]);
      if (newActions.length > 0) {
        const now = Date.now();
        setActions((prev) => [
          ...prev,
          ...newActions.map((a) => ({ ...a, ts: now })),
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha no playground: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setActions([]);
    setInput('');
  }

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra testar a IA.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Coluna esquerda — chat */}
      <div className="flex-1 flex flex-col overflow-hidden border-r border-zinc-800/60">
        {/* Header sticky */}
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
                Converse como se fosse um lead. Nada vai pro Kommo nem pro banco — só pra ver
                como a IA reagiria com a configuração atual da Unidade. ✨
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              disabled={messages.length === 0 && actions.length === 0}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60 disabled:opacity-40 disabled:hover:bg-transparent"
              title="Reiniciar conversa"
            >
              <RotateCcw size={13} />
              Resetar
            </button>
          </div>
        </div>

        {/* Lista de mensagens */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center py-10">
              <div className="text-4xl mb-2">💬</div>
              <p className="text-sm text-zinc-400 mb-1 font-medium">
                Comece uma conversa
              </p>
              <p className="text-xs text-zinc-600 max-w-sm mx-auto">
                Digite uma mensagem como se fosse um lead falando com a IA pelo WhatsApp.
                As ações que a IA tomaria aparecem no painel à direita. 👉
              </p>
              <div className="flex flex-wrap gap-1.5 justify-center mt-5 max-w-md mx-auto">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="text-[11px] px-2.5 py-1 rounded-full bg-zinc-900/80 ring-1 ring-zinc-800 text-zinc-300 hover:text-zinc-100 hover:ring-emerald-500/40 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <Bubble key={i} message={m} />
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 pl-1">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:0.3s]" />
              </div>
              <span>IA pensando…</span>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-zinc-800/60 p-3 bg-zinc-950/60">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder="Digite como se fosse o lead…  (Enter envia, Shift+Enter quebra linha) ✍️"
              className="flex-1 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-950 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 resize-none max-h-32"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={!canSend}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shadow-lg shadow-emerald-500/20"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Enviar
            </button>
          </form>
        </div>
      </div>

      {/* Coluna direita — ações da IA */}
      <aside className="w-80 shrink-0 overflow-y-auto bg-zinc-950/60 px-4 py-4">
        <div className="flex items-center gap-2 mb-3">
          <Wrench size={14} className="text-amber-300" />
          <h2 className="text-sm font-semibold text-zinc-100">Ações da IA</h2>
          <span className="text-[10px] text-zinc-500">{actions.length}</span>
        </div>
        <p className="text-[11px] text-zinc-500 mb-3 leading-relaxed">
          Cada chamada de tool que a IA faria no Kommo aparece aqui. Em sandbox elas são só
          simuladas — útil pra ver se ela aplicou a tag certa, perguntou o nome, etc. 👇
        </p>
        {actions.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-zinc-800 rounded-lg">
            <Sparkles size={20} className="text-zinc-700 mx-auto mb-2" />
            <p className="text-[11px] text-zinc-600">
              Nenhuma ação ainda. Mande uma mensagem que dispare uma decisão (ex: dizer o
              nome, mostrar interesse, pedir um humano).
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {actions.map((a, i) => (
              <ActionCard key={i} action={a} />
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={clsx(
          'max-w-[75%] rounded-2xl px-3 py-2 shadow-sm flex gap-2',
          isUser
            ? 'bg-emerald-600/90 text-white rounded-br-md'
            : 'bg-zinc-900/80 ring-1 ring-zinc-800 text-zinc-100 rounded-bl-md',
        )}
      >
        {!isUser && (
          <span className="text-base shrink-0" title="IA">
            🤖
          </span>
        )}
        <div className="text-sm leading-snug whitespace-pre-wrap break-words">
          {message.content}
        </div>
        {isUser && (
          <User size={14} className="text-emerald-100/80 mt-0.5 shrink-0" />
        )}
      </div>
    </div>
  );
}

function ActionCard({ action }: { action: Action }) {
  const meta = TOOL_META[action.tool] ?? {
    label: action.tool,
    emoji: '⚙️',
    color: 'zinc',
  };
  const colorClass: Record<string, string> = {
    amber: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
    sky: 'bg-sky-500/10 border-sky-500/30 text-sky-200',
    rose: 'bg-rose-500/10 border-rose-500/30 text-rose-200',
    fuchsia: 'bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-200',
    zinc: 'bg-zinc-900 border-zinc-800 text-zinc-300',
  };
  return (
    <li
      className={clsx(
        'rounded-lg border px-3 py-2',
        colorClass[meta.color] ?? colorClass.zinc,
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{meta.emoji}</span>
        <span className="text-xs font-semibold">{meta.label}</span>
        <code className="ml-auto text-[9px] font-mono opacity-60">{action.tool}</code>
      </div>
      <div className="text-[11px] font-mono leading-relaxed opacity-90 break-all">
        {Object.entries(action.args)
          .filter(([k]) => k !== 'leadId')
          .map(([k, v]) => (
            <div key={k}>
              <span className="opacity-60">{k}=</span>
              {JSON.stringify(v)}
            </div>
          ))}
      </div>
    </li>
  );
}

