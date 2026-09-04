import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Target } from 'lucide-react';
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
 */

const PERIODOS = [30, 60, 90];

const DESFECHOS: Array<{ chave: keyof ResumoResultados; rotulo: string; cor: string; explica: string }> = [
  { chave: 'compareceu', rotulo: 'Compareceu', cor: 'bg-emerald-400', explica: 'A franquia registrou ATENDIDO (ou o Kommo diz "Compareceu").' },
  { chave: 'faltou', rotulo: 'Faltou', cor: 'bg-rose-400', explica: 'A franquia registrou NÃO COMPARECEU.' },
  { chave: 'cancelou', rotulo: 'Cancelou', cor: 'bg-amber-400', explica: 'Consulta desmarcada ou apagada depois de marcada.' },
  { chave: 'agendadoFuturo', rotulo: 'Marcado, ainda vai acontecer', cor: 'bg-sky-400', explica: 'Consulta no futuro. Vira "compareceu" ou "faltou" quando a franquia registrar.' },
  { chave: 'semRegistro', rotulo: 'Passou sem registro', cor: 'bg-zinc-500', explica: 'A consulta já passou e ninguém marcou o desfecho na franquia nem no Kommo.' },
  { chave: 'pendentes', rotulo: 'Ainda em conversa', cor: 'bg-violet-400', explica: 'Sem marcação e com mensagem nos últimos 7 dias.' },
];

