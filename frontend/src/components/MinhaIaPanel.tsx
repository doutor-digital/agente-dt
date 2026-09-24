import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CalendarCheck,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Pause,
  Play,
  User2,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { usePolling } from '../hooks/usePolling';
import type { ConversationDetail, PausaEstado } from '../types/api';

/**
 * A tela da UNIDADE (papel UNIT_ADMIN). O painel completo é do operador; aqui o
 * franqueado precisa de quatro respostas e nada mais:
 *   1. minha IA está no ar?  2. o que ela fez?  3. o que ela falou?  4. onde travou?
 *
 * Nada de configuração, prompt, custo ou ferramenta — quem mexe nisso é a Doutor Digital.
 */

const DIAS = 30;

function quando(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`;
  const d = Math.floor(diff / 86_400_000);
  return d === 1 ? 'ontem' : `há ${d} dias`;
}

function fimDoDia(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

function amanhaDeManha(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

function Cartao({
  titulo,
  valor,
  detalhe,
  icone,
  destaque,
}: {
  titulo: string;
  valor: string | number;
  detalhe?: string;
  icone: React.ReactNode;
  destaque?: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded-xl border p-4 flex flex-col gap-1',
        destaque ? 'border-emerald-700/50 bg-emerald-950/30' : 'border-zinc-800 bg-zinc-900/60',
      )}
    >
      <div className="flex items-center gap-2 text-zinc-400 text-xs uppercase tracking-wide">
        {icone}
        {titulo}
      </div>
      <div className="text-3xl font-semibold tabular-nums text-zinc-100">{valor}</div>
      {detalhe && <div className="text-xs text-zinc-500">{detalhe}</div>}
    </div>
  );
}

export function MinhaIaPanel() {
  const { selectedUnitId } = useUnit();
  const { user, logout } = useAuth();
  const toast = useToast();

  const painel = useMemo(
    () => () => (selectedUnitId ? api.unitDashboard(selectedUnitId, DIAS) : Promise.resolve(null)),
    [selectedUnitId],
  );
  const { data: dash, loading: carregandoPainel } = usePolling(painel, 60_000, [selectedUnitId]);

  const pausa = useMemo(
    () => () => (selectedUnitId ? api.pausaEstado(selectedUnitId) : Promise.resolve(null)),
    [selectedUnitId],
  );
  const { data: estadoPausa } = usePolling(pausa, 30_000, [selectedUnitId]);

  const conversas = useMemo(
    () => () => api.listConversations(selectedUnitId),
    [selectedUnitId],
  );
  const { data: listaConversas } = usePolling(conversas, 15_000, [selectedUnitId]);

  const [abertaId, setAbertaId] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<ConversationDetail | null>(null);
  const [mexendoNaPausa, setMexendoNaPausa] = useState(false);

  useEffect(() => {
    if (!abertaId) {
      setDetalhe(null);
      return;
    }
    let vivo = true;
    api
      .getConversation(abertaId)
      .then((c) => vivo && setDetalhe(c))
      .catch(() => vivo && setDetalhe(null));
    return () => {
      vivo = false;
    };
  }, [abertaId]);

  async function mudarPausa(acao: 'hoje' | 'amanha' | 'retomar') {
    if (!selectedUnitId) return;
    setMexendoNaPausa(true);
    try {
      let r: PausaEstado;
      if (acao === 'retomar') r = await api.retomar(selectedUnitId);
      else r = await api.pausar(selectedUnitId, acao === 'hoje' ? fimDoDia() : amanhaDeManha());
      toast.success(r.emPausa ? 'IA pausada.' : 'IA de volta ao ar.');
    } catch {
      toast.error('Não consegui mudar agora. Tente de novo em instantes.');
    } finally {
      setMexendoNaPausa(false);
    }
  }

  const k = dash?.kpis;
  const noAr = estadoPausa ? !estadoPausa.emPausa : true;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Sua assistente</h1>
          <p className="text-sm text-zinc-500">
            {estadoPausa?.unidade ?? 'Carregando…'} · últimos {DIAS} dias
          </p>
        </div>
        <button
          onClick={() => void logout()}
          className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-4"
        >
          sair ({user?.email})
        </button>
      </header>

      {/* 1. está no ar? */}
      <section
        className={clsx(
          'rounded-xl border p-5 flex flex-wrap items-center justify-between gap-4',
          noAr ? 'border-emerald-700/50 bg-emerald-950/25' : 'border-amber-700/50 bg-amber-950/25',
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={clsx(
              'h-3.5 w-3.5 rounded-full',
              noAr ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400',
            )}
          />
          <div>
            <div className="text-lg font-semibold text-zinc-100">
              {noAr ? 'No ar, atendendo' : 'Pausada'}
            </div>
            <div className="text-sm text-zinc-400">
              {estadoPausa?.descricao ?? 'Respondendo os pacientes no WhatsApp.'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {noAr ? (
            <>
              <button
                disabled={mexendoNaPausa}
                onClick={() => void mudarPausa('hoje')}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-amber-600 hover:bg-amber-950/40 disabled:opacity-50"
              >
                <Pause size={15} /> Pausar até o fim do dia
              </button>
              <button
                disabled={mexendoNaPausa}
                onClick={() => void mudarPausa('amanha')}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-amber-600 hover:bg-amber-950/40 disabled:opacity-50"
              >
                <Pause size={15} /> Até amanhã de manhã
              </button>
            </>
          ) : (
            <button
              disabled={mexendoNaPausa}
              onClick={() => void mudarPausa('retomar')}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <Play size={15} /> Voltar ao ar agora
            </button>
          )}
        </div>
      </section>

      {/* 2. o que ela fez */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          O que ela fez
        </h2>
        {carregandoPainel && !k ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 size={15} className="animate-spin" /> carregando…
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Cartao
              titulo="Pessoas atendidas"
              valor={k?.uniqueLeads ?? 0}
              detalhe={`${k?.answeredConversations ?? 0} conversas respondidas`}
              icone={<MessageCircle size={13} />}
            />
            <Cartao
              titulo="Consultas marcadas"
              valor={k?.aiScheduledConsults ?? 0}
              detalhe="pela assistente"
              icone={<CalendarCheck size={13} />}
              destaque
            />
            <Cartao
              titulo="Compareceram"
              valor={k?.aiCompareceu ?? 0}
              detalhe="confirmado pela clínica"
              icone={<CheckCircle2 size={13} />}
            />
            <Cartao
              titulo="Fecharam tratamento"
              valor={k?.aiFechouTratamento ?? 0}
              detalhe={
                k?.aiAindaNoFuturo ? `${k.aiAindaNoFuturo} com consulta ainda por vir` : undefined
              }
              icone={<CheckCircle2 size={13} />}
            />
          </div>
        )}
      </section>

      {/* 4. onde travou (antes das conversas: é o que pede ação) */}
      {dash && (dash.hotQueue.length > 0 || (k?.unansweredQuestions ?? 0) > 0) && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Precisa de gente
          </h2>
          <div className="rounded-xl border border-amber-800/40 bg-amber-950/15 divide-y divide-amber-900/30">
            {dash.hotQueue.slice(0, 8).map((h) => (
              <div key={h.leadId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-100">
                    {h.contactName || h.phone || `Lead ${h.leadId}`}
                  </div>
                  <div className="text-xs text-zinc-500">
                    aguardando há{' '}
                    {h.waitingMinutes < 60
                      ? `${h.waitingMinutes} min`
                      : `${Math.floor(h.waitingMinutes / 60)} h`}
                    {h.reactivations > 0 && ` · ${h.reactivations} tentativa(s) de retomar`}
                  </div>
                </div>
                <AlertTriangle size={16} className="shrink-0 text-amber-500" />
              </div>
            ))}
            {dash.hotQueue.length === 0 && (
              <div className="px-4 py-3 text-sm text-zinc-400">
                Ninguém esperando. {k?.unansweredQuestions} pergunta(s) que a assistente não soube
                responder no período — a Doutor Digital revisa e ensina.
              </div>
            )}
          </div>
        </section>
      )}

      {/* 3. o que ela falou */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          O que ela falou
        </h2>
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 divide-y divide-zinc-800 max-h-[460px] overflow-auto">
            {(listaConversas ?? []).slice(0, 40).map((c) => (
              <button
                key={c.id}
                onClick={() => setAbertaId(c.id)}
                className={clsx(
                  'w-full text-left px-4 py-3 hover:bg-zinc-800/60',
                  abertaId === c.id && 'bg-zinc-800',
                )}
              >
                <div className="truncate text-sm font-medium text-zinc-100">
                  {c.contactName || c.phone || 'Sem nome'}
                </div>
                <div className="text-xs text-zinc-500">
                  {quando(c.lastMessageAt)} · {c._count.messages} mensagens
                </div>
              </button>
            ))}
            {(listaConversas ?? []).length === 0 && (
              <div className="px-4 py-6 text-sm text-zinc-500">Nenhuma conversa ainda.</div>
            )}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 max-h-[460px] overflow-auto">
            {!abertaId && (
              <p className="text-sm text-zinc-500">
                Escolha uma conversa à esquerda para ler o que a assistente respondeu.
              </p>
            )}
            {abertaId && !detalhe && (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 size={15} className="animate-spin" /> abrindo…
              </div>
            )}
            {detalhe && (
              <div className="space-y-3">
                {detalhe.messages
                  .filter((m) => m.role !== 'system')
                  .map((m) => (
                    <div
                      key={m.id}
                      className={clsx(
                        'flex gap-2',
                        m.role === 'assistant' ? 'justify-end' : 'justify-start',
                      )}
                    >
                      {m.role === 'user' && <User2 size={15} className="mt-1 shrink-0 text-zinc-500" />}
                      <div
                        className={clsx(
                          'max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap',
                          m.role === 'assistant'
                            ? 'bg-emerald-900/40 text-emerald-50'
                            : 'bg-zinc-800 text-zinc-100',
                        )}
                      >
                        {m.content}
                      </div>
                      {m.role === 'assistant' && (
                        <Bot size={15} className="mt-1 shrink-0 text-emerald-500" />
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
