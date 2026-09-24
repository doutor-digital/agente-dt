import { useEffect, useMemo, useState } from 'react';
import { Loader2, LogOut, Pause, Play, ThumbsDown } from 'lucide-react';
import Lottie from 'lottie-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { usePolling } from '../hooks/usePolling';
import type { ConversationDetail, PausaEstado } from '../types/api';
import { Funil } from './unidade/Funil';
import { ESTILOS } from './unidade/estilos';
import { useAoAparecer, useContagem, semMovimento } from './unidade/animacoes';
import pulso from './unidade/pulso.lottie.json';

/**
 * A TELA DA UNIDADE (papel UNIT_ADMIN).
 *
 * O console é do operador. Aqui quem lê é o dono de uma clínica de coluna, que não
 * abre CRM e tem meio minuto. A tela responde uma pergunta — a Sofia está trazendo
 * paciente? — e uma segunda que ninguém faz em voz alta: onde está escapando dinheiro?
 *
 * Fora de propósito: configuração, prompt, ferramenta e custo. Quem mexe nisso é a
 * Doutor Digital; tela que o cliente pode configurar vira chamado.
 */

const DIAS = 30;

function reais(n: number): string {
  if (n >= 1000) return `R$ ${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')} mil`;
  return `R$ ${n}`;
}

function quando(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h`;
  const d = Math.floor(diff / 86_400_000);
  return d === 1 ? 'ontem' : `${d} dias`;
}

function espera(min: number): string {
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`;
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

/** Bloco que entra em cascata quando aparece na tela. */
function Bloco({
  children,
  atraso = 0,
  className,
}: {
  children: React.ReactNode;
  atraso?: number;
  className?: string;
}) {
  const { ref, visivel } = useAoAparecer<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={clsx('entra', visivel && 'dentro', className)}
      style={{ animationDelay: `${atraso}ms` }}
    >
      {children}
    </div>
  );
}

function Delta({ agora, antes }: { agora: number; antes: number | null | undefined }) {
  if (antes == null || antes === 0) return null;
  const p = Math.round(((agora - antes) / antes) * 100);
  if (p === 0)
    return <span className="text-[11.5px] text-[var(--bruma)]">igual ao mês passado</span>;
  const subiu = p > 0;
  return (
    <span
      className={clsx(
        'text-[11.5px] font-bold tabular-nums',
        subiu ? 'text-[var(--carne)]' : 'text-[var(--alerta)]',
      )}
    >
      {subiu ? '▲' : '▼'} {Math.abs(p)}% vs. mês passado
    </span>
  );
}

function Numero({ valor, className }: { valor: number; className?: string }) {
  const n = useContagem(valor);
  return <span className={clsx('tabular-nums', className)}>{n}</span>;
}

function Cartao({
  valor,
  rotulo,
  rodape,
  cor,
  atraso,
}: {
  valor: number;
  rotulo: string;
  rodape?: React.ReactNode;
  cor?: string;
  atraso: number;
}) {
  return (
    <Bloco atraso={atraso} className="h-full">
      <div className="cartao viva h-full px-5 py-[18px]">
        <Numero
          valor={valor}
          className={clsx('font-display block text-[46px] font-bold leading-[.95]', cor)}
        />
        <div className="mt-2 text-[12.5px] leading-snug text-[var(--bruma)]">{rotulo}</div>
        {rodape && <div className="mt-1.5">{rodape}</div>}
      </div>
    </Bloco>
  );
}

