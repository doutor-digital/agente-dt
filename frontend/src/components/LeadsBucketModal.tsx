// ============================================================================
// LeadsBucketModal — drill-down clicável dos KPIs do Dashboard.
//
// Abre quando o usuário clica num KPI (não respondido / FDS / handoff /
// convertido IA / convertido SDR) e lista os leads/conversas que compõem
// aquele número. Cada linha leva pra aba Conversas com a conversa aberta.
//
// API: GET /units/:id/leads-bucket?bucket=<X>&days=<N>
// ============================================================================

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { api } from '../lib/api';
import type { LeadsBucket, LeadsBucketItem } from '../types/api';

const TITLES: Record<LeadsBucket, { title: string; sub: string }> = {
  unanswered: { title: 'Leads não respondidos', sub: 'Mensagens do paciente sem resposta da IA em 60min.' },
  weekend_leads: { title: 'Leads do fim de semana', sub: 'Pacientes que chegaram em sábado ou domingo.' },
  weekend_conversations: {
    title: 'Conversas com mensagens em FDS',
    sub: 'Conversas com qualquer interação em sábado/domingo.',
  },
  handoff: { title: 'Transferidos pra humano', sub: 'Conversas em que a IA chamou `pausar_ia`.' },
  converted_ia: {
    title: 'Convertidos pela IA',
    sub: 'Conversas que viraram Ganho sem precisar de handoff humano.',
  },
  converted_sdr: {
    title: 'Convertidos pela SDR',
    sub: 'Conversas que tiveram handoff antes de virarem Ganho — humano fechou.',
  },
};

export function LeadsBucketModal({
  unitId,
  bucket,
  days,
  onClose,
}: {
  unitId: string;
  bucket: LeadsBucket;
  days: number;
  onClose: () => void;
}) {
  const [items, setItems] = useState<LeadsBucketItem[] | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .leadsBucket(unitId, bucket, days)
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
        setCount(r.count);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        setError(e?.response?.data?.error ?? e?.message ?? 'erro');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [unitId, bucket, days]);

  const meta = TITLES[bucket];

  function openConversation(conversationId: string) {
    // Sinal pro App trocar de aba e a ConversationsPanel selecionar a conversa.
    window.dispatchEvent(
      new CustomEvent('app:openConversation', { detail: { conversationId } }),
    );
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-zinc-950 ring-1 ring-zinc-800 rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-zinc-100">{meta.title}</div>
            <div className="text-xs text-zinc-500 mt-1">{meta.sub}</div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-600 mt-2">
              Últimos {days} dias · {count} resultado{count === 1 ? '' : 's'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-900"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-8 text-center text-zinc-500">
              <Loader2 className="animate-spin mx-auto" size={20} />
            </div>
          )}
          {error && (
            <div className="m-4 rounded-md bg-rose-500/10 ring-1 ring-rose-500/30 px-4 py-3 text-xs text-rose-200">
              {error}
            </div>
          )}
          {!loading && !error && items && items.length === 0 && (
            <div className="p-8 text-center text-xs text-zinc-500">Nenhum resultado.</div>
          )}
          {!loading && items && items.length > 0 && (
            <ul className="divide-y divide-zinc-800/60">
              {items.map((it) => (
                <li key={`${it.conversationId}-${it.lastMessageAt}`}>
                  <button
                    type="button"
                    onClick={() => openConversation(it.conversationId)}
                    className="w-full text-left px-5 py-3 hover:bg-zinc-900/60 transition flex items-start gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-100 font-medium truncate">
                        {it.contactName ?? `Lead #${it.leadId}`}
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate">
                        {it.phone ? `${it.phone} · ` : ''}lead {it.leadId}
                      </div>
                      {it.hint && (
                        <div className="text-[11px] text-zinc-600 mt-1 italic truncate">{it.hint}</div>
                      )}
                    </div>
                    <div className="text-right text-[10px] uppercase tracking-wider text-zinc-600 shrink-0">
                      <div>{formatDate(it.convertedAt ?? it.lastMessageAt)}</div>
                      {it.convertedAt && <div className="text-emerald-400 mt-0.5">convertido</div>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 text-[10px] text-zinc-600">
          Clique numa linha pra abrir a conversa.
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
