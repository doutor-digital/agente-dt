// ============================================================================
// ConversationsPanel — visão "WhatsApp" agrupada por lead.
//
// Lista à esquerda (conversas ordenadas por última mensagem), histórico
// completo no centro. Cada mensagem da IA mostra link pro feed do trace.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, MessageCircle, Phone, User2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
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
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {detail.messages.map((m) => (
                <MessageBubble key={m.id} m={m} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: ConversationMessage }) {
  const isUser = m.role === 'user';
  return (
    <div className={clsx('flex', isUser ? 'justify-start' : 'justify-end')}>
      <div
        className={clsx(
          'max-w-[70%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap',
          isUser
            ? 'bg-zinc-900 ring-1 ring-zinc-800 text-zinc-100'
            : 'bg-brand-500/15 ring-1 ring-brand-500/30 text-brand-100',
        )}
      >
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 mb-1">
          {isUser ? <User2 size={10} /> : <Bot size={10} />}
          <span>{isUser ? 'Paciente' : 'IA'}</span>
          <span>·</span>
          <span>{new Date(m.createdAt).toLocaleString('pt-BR')}</span>
        </div>
        <div>{m.content}</div>
      </div>
    </div>
  );
}