/** As 24 horas do dia — responde "preciso de gente à noite?" sem ninguém perguntar. */
function Horas({ horas }: { horas: number[] }) {
  const topo = Math.max(...horas, 1);
  const pico = horas.indexOf(topo);
  const total = horas.reduce((s, q) => s + q, 0);
  const fora = horas.reduce((s, q, h) => (h < 8 || h >= 18 ? s + q : s), 0);
  const pct = total > 0 ? Math.round((fora / total) * 100) : 0;

  return (
    <div>
      <div className="flex h-[76px] items-end gap-[3px]">
        {horas.map((q, h) => (
          <div
            key={h}
            title={`${h}h — ${q} mensagem(ns)`}
            className={clsx(
              'barra flex-1 rounded-t-[3px]',
              h === pico
                ? 'bg-[var(--osso)]'
                : h < 8 || h >= 18
                  ? 'bg-[var(--vida)]/40'
                  : 'bg-[var(--vida)]',
            )}
            style={{ height: `${Math.max(4, (q / topo) * 100)}%`, animationDelay: `${h * 22}ms` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10.5px] text-[var(--bruma)]">
        <span>0h</span>
        <span>6h</span>
        <span>12h</span>
        <span>18h</span>
        <span>23h</span>
      </div>
      {total > 0 && (
        <p className="mt-3.5 text-[12.5px] leading-snug text-[var(--bruma)]">
          Pico às <strong className="text-[var(--osso)]">{pico}h</strong>. {pct}% das mensagens
          chegam fora do expediente —{' '}
          {pct >= 25
            ? 'é aí que ela paga o próprio custo.'
            : 'a maior parte cai no horário da equipe.'}
        </p>
      )}
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
  const { data: dash, loading } = usePolling(painel, 60_000, [selectedUnitId]);

  const extra = useMemo(
    () => () => (selectedUnitId ? api.painelUnidade(selectedUnitId, DIAS) : Promise.resolve(null)),
    [selectedUnitId],
  );
  const { data: mais } = usePolling(extra, 120_000, [selectedUnitId]);

  const pausa = useMemo(
    () => () => (selectedUnitId ? api.pausaEstado(selectedUnitId) : Promise.resolve(null)),
    [selectedUnitId],
  );
  const { data: estadoPausa } = usePolling(pausa, 30_000, [selectedUnitId]);

  const conversas = useMemo(() => () => api.listConversations(selectedUnitId), [selectedUnitId]);
  const { data: listaConversas } = usePolling(conversas, 15_000, [selectedUnitId]);

  const [abertaId, setAbertaId] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<ConversationDetail | null>(null);
  const [mexendo, setMexendo] = useState(false);
  const [marcadas, setMarcadas] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!abertaId && listaConversas && listaConversas.length > 0) setAbertaId(listaConversas[0].id);
  }, [listaConversas, abertaId]);

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

  /**
   * "Isso está errado" numa resposta da Sofia. Não é desabafo: a mensagem marcada
   * entra no prompt dela como exemplo a evitar. O dono está ensinando a IA dele.
   */
  async function marcarErrada(id: string, atual: boolean) {
    const novo = !atual;
    setMarcadas((m) => ({ ...m, [id]: novo }));
    try {
      await api.flagMessage(id, novo);
      toast.success(novo ? 'Anotado. Ela aprende a não responder assim.' : 'Marca removida.');
    } catch {
      setMarcadas((m) => ({ ...m, [id]: atual }));
      toast.error('Não consegui marcar agora.');
    }
  }

  async function mudarPausa(acao: 'hoje' | 'amanha' | 'retomar') {
    if (!selectedUnitId) return;
    setMexendo(true);
    try {
      const r: PausaEstado =
        acao === 'retomar'
          ? await api.retomar(selectedUnitId)
          : await api.pausar(selectedUnitId, acao === 'hoje' ? fimDoDia() : amanhaDeManha());
      toast.success(r.emPausa ? 'Sofia pausada.' : 'Sofia de volta ao ar.');
    } catch {
      toast.error('Não consegui mudar agora. Tente de novo em instantes.');
    } finally {
      setMexendo(false);
    }
  }

  const k = dash?.kpis;
  const viva = estadoPausa ? !estadoPausa.emPausa : true;
  const naMesa = mais?.naMesa ?? [];
  const valorNaMesa = naMesa.length * (mais?.ticketEstimadoBrl ?? 0);

  const passos = [
    { rotulo: 'chegaram', valor: k?.uniqueLeads ?? 0 },
    { rotulo: 'ela conversou', valor: k?.answeredConversations ?? 0 },
    { rotulo: 'marcaram consulta', valor: k?.aiScheduledConsults ?? 0 },
    { rotulo: 'compareceram', valor: k?.aiCompareceu ?? 0, bom: true },
    { rotulo: 'fecharam tratamento', valor: k?.aiFechouTratamento ?? 0, bom: true },
  ];

  return (
    <div className="tela-unidade">
      <style>{ESTILOS}</style>

      <div className="mx-auto w-full max-w-[1520px] px-5 pb-14 pt-5 lg:px-8">
        <Bloco>
          <header className="cartao mb-4 flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
            <div className="flex items-center gap-3.5">
              <div className="h-11 w-11 shrink-0">
                {semMovimento() ? (
                  <span className="block h-2.5 w-2.5 translate-x-4 translate-y-4 rounded-full bg-[var(--vida)]" />
                ) : (
                  <Lottie animationData={pulso} loop={viva} autoplay={viva} />
                )}
              </div>
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[var(--bruma)]">
                  {estadoPausa?.unidade ?? '—'}
                </div>
                <div className="font-display text-[22px] font-bold leading-tight">Sofia</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <span
                className={clsx(
                  'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11.5px] font-bold uppercase tracking-[0.07em]',
                  viva
                    ? 'bg-[var(--vida)]/15 text-[var(--vida)]'
                    : 'bg-[var(--alerta)]/15 text-[var(--alerta)]',
                )}
              >
                {viva ? 'no ar' : 'pausada'}
              </span>
              <span className="mr-1 hidden text-[12px] text-[var(--bruma)] sm:inline">
                {viva
                  ? 'respondendo no WhatsApp'
                  : (estadoPausa?.descricao ?? 'ninguém está sendo respondido')}
              </span>
              {viva ? (
                <>
                  <button
                    disabled={mexendo}
                    onClick={() => void mudarPausa('hoje')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--linha)] bg-white/[0.03] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--bruma)] transition hover:border-[var(--alerta)]/50 hover:text-[var(--osso)] disabled:opacity-40"
                  >
                    <Pause size={13} /> pausar hoje
                  </button>
                  <button
                    disabled={mexendo}
                    onClick={() => void mudarPausa('amanha')}
                    className="rounded-lg border border-[var(--linha)] bg-white/[0.03] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--bruma)] transition hover:border-[var(--alerta)]/50 hover:text-[var(--osso)] disabled:opacity-40"
                  >
                    até amanhã
                  </button>
                </>
              ) : (
                <button
                  disabled={mexendo}
                  onClick={() => void mudarPausa('retomar')}
                  className="inline-flex items-center gap-2 rounded-lg bg-[var(--vida)] px-4 py-2 text-[13px] font-bold text-[#06101f] transition hover:brightness-110 disabled:opacity-40"
                >
                  <Play size={14} /> voltar ao ar
                </button>
              )}
              <button
                onClick={() => void logout()}
                title={user?.email ?? undefined}
                className="rounded-lg p-2 text-[var(--bruma)] transition hover:text-[var(--osso)]"
              >
                <LogOut size={15} />
              </button>
            </div>
          </header>
        </Bloco>

        {loading && !k ? (
          <div className="mb-4 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="osso h-[126px]" />
            ))}
          </div>
        ) : (
          <div className="mb-4 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            <Cartao
              atraso={60}
              valor={k?.uniqueLeads ?? 0}
              rotulo="pessoas chegaram no WhatsApp"
              rodape={<Delta agora={k?.uniqueLeads ?? 0} antes={mais?.anterior?.chegaram} />}
            />
            <Cartao
              atraso={120}
              valor={k?.aiScheduledConsults ?? 0}
              rotulo="marcaram consulta com ela"
              rodape={
                (k?.aiAindaNoFuturo ?? 0) > 0 ? (
                  <span className="text-[11.5px] text-[var(--bruma)]">
                    {k?.aiAindaNoFuturo} ainda por acontecer
                  </span>
                ) : null
              }
            />
            <Cartao
              atraso={180}
              valor={k?.aiCompareceu ?? 0}
              rotulo="compareceram na clínica"
              cor="text-[var(--carne)]"
              rodape={
                <span className="text-[11.5px] text-[var(--bruma)]">
                  {k?.aiFechouTratamento ?? 0} fecharam tratamento
                </span>
              }
            />
            <Bloco atraso={240} className="h-full">
              <div className={clsx('cartao viva h-full px-5 py-[18px]', naMesa.length > 0 && 'brilho')}>
                <span className="font-display block text-[38px] font-bold leading-[.95] text-[var(--alerta)]">
                  {naMesa.length > 0 ? reais(valorNaMesa) : 'R$ 0'}
                </span>
                <div className="mt-2 text-[12.5px] leading-snug text-[var(--bruma)]">
                  {naMesa.length > 0
                    ? `parados na mesa — ${naMesa.length} ${naMesa.length === 1 ? 'avaliou' : 'avaliaram'} e não ${naMesa.length === 1 ? 'fechou' : 'fecharam'}`
                    : 'ninguém avaliou sem fechar'}
                </div>
                {naMesa.length > 0 && (
                  <div className="mt-1.5 truncate text-[11.5px] text-[var(--osso)]">
                    {naMesa
                      .slice(0, 3)
                      .map((p) => p.nome.split(' ')[0])
                      .join(' · ')}
                    {naMesa.length > 3 && ` +${naMesa.length - 3}`}
                  </div>
                )}
              </div>
            </Bloco>
          </div>
        )}

        <Bloco atraso={300}>
          <section className="cartao mb-4 px-6 pb-5 pt-5">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-[16px] font-bold">
                Do primeiro “oi” até o tratamento
              </h2>
              <span className="text-[12px] text-[var(--bruma)]">
                últimos {DIAS} dias · em vermelho, onde mais escapa
              </span>
            </div>
            <Funil passos={passos} />
          </section>
        </Bloco>

        <div className="mb-4 grid gap-3.5 lg:grid-cols-2">
          <Bloco atraso={360} className="h-full">
            <section className="cartao viva h-full px-5 py-[18px]">
              <h2 className="font-display text-[16px] font-bold">Sumindo do tratamento</h2>
              <p className="mb-3 mt-1 text-[12.5px] leading-snug text-[var(--bruma)]">
                Já pagaram e estão faltando às sessões seguidas. Uma ligação ainda traz de volta.
              </p>
              {(mais?.sumindo.length ?? 0) === 0 ? (
                <p className="py-4 text-[13px] text-[var(--bruma)]">
                  Ninguém sumindo agora — todo mundo em tratamento está comparecendo.
                </p>
              ) : (
                <div>
                  {mais!.sumindo.slice(0, 6).map((p) => (
                    <div
                      key={p.nome}
                      className="toque flex items-center gap-3 rounded-lg border-b border-white/[0.05] px-1.5 py-2.5 last:border-b-0"
                    >
                      <span className="font-display w-7 shrink-0 text-center text-[19px] font-bold leading-none text-[var(--alerta)] tabular-nums">
                        {p.faltasSeguidas}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold">{p.nome}</div>
                        <div className="text-[11.5px] text-[var(--bruma)]">
                          faltas seguidas · fez {p.feitas} de {p.total} sessões
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </Bloco>

          <Bloco atraso={420} className="h-full">
            <section className="cartao viva h-full px-5 py-[18px]">
              <h2 className="font-display mb-3 text-[16px] font-bold">A que horas eles chamam</h2>
              {mais ? <Horas horas={mais.porHora} /> : <div className="osso h-[76px]" />}
            </section>
          </Bloco>
        </div>

        {(dash?.hotQueue.length ?? 0) > 0 && (
          <Bloco atraso={470}>
            <section className="cartao mb-4 px-5 py-[18px]">
              <h2 className="font-display mb-3 text-[16px] font-bold">
                Esperando alguém da equipe{' '}
                <span className="text-[var(--alerta)]">({dash!.hotQueue.length})</span>
              </h2>
              <div className="flex flex-wrap gap-2">
                {dash!.hotQueue.slice(0, 10).map((h) => (
                  <span
                    key={h.leadId}
                    className="inline-flex items-center gap-2 rounded-full border border-[var(--alerta)]/30 bg-[var(--alerta)]/[0.07] px-3 py-1.5 text-[12.5px]"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--alerta)]" />
                    <strong className="font-semibold">
                      {h.contactName || h.phone || `Lead ${h.leadId}`}
                    </strong>
                    <span className="text-[var(--bruma)]">há {espera(h.waitingMinutes)}</span>
                  </span>
                ))}
              </div>
            </section>
          </Bloco>
        )}

        <Bloco atraso={520}>
          <section className="cartao overflow-hidden">
            <div className="px-5 pt-[18px]">
              <h2 className="font-display text-[16px] font-bold">O que ela falou</h2>
              <p className="mb-3 mt-1 text-[12.5px] text-[var(--bruma)]">
                Achou uma resposta ruim? Passe o mouse nela e marque — a Sofia aprende a não
                responder assim.
              </p>
            </div>
            <div className="grid min-h-[260px] border-t border-[var(--linha)] lg:grid-cols-[280px_1fr]">
              <div className="max-h-[340px] overflow-auto border-[var(--linha)] lg:border-r">
                {(listaConversas ?? []).slice(0, 40).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setAbertaId(c.id)}
                    className={clsx(
                      'toque block w-full border-b border-white/[0.05] px-4 py-2.5 text-left last:border-b-0',
                      abertaId === c.id && 'bg-[var(--vida)]/[0.09]',
                    )}
                  >
                    <div className="truncate text-[13px] font-semibold">
                      {c.contactName || c.phone || 'Sem nome'}
                    </div>
                    <div className="text-[11.5px] text-[var(--bruma)]">
                      {quando(c.lastMessageAt)} · {c._count.messages} mensagens
                    </div>
                  </button>
                ))}
                {(listaConversas ?? []).length === 0 && (
                  <p className="px-4 py-6 text-[13px] text-[var(--bruma)]">
                    Nenhuma conversa ainda.
                  </p>
                )}
              </div>

              <div className="max-h-[340px] space-y-2.5 overflow-auto px-5 py-4">
                {abertaId && !detalhe && (
                  <div className="flex items-center gap-2 text-[12.5px] text-[var(--bruma)]">
                    <Loader2 size={13} className="animate-spin" /> abrindo…
                  </div>
                )}
                {detalhe?.messages
                  .filter((m) => m.role !== 'system')
                  .map((m) => (
                    <div
                      key={m.id}
                      className={clsx(
                        'group flex items-end gap-1.5',
                        m.role === 'assistant' ? 'justify-end' : 'justify-start',
                      )}
                    >
                      {m.role === 'assistant' && (
                        <button
                          onClick={() =>
                            void marcarErrada(m.id, marcadas[m.id] ?? m.flagged ?? false)
                          }
                          title="Isso está errado — ensina a Sofia a não responder assim"
                          className={clsx(
                            'shrink-0 rounded-md p-1 transition',
                            (marcadas[m.id] ?? m.flagged)
                              ? 'text-[var(--alerta)]'
                              : 'text-transparent group-hover:text-[var(--bruma)] hover:!text-[var(--alerta)]',
                          )}
                        >
                          <ThumbsDown size={13} />
                        </button>
                      )}
                      <div
                        className={clsx(
                          'max-w-[78%] whitespace-pre-wrap rounded-[14px] px-3 py-2 text-[12.5px] leading-relaxed',
                          m.role === 'assistant'
                            ? 'bg-[var(--vida)]/[0.16] text-[var(--osso)]'
                            : 'bg-white/[0.06] text-[var(--osso)]',
                          (marcadas[m.id] ?? m.flagged) && 'ring-1 ring-[var(--alerta)]/60',
                        )}
                      >
                        {m.content}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </section>
        </Bloco>
      </div>
    </div>
  );
}
