import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { ResumoResultados } from '../types/api';

/**
 * Livro de resultados — a "recompensa" da IA em números.
 *
 * Até esta tela, a Sofia era avaliada por um juiz que lê a conversa e dá nota de
 * estilo. O que interessa ao negócio é outra coisa: a conversa virou consulta
 * marcada? O paciente apareceu? Aqui cada conversa dos últimos N dias tem um
 * desfecho, lido do Kommo (marcou) e da franquia (compareceu), e dá para ver o que
 * quem marcou recebeu a mais do que quem não marcou.
 *
 * Visual segue a tela "Saúde da IA" (mesma largura, chips e cards), a pedido.
 */

const PERIODOS = [30, 60, 90];

const DESFECHOS: Array<{ chave: keyof ResumoResultados; rotulo: string; ponto: string; explica: string }> = [
  { chave: 'compareceu', rotulo: 'Compareceu', ponto: 'bg-emerald-400', explica: 'A franquia registrou ATENDIDO (ou o Kommo diz "Compareceu").' },
  { chave: 'faltou', rotulo: 'Faltou', ponto: 'bg-rose-400', explica: 'A franquia registrou NÃO COMPARECEU.' },
  { chave: 'cancelou', rotulo: 'Cancelou', ponto: 'bg-amber-400', explica: 'Consulta desmarcada ou apagada depois de marcada.' },
  { chave: 'agendadoFuturo', rotulo: 'Marcado, ainda vai acontecer', ponto: 'bg-sky-400', explica: 'Consulta no futuro. Vira "compareceu" ou "faltou" quando a franquia registrar.' },
  { chave: 'semRegistro', rotulo: 'Passou sem registro', ponto: 'bg-zinc-500', explica: 'A consulta já passou e ninguém marcou o desfecho na franquia nem no Kommo.' },
  { chave: 'pendentes', rotulo: 'Ainda em conversa', ponto: 'bg-violet-400', explica: 'Sem marcação e com mensagem nos últimos 7 dias.' },
];

function Chip({ valor, rotulo, ponto }: { valor: string | number; rotulo: string; ponto?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
      {ponto ? <span className={clsx('h-2 w-2 rounded-full', ponto)} /> : null}
      <span className="font-mono text-[15px] tabular-nums text-slate-100">{valor}</span>
      <span className="text-[11.5px] text-slate-500">{rotulo}</span>
    </div>
  );
}

function Cartao({ titulo, valor, nota }: { titulo: string; valor: string; nota: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <h4 className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">{titulo}</h4>
      <div className="mt-1.5 font-mono text-[22px] tabular-nums text-slate-100">{valor}</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400">{nota}</p>
    </div>
  );
}