function Kpi({ rotulo, valor, sufixo, nota }: { rotulo: string; valor: string | number | null; sufixo?: string; nota?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.08em] text-slate-500">{rotulo}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100 tabular-nums">
        {valor === null || valor === undefined ? '—' : valor}
        {valor !== null && valor !== undefined && sufixo ? <span className="ml-0.5 text-base text-slate-400">{sufixo}</span> : null}
      </div>
      {nota ? <div className="mt-1 text-[11.5px] leading-relaxed text-slate-500">{nota}</div> : null}
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

  const total = data ? Math.max(1, data.conversas) : 1;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Target size={18} className="text-emerald-300" /> Resultados
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
            De cada conversa, duas perguntas: a IA marcou consulta? O paciente compareceu? A resposta vem do Kommo
            (etapa e campos do cartão) e da franquia (status da consulta). A tabela é recalculada a cada 6 horas até
            o desfecho ser definitivo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {PERIODOS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDias(p)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition-colors',
                dias === p ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25' : 'text-zinc-500 ring-zinc-800 hover:text-zinc-300',
              )}
            >
              {p} dias
            </button>
          ))}
          <button
            type="button"
            onClick={() => void recalcular()}
            disabled={recalculando}
            className="ml-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-300 ring-1 ring-zinc-800 hover:text-zinc-100 disabled:opacity-50"
            title="Relê Kommo e franquia para todas as conversas do período (pode levar alguns minutos)"
          >
            {recalculando ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {recalculando ? 'Recalculando…' : 'Recalcular agora'}
          </button>
        </div>
      </header>

      {erro ? <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{erro}</div> : null}

      {carregando && !data ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 size={14} className="animate-spin" /> Carregando…</div>
      ) : data ? (
        <>
          {data.conversas === 0 ? (
            <div className="surface p-6 text-sm text-zinc-400">
              Nenhuma conversa calculada ainda para este período. Clique em <b className="text-zinc-200">Recalcular agora</b> para
              montar o livro a partir das conversas existentes.
            </div>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi rotulo="Conversas com paciente" valor={data.comPaciente} nota={`${data.conversas} conversas no total, ${data.dias} dias`} />
            <Kpi rotulo="Taxa de marcação" valor={data.taxaMarcacao} sufixo="%" nota={`${data.agendouQualquer} marcaram (${data.agendouIa} pela IA na agenda, ${data.agendouKommo} chegaram a AGENDADO no Kommo)`} />
            <Kpi rotulo="Taxa de comparecimento" valor={data.taxaComparecimento} sufixo="%" nota={`${data.compareceu} compareceram, ${data.faltou} faltaram (só consultas já ocorridas e registradas)`} />
            <Kpi rotulo="Pagamento antecipado" valor={data.pgAntecipadoSim + data.pgAntecipadoNao ? Math.round((data.pgAntecipadoSim / (data.pgAntecipadoSim + data.pgAntecipadoNao)) * 100) : null} sufixo="%" nota={`${data.pgAntecipadoSim} sim, ${data.pgAntecipadoNao} não — campo "Consulta pg antecipado" do Kommo`} />
          </section>

          <section className="surface p-6">
            <h2 className="text-sm font-semibold text-zinc-100">O que aconteceu com cada conversa</h2>
            <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-zinc-800">
              {DESFECHOS.map((d) => {
                const v = Number(data[d.chave] ?? 0);
                return v > 0 ? <div key={d.chave} className={clsx(d.cor)} style={{ width: `${(v / total) * 100}%` }} title={`${d.rotulo}: ${v}`} /> : null;
              })}
            </div>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {DESFECHOS.map((d) => (
                <li key={d.chave} className="flex items-start gap-2 text-[12.5px] text-zinc-400">
                  <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', d.cor)} />
                  <span>
                    <b className="text-zinc-200 tabular-nums">{Number(data[d.chave] ?? 0)}</b> {d.rotulo}
                    <span className="block text-[11.5px] text-zinc-500">{d.explica}</span>
                  </span>
                </li>
              ))}
              <li className="flex items-start gap-2 text-[12.5px] text-zinc-400">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-zinc-700" />
                <span>
                  <b className="text-zinc-200 tabular-nums">{data.conversas - data.compareceu - data.faltou - data.cancelou - data.agendadoFuturo - data.semRegistro - data.pendentes}</b> Não marcou
                  <span className="block text-[11.5px] text-zinc-500">Conversa encerrada sem consulta (7 dias sem mensagem).</span>
                </span>
              </li>
            </ul>
          </section>

          <section className="surface p-6">
            <h2 className="text-sm font-semibold text-zinc-100">O que quem marcou recebeu a mais</h2>
            <p className="mt-1 text-[12.5px] text-zinc-500">
              Comparação entre conversas que marcaram e que não marcaram. É daqui que saem as hipóteses para os experimentos.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-zinc-500">
                    <th className="py-2 pr-4 font-medium">Comportamento da IA</th>
                    <th className="py-2 pr-4 font-medium">Quem marcou</th>
                    <th className="py-2 pr-4 font-medium">Quem não marcou</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  <tr className="border-t border-zinc-800">
                    <td className="py-2 pr-4">Horários oferecidos por conversa (média)</td>
                    <td className="py-2 pr-4 tabular-nums">{data.mediaHorariosOferecidosQuemMarcou ?? '—'}</td>
                    <td className="py-2 pr-4 tabular-nums">{data.mediaHorariosOferecidosQuemNao ?? '—'}</td>
                  </tr>
                  <tr className="border-t border-zinc-800">
                    <td className="py-2 pr-4">Follow-ups enviados por conversa (média)</td>
                    <td className="py-2 pr-4 tabular-nums">{data.mediaFollowUpsQuemMarcou ?? '—'}</td>
                    <td className="py-2 pr-4 tabular-nums">{data.mediaFollowUpsQuemNao ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="surface p-6 text-[12.5px] leading-relaxed text-zinc-400">
            <h2 className="text-sm font-semibold text-zinc-100">Como este livro é montado</h2>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5">
              <li>Para cada conversa, a IA lê as mensagens e as ferramentas que usou: tempo até a primeira resposta, quantas vezes consultou a agenda, quantos horários ofereceu, em que mensagem falou de preço, quantos follow-ups mandou.</li>
              <li>No Kommo, lê a etapa do lead e três campos do cartão: <b className="text-zinc-300">◷ Data da Consulta</b>, <b className="text-zinc-300">✓ Situação da consulta</b> e <b className="text-zinc-300">✓ Consulta pg antecipado</b>.</li>
              <li>Na franquia, quando a consulta foi marcada pela IA, lê o status daquela consulta no cadastro do paciente: AGENDADO, CONFIRMADO, ATENDIDO, NÃO COMPARECEU, REMARCADO ou DESMARCADO. O que a franquia diz vale mais que o Kommo.</li>
              <li>O desfecho fica "definitivo" quando não pode mais mudar: compareceu, faltou, cancelou, ou 7 dias sem nenhuma mensagem. Até lá é recalculado a cada 6 horas.</li>
            </ol>
          </section>
        </>
      ) : null}
    </div>
  );
}
