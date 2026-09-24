import { useEffect, useMemo, useState } from 'react';
import { Loader2, LogOut, Pause, Play, ThumbsDown } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { usePolling } from '../hooks/usePolling';
import type { ConversationDetail, PausaEstado } from '../types/api';

/**
 * A tela da UNIDADE (papel UNIT_ADMIN).
 *
 * O console é do operador; aqui quem lê é o dono de uma clínica de coluna, que não abre
 * CRM e tem 30 segundos. A tela responde uma pergunta: a Sofia está trazendo paciente?
 *
 * Duas decisões de desenho, as duas tiradas do mundo da clínica e não de um kit de gráfico:
 *  · o funil é uma COLUNA — vértebras empilhadas, largura proporcional ao número. É o
 *    emblema da marca fazendo o trabalho do gráfico, e mostra onde a coluna "afina".
 *  · o status é um SINAL VITAL — linha que pulsa quando ela está no ar e para quando
 *    está pausada. O dono lê isso sem legenda.
 *
 * O resto é deliberadamente quieto: um lugar só pra ousadia.
 */

const DIAS = 30;

type Vertebra = {
  rotulo: string;
  valor: number;
  tom: 'vida' | 'carne';
  nota?: string;
};

function quando(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h`;
  const d = Math.floor(diff / 86_400_000);
  return d === 1 ? 'ontem' : `${d} dias`;
}

function reais(n: number): string {
  return n >= 1000 ? `R$ ${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')} mil` : `R$ ${n}`;
}

/** Seta de comparação com o período anterior. Sem base, não inventa: não mostra nada. */
function Delta({ agora, antes }: { agora: number; antes: number | null | undefined }) {
  if (antes == null || antes === 0) return null;
  const p = Math.round(((agora - antes) / antes) * 100);
  if (p === 0) return <span className="text-[11px] text-[var(--bruma)]">igual ao mês passado</span>;
  const subiu = p > 0;
  return (
    <span
      className={clsx(
        'text-[11px] font-semibold tabular-nums',
        subiu ? 'text-[var(--carne)]' : 'text-[var(--alerta)]',
      )}
    >
      {subiu ? '▲' : '▼'} {Math.abs(p)}% vs. mês passado
    </span>
  );
}

/** As 24 horas do dia. Responde "preciso de gente à noite?" sem ninguém perguntar. */
function FaixaDeHoras({ horas }: { horas: number[] }) {
  const topo = Math.max(...horas, 1);
  const forte = horas.indexOf(topo);
  const foraDoExpediente = horas.reduce((s, q, h) => (h < 8 || h >= 18 ? s + q : s), 0);
  const total = horas.reduce((s, q) => s + q, 0);
  const pct = total > 0 ? Math.round((foraDoExpediente / total) * 100) : 0;

  return (
    <div>
      <div className="flex h-[52px] items-end gap-[2px]">
        {horas.map((q, h) => (
          <div
            key={h}
            title={`${h}h — ${q} mensagem(ns)`}
            className={clsx(
              'flex-1 rounded-t-[2px] transition-colors',
              h < 8 || h >= 18 ? 'bg-[var(--vida)]/35' : 'bg-[var(--vida)]',
              h === forte && 'bg-[var(--osso)]',
            )}
            style={{ height: `${Math.max(3, (q / topo) * 100)}%` }}
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
        <p className="mt-3 text-[12.5px] leading-snug text-[var(--bruma)]">
          Pico às <strong className="text-[var(--osso)]">{forte}h</strong>. {pct}% das mensagens
          chegam fora do expediente — {pct >= 25 ? 'é aí que a Sofia paga o próprio custo.' : 'a maior parte cai no horário da equipe.'}
        </p>
      )}
    </div>
  );
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

/** Linha de sinal vital: pulsa no ar, para quando pausada. */
function SinalVital({ viva }: { viva: boolean }) {
  return (
    <svg
      viewBox="0 0 240 40"
      className="h-10 w-[240px] overflow-visible"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <path
        d="M0 20 H62 l7 -13 l8 26 l7 -13 H124 l6 -7 l6 14 l6 -7 H240"
        fill="none"
        stroke={viva ? 'var(--vida)' : 'var(--linha)'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={viva ? undefined : '4 7'}
        className={viva ? 'sinal-vivo' : undefined}
      />
    </svg>
  );
}

function Coluna({
  vertebras,
  anterior,
}: {
  vertebras: Vertebra[];
  anterior: { chegaram: number; conversou: number } | null;
}) {
  const topo = Math.max(...vertebras.map((v) => v.valor), 1);

  // onde a coluna mais afina — é a informação que o dono procura sem saber que procura
  let piorQueda = -1;
  let piorPerda = 0;
  for (let i = 1; i < vertebras.length; i++) {
    const de = vertebras[i - 1].valor;
    const para = vertebras[i].valor;
    if (de <= 0) continue;
    const perda = 1 - para / de;
    if (perda > piorPerda) {
      piorPerda = perda;
      piorQueda = i;
    }
  }

  return (
    <div className="relative flex flex-col items-center gap-[5px]">
      {/* o eixo: sem ele as vértebras viram barra de gráfico */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-[4px] z-0 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-[var(--linha)] to-transparent"
        style={{ left: 'calc(50% + 84px)' }}
      />
      {vertebras.map((v, i) => {
        const largura = Math.max(11, (v.valor / topo) * 100);
        return (
          <div key={v.rotulo} className="w-full">
            {i === piorQueda && piorPerda > 0.4 && (
              <div className="mb-[7px] flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--alerta)]">
                <span className="h-px flex-1 bg-[var(--alerta)]/30" />
                perde {Math.round(piorPerda * 100)}% aqui
                <span className="h-px flex-1 bg-[var(--alerta)]/30" />
              </div>
            )}
            <div className="group flex items-center gap-4">
              <span className="w-[152px] shrink-0 text-right text-[12.5px] leading-tight text-[var(--bruma)]">
                {v.rotulo}
                {i === 0 && anterior && (
                  <span className="mt-0.5 block">
                    <Delta agora={v.valor} antes={anterior.chegaram} />
                  </span>
                )}
                {i === 1 && anterior && (
                  <span className="mt-0.5 block">
                    <Delta agora={v.valor} antes={anterior.conversou} />
                  </span>
                )}
              </span>
              <div className="flex flex-1 justify-center">
                <div
                  className="vertebra relative z-10 flex h-[34px] items-center justify-center rounded-[14px] transition-[filter] duration-200 group-hover:brightness-110"
                  style={{
                    width: `${largura}%`,
                    background:
                      v.tom === 'carne'
                        ? 'linear-gradient(180deg, var(--carne) 0%, color-mix(in srgb, var(--carne) 72%, #000) 100%)'
                        : 'linear-gradient(180deg, var(--vida) 0%, color-mix(in srgb, var(--vida) 70%, #000) 100%)',
                    animationDelay: `${i * 70}ms`,
                  }}
                >
                  <span className="font-display text-[19px] font-bold leading-none text-[#06101f] tabular-nums">
                    {v.valor}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
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

  const pausa = useMemo(
    () => () => (selectedUnitId ? api.pausaEstado(selectedUnitId) : Promise.resolve(null)),
    [selectedUnitId],
  );
  const { data: estadoPausa } = usePolling(pausa, 30_000, [selectedUnitId]);

  const extra = useMemo(
    () => () => (selectedUnitId ? api.painelUnidade(selectedUnitId, DIAS) : Promise.resolve(null)),
    [selectedUnitId],
  );
  const { data: mais } = usePolling(extra, 120_000, [selectedUnitId]);

  const conversas = useMemo(() => () => api.listConversations(selectedUnitId), [selectedUnitId]);
  const { data: listaConversas } = usePolling(conversas, 15_000, [selectedUnitId]);

  const [abertaId, setAbertaId] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<ConversationDetail | null>(null);
  const [mexendo, setMexendo] = useState(false);
  const [marcadas, setMarcadas] = useState<Record<string, boolean>>({});

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
   * "Isso está errado" numa resposta da Sofia. Não é só desabafo: a mensagem marcada
   * entra no prompt dela como exemplo a evitar, então o dono da clínica está ensinando
   * a IA dele. Por isso o texto do botão fala de ensinar, não de reclamar.
   */
  async function marcarErrada(id: string, atual: boolean) {
    const novo = !atual;
    setMarcadas((m) => ({ ...m, [id]: novo }));
    try {
      await api.flagMessage(id, novo);
      toast.success(novo ? 'Anotado. A Sofia aprende a não responder assim.' : 'Marca removida.');
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

  const vertebras: Vertebra[] = [
    { rotulo: 'chegaram', valor: k?.uniqueLeads ?? 0, tom: 'vida' },
    { rotulo: 'ela conversou', valor: k?.answeredConversations ?? 0, tom: 'vida' },
    { rotulo: 'marcaram consulta', valor: k?.aiScheduledConsults ?? 0, tom: 'vida' },
    { rotulo: 'compareceram', valor: k?.aiCompareceu ?? 0, tom: 'carne' },
    { rotulo: 'fecharam tratamento', valor: k?.aiFechouTratamento ?? 0, tom: 'carne' },
  ];

  return (
    <div className="tela-unidade min-h-screen overflow-auto">
      <style>{`
        .tela-unidade{
          --noite:#0A1120; --placa:#101C33; --linha:#1D2B47;
          --osso:#E9EFF8; --bruma:#8BA0C0;
          --vida:#4C9EFF; --carne:#2FBF71; --alerta:#E4572E;
          background:
            radial-gradient(900px 420px at 18% -8%, rgba(76,158,255,.10), transparent 60%),
            var(--noite);
          color: var(--osso);
          font-family: "Public Sans", var(--font-body), system-ui, sans-serif;
        }
        .tela-unidade .font-display{
          font-family: "Bricolage Grotesque", var(--font-display), system-ui, sans-serif;
          letter-spacing:-.02em;
        }
        .tela-unidade .vertebra{
          transform-origin:center;
          animation: encaixa .5s cubic-bezier(.16,1,.3,1) both;
        }
        @keyframes encaixa{
          from{ opacity:0; transform:translateY(-9px) scaleX(.86); }
          to{ opacity:1; transform:none; }
        }
        .tela-unidade .sinal-vivo{
          stroke-dasharray: 26 300;
          animation: batida 2.4s linear infinite;
        }
        @keyframes batida{ from{ stroke-dashoffset:326; } to{ stroke-dashoffset:0; } }
        .tela-unidade .sobe{ animation: sobe .5s cubic-bezier(.16,1,.3,1) both; }
        @keyframes sobe{ from{ opacity:0; transform:translateY(8px);} to{ opacity:1; transform:none;} }
        @media (prefers-reduced-motion: reduce){
          .tela-unidade .vertebra, .tela-unidade .sobe{ animation:none; }
          .tela-unidade .sinal-vivo{ animation:none; stroke-dasharray:none; }
        }
      `}</style>

      <div className="mx-auto w-full max-w-[1180px] px-6 py-8 lg:px-10">
        {/* cabeçalho: quem é, e o sinal vital */}
        <header className="flex flex-wrap items-end justify-between gap-6 border-b border-[var(--linha)] pb-7">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--bruma)]">
              {estadoPausa?.unidade ?? 'Carregando'}
            </p>
            <h1 className="font-display mt-1 text-[40px] font-bold leading-none">Sofia</h1>
            <p className="mt-2 max-w-[42ch] text-[13.5px] leading-snug text-[var(--bruma)]">
              {viva
                ? 'Está respondendo os pacientes no WhatsApp agora.'
                : (estadoPausa?.descricao ?? 'Está pausada — ninguém está sendo respondido.')}
            </p>
          </div>

          <div className="flex flex-col items-end gap-3">
            <div className="flex items-center gap-3">
              <SinalVital viva={viva} />
              <span
                className={clsx(
                  'font-display text-[13px] font-bold uppercase tracking-[0.14em]',
                  viva ? 'text-[var(--vida)]' : 'text-[var(--bruma)]',
                )}
              >
                {viva ? 'no ar' : 'pausada'}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {viva ? (
                <>
                  <button
                    disabled={mexendo}
                    onClick={() => void mudarPausa('hoje')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--linha)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--bruma)] transition hover:border-[var(--alerta)] hover:text-[var(--osso)] disabled:opacity-40"
                  >
                    <Pause size={13} /> pausar hoje
                  </button>
                  <button
                    disabled={mexendo}
                    onClick={() => void mudarPausa('amanha')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--linha)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--bruma)] transition hover:border-[var(--alerta)] hover:text-[var(--osso)] disabled:opacity-40"
                  >
                    até amanhã 8h
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
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-[var(--bruma)] transition hover:text-[var(--osso)]"
              >
                <LogOut size={13} /> sair
              </button>
            </div>
          </div>
        </header>

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
          {/* a coluna — o funil como vértebras */}
          <section className="sobe">
            <div className="mb-5 flex items-baseline justify-between">
              <h2 className="font-display text-[19px] font-bold">A coluna dos últimos 30 dias</h2>
              <span className="text-[12px] text-[var(--bruma)]">
                de cima pra baixo, quem sobrou em cada passo
              </span>
            </div>

            {loading && !k ? (
              <div className="flex items-center gap-2 py-16 text-[13px] text-[var(--bruma)]">
                <Loader2 size={15} className="animate-spin" /> montando…
              </div>
            ) : (
              <div className="rounded-2xl border border-[var(--linha)] bg-[var(--placa)] px-6 py-7">
                <Coluna vertebras={vertebras} anterior={mais?.anterior ?? null} />
                {(k?.aiAindaNoFuturo ?? 0) > 0 && (
                  <p className="mt-6 border-t border-[var(--linha)] pt-4 text-[12.5px] text-[var(--bruma)]">
                    Mais {k?.aiAindaNoFuturo} com consulta marcada para os próximos dias — ainda
                    podem virar tratamento.
                  </p>
                )}
                {(mais?.naMesa.length ?? 0) > 0 && (
                  <div className="mt-6 border-t border-[var(--linha)] pt-5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-display text-[26px] font-bold text-[var(--alerta)]">
                        {reais((mais!.naMesa.length) * (mais!.ticketEstimadoBrl || 0))}
                      </span>
                      <span className="text-[13px] text-[var(--osso)]">
                        parados na mesa — {mais!.naMesa.length}{' '}
                        {mais!.naMesa.length === 1 ? 'pessoa avaliou' : 'pessoas avaliaram'} e não
                        fechou tratamento
                      </span>
                    </div>
                    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                      {mais!.naMesa.slice(0, 8).map((p) => (
                        <li key={p.nome + p.quando} className="text-[12.5px] text-[var(--bruma)]">
                          <span className="text-[var(--osso)]">{p.nome}</span>
                          {p.quando && ` · ${p.quando.slice(8, 10)}/${p.quando.slice(5, 7)}`}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[11.5px] text-[var(--bruma)]/70">
                      Estimado pelo ticket mais comum da rede (R$ {mais!.ticketEstimadoBrl}). O valor
                      real de cada caso está na ficha do paciente.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>

          <div className="flex flex-col gap-8">
            {/* precisa de você */}
            <section className="sobe" style={{ animationDelay: '80ms' }}>
              <h2 className="font-display mb-4 text-[19px] font-bold">
                Precisa de você{' '}
                {dash && dash.hotQueue.length > 0 && (
                  <span className="text-[var(--alerta)]">({dash.hotQueue.length})</span>
                )}
              </h2>
              <div className="overflow-hidden rounded-2xl border border-[var(--linha)] bg-[var(--placa)]">
                {(dash?.hotQueue ?? []).slice(0, 5).map((h) => (
                  <div
                    key={h.leadId}
                    className="flex items-center gap-3 border-b border-[var(--linha)] px-4 py-3 last:border-b-0"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--alerta)]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold">
                        {h.contactName || h.phone || `Lead ${h.leadId}`}
                      </div>
                      <div className="text-[12px] text-[var(--bruma)]">
                        esperando há {espera(h.waitingMinutes)}
                        {h.reactivations > 0 && ` · ${h.reactivations} tentativa(s) de retomar`}
                      </div>
                    </div>
                  </div>
                ))}
                {dash && dash.hotQueue.length === 0 && (
                  <p className="px-4 py-6 text-[13px] leading-relaxed text-[var(--bruma)]">
                    Ninguém esperando. Quando a Sofia não der conta de alguém, o nome aparece aqui
                    pra sua equipe assumir.
                  </p>
                )}
              </div>
            </section>

            {/* sumindo do tratamento — receita já vendida escorrendo */}
            {(mais?.sumindo.length ?? 0) > 0 && (
              <section className="sobe" style={{ animationDelay: '120ms' }}>
                <h2 className="font-display mb-1 text-[19px] font-bold">Sumindo do tratamento</h2>
                <p className="mb-4 text-[12.5px] leading-snug text-[var(--bruma)]">
                  Já pagaram e estão faltando às sessões seguidas. Uma ligação ainda traz de volta.
                </p>
                <div className="overflow-hidden rounded-2xl border border-[var(--linha)] bg-[var(--placa)]">
                  {mais!.sumindo.map((p) => (
                    <div
                      key={p.nome}
                      className="flex items-center gap-3 border-b border-[var(--linha)] px-4 py-3 last:border-b-0"
                    >
                      <span className="font-display w-7 shrink-0 text-center text-[17px] font-bold leading-none text-[var(--alerta)] tabular-nums">
                        {p.faltasSeguidas}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold">{p.nome}</div>
                        <div className="text-[12px] text-[var(--bruma)]">
                          faltas seguidas · fez {p.feitas} de {p.total} sessões
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* a que horas eles chamam */}
            {mais && mais.porHora.some((q) => q > 0) && (
              <section className="sobe" style={{ animationDelay: '140ms' }}>
                <h2 className="font-display mb-4 text-[19px] font-bold">A que horas eles chamam</h2>
                <div className="rounded-2xl border border-[var(--linha)] bg-[var(--placa)] px-5 py-5">
                  <FaixaDeHoras horas={mais.porHora} />
                </div>
              </section>
            )}

            {/* o que ela falou */}
            <section className="sobe flex min-h-0 flex-1 flex-col" style={{ animationDelay: '160ms' }}>
              <h2 className="font-display mb-1 text-[19px] font-bold">O que ela falou</h2>
              <p className="mb-4 text-[12.5px] leading-snug text-[var(--bruma)]">
                Achou uma resposta ruim? Passe o mouse nela e marque — a Sofia aprende a não
                responder assim.
              </p>
              <div className="overflow-hidden rounded-2xl border border-[var(--linha)] bg-[var(--placa)]">
                <div className="max-h-[210px] overflow-auto">
                  {(listaConversas ?? []).slice(0, 30).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setAbertaId(c.id === abertaId ? null : c.id)}
                      className={clsx(
                        'flex w-full items-center gap-3 border-b border-[var(--linha)] px-4 py-2.5 text-left transition last:border-b-0 hover:bg-white/[0.03]',
                        abertaId === c.id && 'bg-white/[0.05]',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold">
                          {c.contactName || c.phone || 'Sem nome'}
                        </div>
                        <div className="text-[11.5px] text-[var(--bruma)]">
                          {quando(c.lastMessageAt)} · {c._count.messages} mensagens
                        </div>
                      </div>
                    </button>
                  ))}
                  {(listaConversas ?? []).length === 0 && (
                    <p className="px-4 py-6 text-[13px] text-[var(--bruma)]">
                      Nenhuma conversa ainda.
                    </p>
                  )}
                </div>

                {abertaId && (
                  <div className="max-h-[300px] space-y-2.5 overflow-auto border-t border-[var(--linha)] bg-[var(--noite)]/60 px-4 py-4">
                    {!detalhe && (
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
                              onClick={() => void marcarErrada(m.id, marcadas[m.id] ?? m.flagged ?? false)}
                              title="Isso está errado — ensina a Sofia a não responder assim"
                              className={clsx(
                                'shrink-0 rounded-md p-1 transition',
                                (marcadas[m.id] ?? m.flagged)
                                  ? 'text-[var(--alerta)]'
                                  : 'text-[var(--bruma)]/0 group-hover:text-[var(--bruma)] hover:!text-[var(--alerta)]',
                              )}
                            >
                              <ThumbsDown size={13} />
                            </button>
                          )}
                          <div
                            className={clsx(
                              'max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[12.5px] leading-relaxed',
                              m.role === 'assistant'
                                ? 'bg-[var(--vida)]/15 text-[var(--osso)]'
                                : 'bg-white/[0.06] text-[var(--osso)]',
                              (marcadas[m.id] ?? m.flagged) &&
                                'ring-1 ring-[var(--alerta)]/60',
                            )}
                          >
                            {m.content}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