export function ResultadosPanel() {
  const { selectedUnit } = useUnit();
  const unitId = selectedUnit?.id ?? '';
  const [dias, setDias] = useState(60);
  const [data, setData] = useState<ResumoResultados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [recalculando, setRecalculando] = useState(false);

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      setData(await api.resultados(unitId, dias));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar');
    } finally {
      setCarregando(false);
    }
  }

  async function recalcular() {
    setRecalculando(true);
    try {
      const r = await api.recalcularResultados(unitId, dias);
      setData(r.resumo);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao recalcular');
    } finally {
      setRecalculando(false);
    }
  }

  useEffect(() => {
    if (!unitId) return;
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId, dias]);

  if (!unitId) {
    return <div className="flex-1 overflow-y-auto p-6 text-[13px] text-slate-500">Escolha uma unidade para ver os resultados.</div>;
  }
  if (carregando && !data) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-white/30" />
      </div>
    );
  }

  const total = data ? Math.max(1, data.conversas) : 1;
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
  const naoMarcou = data
    ? data.conversas - data.compareceu - data.faltou - data.cancelou - data.agendadoFuturo - data.semRegistro - data.pendentes
    : 0;
  const pgTotal = data ? data.pgAntecipadoSim + data.pgAntecipadoNao : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 pb-16">
        <header>
          <h2 className="text-[19px] font-semibold tracking-tight text-slate-100">Resultados</h2>
          <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-slate-500">
            De cada conversa, duas perguntas: a IA marcou consulta? O paciente compareceu? A resposta vem do Kommo
            (etapa e campos do cartão) e da franquia (status da consulta). Recalculado a cada 6 horas até o desfecho
            ser definitivo.
          </p>
        </header>

        {erro ? <div className="rounded-xl border border-rose-400/20 bg-rose-400/[0.05] p-4 text-[12.5px] text-rose-200">{erro}</div> : null}

        {data ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Chip valor={data.comPaciente} rotulo="conversas com paciente" ponto="bg-slate-400" />
              <Chip valor={data.agendouQualquer} rotulo="marcaram" ponto="bg-emerald-400" />
              <Chip valor={data.compareceu} rotulo="compareceram" ponto="bg-emerald-300" />
              <Chip valor={data.faltou} rotulo="faltaram" ponto="bg-rose-400" />
              <div className="ml-auto flex items-center gap-1.5">
                {PERIODOS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setDias(p)}
                    className={clsx(
                      'rounded-md border px-2.5 py-1.5 text-[12px] transition',
                      dias === p ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-white/[0.1] text-slate-300 hover:bg-white/[0.05]',
                    )}
                  >
                    {p} dias
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void recalcular()}
                  disabled={recalculando}
                  title="Relê Kommo e franquia para todas as conversas do período (pode levar alguns minutos)"
                  className="flex items-center gap-1.5 rounded-md border border-white/[0.1] px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/[0.05] disabled:opacity-40"
                >
                  <RefreshCw className={clsx('h-3 w-3', recalculando && 'animate-spin')} />
                  {recalculando ? 'Recalculando…' : 'Recalcular agora'}
                </button>
              </div>
            </div>

            {data.conversas === 0 ? (
              <div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.05] p-4 text-[12.5px] leading-relaxed text-sky-100">
                Nenhuma conversa calculada ainda para este período. Clique em <span className="font-medium">Recalcular agora</span> para
                montar o livro a partir das conversas existentes.
              </div>
            ) : null}

            <section>
              <h3 className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">As quatro taxas</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Cartao titulo="Taxa de marcação" valor={pct(data.taxaMarcacao)} nota={`${data.agendouQualquer} de ${data.comPaciente} conversas viraram consulta marcada: ${data.agendouIa} pela IA direto na agenda, ${data.agendouKommo} chegaram a AGENDADO no Kommo (pela IA ou pela equipe depois dela).`} />
                <Cartao titulo="Taxa de comparecimento" valor={pct(data.taxaComparecimento)} nota={`${data.compareceu} compareceram e ${data.faltou} faltaram, contando só consultas que já aconteceram e foram registradas. Onde a franquia não registra falta, esta taxa fica alta por falta de dado, não por presença.`} />
                <Cartao titulo="Pagamento antecipado" valor={pgTotal ? `${Math.round((data.pgAntecipadoSim / pgTotal) * 100)}%` : '—'} nota={`${data.pgAntecipadoSim} pagaram antes e ${data.pgAntecipadoNao} não, pelo campo "✓ Consulta pg antecipado" do Kommo. Antecipado é o maior redutor de falta que conhecemos.`} />
                <Cartao titulo="Marcados pela IA sozinha" valor={String(data.agendouIa)} nota={`Consultas criadas pela própria Sofia na agenda da franquia. O resto foi fechado pela equipe depois da conversa com ela. É este número que o motor de comparecimento e os experimentos vão subir.`} />
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">O que aconteceu com cada conversa</h3>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  {DESFECHOS.map((d) => {
                    const v = Number(data[d.chave] ?? 0);
                    return v > 0 ? <div key={d.chave} className={d.ponto} style={{ width: `${(v / total) * 100}%` }} title={`${d.rotulo}: ${v}`} /> : null;
                  })}
                </div>
                <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
                  {DESFECHOS.map((d) => (
                    <li key={d.chave} className="flex items-start gap-2.5">
                      <span className={clsx('mt-[5px] h-2 w-2 shrink-0 rounded-full', d.ponto)} />
                      <div className="text-[12.5px] leading-relaxed text-slate-300">
                        <span className="font-mono tabular-nums text-slate-100">{Number(data[d.chave] ?? 0)}</span> {d.rotulo}
                        <div className="text-[11.5px] text-slate-500">{d.explica}</div>
                      </div>
                    </li>
                  ))}
                  <li className="flex items-start gap-2.5">
                    <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-white/20" />
                    <div className="text-[12.5px] leading-relaxed text-slate-300">
                      <span className="font-mono tabular-nums text-slate-100">{naoMarcou}</span> Não marcou
                      <div className="text-[11.5px] text-slate-500">Conversa encerrada sem consulta (7 dias sem mensagem).</div>
                    </div>
                  </li>
                </ul>
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">O que quem marcou recebeu a mais</h3>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <p className="text-[12px] leading-relaxed text-slate-500">
                  Comparação entre conversas que marcaram e que não marcaram. É daqui que saem as hipóteses para os experimentos.
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-left text-[10.5px] uppercase tracking-[0.12em] text-slate-500">
                        <th className="py-2 pr-4 font-medium">Comportamento da IA</th>
                        <th className="py-2 pr-4 font-medium">Quem marcou</th>
                        <th className="py-2 pr-4 font-medium">Quem não marcou</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      <tr className="border-t border-white/[0.06]">
                        <td className="py-2 pr-4">Horários oferecidos por conversa (média)</td>
                        <td className="py-2 pr-4 font-mono tabular-nums">{data.mediaHorariosOferecidosQuemMarcou ?? '—'}</td>
                        <td className="py-2 pr-4 font-mono tabular-nums">{data.mediaHorariosOferecidosQuemNao ?? '—'}</td>
                      </tr>
                      <tr className="border-t border-white/[0.06]">
                        <td className="py-2 pr-4">Follow-ups enviados por conversa (média)</td>
                        <td className="py-2 pr-4 font-mono tabular-nums">{data.mediaFollowUpsQuemMarcou ?? '—'}</td>
                        <td className="py-2 pr-4 font-mono tabular-nums">{data.mediaFollowUpsQuemNao ?? '—'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">Como este livro é montado</h3>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <ol className="list-decimal space-y-1.5 pl-5 text-[12px] leading-relaxed text-slate-400">
                  <li>Para cada conversa, a IA lê as mensagens e as ferramentas que usou: tempo até a primeira resposta, quantas vezes consultou a agenda, quantos horários ofereceu, em que mensagem falou de preço, quantos follow-ups mandou.</li>
                  <li>No Kommo, lê a etapa do lead e três campos do cartão: <span className="text-slate-300">◷ Data da Consulta</span>, <span className="text-slate-300">✓ Situação da consulta</span> e <span className="text-slate-300">✓ Consulta pg antecipado</span>.</li>
                  <li>Na franquia, quando a consulta foi marcada pela IA, lê o status daquela consulta no cadastro do paciente: AGENDADO, CONFIRMADO, ATENDIDO, NÃO COMPARECEU, REMARCADO ou DESMARCADO. O que a franquia diz vale mais que o Kommo.</li>
                  <li>O desfecho fica definitivo quando não pode mais mudar: compareceu, faltou, cancelou, ou 7 dias sem nenhuma mensagem. Até lá é recalculado a cada 6 horas.</li>
                </ol>
              </div>
            </section>
          </>
        ) : null}

        <p className="border-t border-white/[0.06] pt-4 text-[11.5px] leading-relaxed text-slate-600">
          Nota de estilo não paga consulta. Comparecimento paga. Este livro é a recompensa pela qual a Sofia vai passar a
          aprender.
        </p>
      </div>
    </div>
  );
}
