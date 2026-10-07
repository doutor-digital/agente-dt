/**
 * Automações da unidade — o que roda sozinho, e o botão que liga e desliga.
 *
 * Pedido do João em 28/09/2026, com as palavras dele: "tem coisas que eu nem sei que funcionam na
 * prática, aí eu fico perdido... eu nem sabia que tinha esse worker em Serra". Cada uma destas era
 * uma variável de ambiente num `.env` dentro da VPS, e mudar uma exigia editar o arquivo e
 * redeployar. Ninguém lembra de 24 variáveis.
 *
 * Por isso a tela lista TODAS, inclusive as desligadas, e cada linha diz o que a automação faz antes
 * de dizer se está ligada: o problema a resolver é não saber que a coisa existe, não a falta de um
 * interruptor. A pegadinha de cada uma — o detalhe que só se descobre apanhando — abre no clique.
 *
 * As que movem cartão sozinhas pedem confirmação escrita antes de ligar, porque o estrago delas
 * aparece no funil e no relatório, e o Kommo não tem desfazer.
 *
 * "o que ela faria" (05/10/2026, pedido do João): em "Só no papel" a decisão ia só para o log do servidor,
 * que ele não abre. Agora cada automação com seco mostra aqui a lista — cartão, o que faria e por quê —
 * para conferir antes de ligar.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PiArrowCounterClockwiseBold,
  PiArrowsLeftRightBold,
  PiCaretDownBold,
  PiChatCircleDotsBold,
  PiClipboardTextBold,
  PiGearSixBold,
  PiPencilSimpleLineBold,
  PiSpinnerGapBold,
  PiWarningBold,
} from 'react-icons/pi';
import { api, type AcaoSimulada, type Automacao, type EstadoAutomacao, type RiscoAutomacao, type Simulacoes } from '../lib/api';
import { useUnit } from '../context/UnitContext';

const GRUPOS: Array<{ risco: RiscoAutomacao; titulo: string; explica: string; Icone: typeof PiArrowsLeftRightBold }> = [
  {
    risco: 'move-cartao',
    titulo: 'Movem cartão sozinhas',
    explica: 'Mudam a etapa do lead no Kommo sem ninguém arrastar. É o que mais aparece no funil e no relatório.',
    Icone: PiArrowsLeftRightBold,
  },
  {
    risco: 'manda-mensagem',
    titulo: 'Falam com alguém',
    explica: 'Mandam mensagem pro paciente ou aviso pro time. O erro aqui sai do CRM e chega em gente.',
    Icone: PiChatCircleDotsBold,
  },
  {
    risco: 'escreve-campo',
    titulo: 'Preenchem o cartão',
    explica: 'Escrevem campo. Erro aqui é dado errado — chato, mas corrigível.',
    Icone: PiPencilSimpleLineBold,
  },
  {
    risco: 'comportamento',
    titulo: 'Mudam o jeito da IA (ou o custo)',
    explica: 'Não movem nem escrevem nada: mexem em como a IA responde ou em quanto ela gasta.',
    Icone: PiGearSixBold,
  },
];

const ROTULO: Record<EstadoAutomacao, string> = {
  desligado: 'Desligado',
  seco: 'Só no papel',
  ligado: 'Ligado',
};

/** A cor diz o estado antes de a pessoa ler a palavra. */
function corDoBotao(estado: EstadoAutomacao, ativo: boolean): string {
  if (!ativo) return 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60';
  if (estado === 'ligado') return 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40';
  if (estado === 'seco') return 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40';
  return 'bg-zinc-700/50 text-zinc-300 ring-1 ring-zinc-600';
}

const ACAO: Record<AcaoSimulada, { rotulo: string; cor: string; explica: string }> = {
  moveria: { rotulo: 'moveria', cor: 'text-sky-300 bg-sky-500/10 ring-sky-500/30', explica: 'mudaria o cartão de etapa' },
  gravaria: { rotulo: 'gravaria', cor: 'text-violet-300 bg-violet-500/10 ring-violet-500/30', explica: 'preencheria um campo vazio' },
  confere: { rotulo: 'confere', cor: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30', explica: 'calculou o mesmo que já está no cartão' },
  diverge: { rotulo: 'diverge', cor: 'text-rose-300 bg-rose-500/10 ring-rose-500/30', explica: 'calculou diferente do que está no cartão (não mexe)' },
  etiquetaria: { rotulo: 'etiquetaria', cor: 'text-amber-300 bg-amber-500/10 ring-amber-500/30', explica: 'poria a etiqueta ▶ (e o bot dela mandaria a mensagem)' },
  pularia: { rotulo: 'pularia', cor: 'text-zinc-300 bg-zinc-500/10 ring-zinc-500/30', explica: 'não poria a etiqueta — o motivo diz por quê' },
};

const quando = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** A lista do que a automação faria: carrega no clique, filtra por tipo de decisão. */
function OQueFaria({ unitId, automacao }: { unitId: string; automacao: string }) {
  const [dias, setDias] = useState(7);
  const [dados, setDados] = useState<Simulacoes | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<AcaoSimulada | null>(null);

  useEffect(() => {
    let vivo = true;
    setDados(null);
    setErro(null);
    api
      .simulacoes(unitId, automacao, dias, filtro)
      .then((r) => vivo && setDados(r))
      .catch(() => vivo && setErro('não consegui ler o que ela faria'));
    return () => {
      vivo = false;
    };
  }, [unitId, automacao, dias, filtro]);

  if (erro) return <p className="px-4 pb-3.5 text-xs text-rose-300">{erro}</p>;
  if (!dados)
    return (
      <p className="flex items-center gap-2 px-4 pb-3.5 text-xs text-zinc-500">
        <PiSpinnerGapBold className="animate-spin" /> lendo…
      </p>
    );

  // o filtro é aplicado no servidor: a lista e o "mostrando X de Y" já vêm só com a ação escolhida
  const itens = dados.itens;
  const link = (id: number) => (dados.kommoSubdomain ? `https://${dados.kommoSubdomain}.kommo.com/leads/detail/${id}` : null);

  return (
    <div className="mx-4 mb-3.5 rounded-lg border border-zinc-800 bg-zinc-950/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/70 px-3 py-2.5 text-xs">
        <span className="text-zinc-300">
          <strong>{dados.resumo.cartoes}</strong> cartão(ões) nos últimos
        </span>
        <select
          value={dias}
          onChange={(e) => {
            setDias(Number(e.target.value));
            setFiltro(null); // o período novo pode não ter a ação filtrada — não deixa a lista presa em "nada"
          }}
          className="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-300 ring-1 ring-zinc-700"
        >
          <option value={1}>1 dia</option>
          <option value={7}>7 dias</option>
          <option value={30}>30 dias</option>
        </select>
        <span className="mx-1 text-zinc-700">·</span>
        {(Object.keys(ACAO) as AcaoSimulada[])
          .filter((k) => dados.resumo[k] > 0 || filtro === k)
          .map((k) => (
            <button
              key={k}
              type="button"
              title={ACAO[k].explica}
              onClick={() => setFiltro((f) => (f === k ? null : k))}
              className={`rounded px-1.5 py-0.5 ring-1 transition ${ACAO[k].cor} ${filtro && filtro !== k ? 'opacity-40' : ''}`}
            >
              {dados.resumo[k]} {ACAO[k].rotulo}
            </button>
          ))}
      </div>

      {itens.length === 0 ? (
        <p className="px-3 py-3 text-xs leading-relaxed text-zinc-500">
          Nada registrado nesse período. Com a automação em <em>Só no papel</em>, cada decisão aparece aqui na próxima
          varredura.
        </p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-zinc-950 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Cartão</th>
                <th className="px-3 py-2 font-medium">O que faria</th>
                <th className="px-3 py-2 font-medium">No cartão hoje</th>
                <th className="px-3 py-2 font-medium">Por quê</th>
                <th className="px-3 py-2 font-medium">Quando</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
              {itens.map((i) => {
                const url = link(i.leadId);
                return (
                  <tr key={`${i.leadId}-${i.acao}-${i.alvo}`} className="align-top">
                    <td className="px-3 py-2 font-mono">
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                          {i.leadId}
                        </a>
                      ) : (
                        i.leadId
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`mr-1.5 rounded px-1 py-px text-[10px] ring-1 ${ACAO[i.acao]?.cor ?? ''}`}>{i.acao}</span>
                      {i.acao === 'moveria' ? (
                        <>
                          {i.deEtapa && <span className="text-zinc-500">{i.deEtapa} → </span>}
                          <strong className="font-medium">{i.alvo}</strong>
                        </>
                      ) : (
                        <>
                          {i.alvo}
                          {i.valor !== null && <span className="text-zinc-400"> = {i.valor}</span>}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-400">{i.noCartao ?? (i.acao === 'gravaria' ? <em className="text-zinc-600">vazio</em> : '')}</td>
                    <td className="px-3 py-2 text-zinc-400">
                      {i.motivo}
                      {i.acao === 'moveria' && i.valor && /perdido/i.test(i.alvo) && (
                        <span className="block text-zinc-500">motivo de perda: {i.valor}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-500" title={`primeira vez: ${quando(i.primeiraEm)}`}>
                      {quando(i.ultimaEm)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {dados.total > dados.itens.length && (
            <p className="px-3 py-2 text-[11px] text-zinc-600">
              mostrando as {dados.itens.length} mais recentes de {dados.total}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Linha({
  unitId,
  a,
  salvando,
  onEstado,
  onDevolver,
}: {
  unitId: string;
  a: Automacao;
  salvando: boolean;
  onEstado: (estado: EstadoAutomacao) => void;
  onDevolver: () => void;
}) {
  const [aberta, setAberta] = useState(false);
  const [vendo, setVendo] = useState(false);
  const [confirmando, setConfirmando] = useState<EstadoAutomacao | null>(null);

  const estados: EstadoAutomacao[] = a.temSeco ? ['desligado', 'seco', 'ligado'] : ['desligado', 'ligado'];
  const perigosa = a.risco === 'move-cartao';

  const pedir = (estado: EstadoAutomacao) => {
    if (estado === a.estado) return;
    // Desligar nunca precisa de confirmação: parar de mexer no CRM é sempre o lado seguro.
    if (perigosa && estado !== 'desligado') setConfirmando(estado);
    else onEstado(estado);
  };

  return (
    <div className="border-b border-zinc-800/70 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-100">{a.nome}</span>
            {a.vemDoAmbiente && (
              <span
                className="rounded border border-zinc-700 px-1.5 py-px text-[10px] uppercase tracking-wider text-zinc-500"
                title={`Ninguém mexeu nesta tela — o valor ainda vem de ${a.chave} no .env da VPS: "${a.ambiente || '(vazio)'}"`}
              >
                vem do .env
              </span>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">{a.oQueFaz}</p>
          {a.pegadinha && (
            <button
              type="button"
              onClick={() => setAberta((v) => !v)}
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-zinc-500 transition hover:text-zinc-300"
            >
              <PiCaretDownBold className={`transition ${aberta ? 'rotate-180' : ''}`} />
              {aberta ? 'menos' : 'o que ninguém te conta'}
            </button>
          )}
          {a.temSeco && (
            <button
              type="button"
              onClick={() => setVendo((v) => !v)}
              className={`mt-1.5 inline-flex items-center gap-1 text-xs transition hover:text-amber-200 ${
                a.estado === 'seco' ? 'ml-3 text-amber-300/90' : 'ml-3 text-zinc-500'
              } ${a.pegadinha ? '' : 'ml-0'}`}
            >
              <PiClipboardTextBold />
              {vendo ? 'fechar' : 'o que ela faria'}
            </button>
          )}
          {aberta && a.pegadinha && (
            <p className="mt-2 rounded border-l-2 border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs leading-relaxed text-zinc-400">
              {a.pegadinha}
              <span className="mt-1.5 block text-[11px] text-zinc-600">
                {a.chave} · {a.arquivo}
              </span>
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {!a.vemDoAmbiente && (
            <button
              type="button"
              onClick={onDevolver}
              disabled={salvando}
              title="Apagar a decisão desta tela e voltar a seguir o .env — não é o mesmo que desligar"
              className="rounded p-1.5 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
            >
              <PiArrowCounterClockwiseBold />
            </button>
          )}
          <div className="flex rounded-lg bg-zinc-900/80 p-0.5 ring-1 ring-zinc-800">
            {estados.map((e) => (
              <button
                key={e}
                type="button"
                disabled={salvando}
                onClick={() => pedir(e)}
                title={e === 'seco' ? 'Decide e mostra em "o que ela faria", mas não toca no Kommo' : undefined}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${corDoBotao(e, a.estado === e)}`}
              >
                {salvando && a.estado === e ? <PiSpinnerGapBold className="animate-spin" /> : ROTULO[e]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {vendo && <OQueFaria unitId={unitId} automacao={a.id} />}

      {confirmando && (
        <div className="mx-4 mb-3.5 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
          <PiWarningBold className="shrink-0 text-amber-400" />
          <p className="min-w-[14rem] flex-1 text-xs leading-relaxed text-amber-100/90">
            {confirmando === 'seco' ? (
              <>
                Em <strong>só no papel</strong> ela decide e mostra a lista em <em>o que ela faria</em>, mas não toca em
                cartão nenhum. É o jeito de conferir antes de deixar fazer.
              </>
            ) : (
              <>
                <strong>{a.nome}</strong> passa a mover cartão de etapa sozinha nesta unidade, a partir de agora. O Kommo
                não tem desfazer.
              </>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmando(null)}
              className="rounded-md px-3 py-1.5 text-xs text-zinc-400 transition hover:text-zinc-200"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => {
                onEstado(confirmando);
                setConfirmando(null);
              }}
              className="rounded-md bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-200 ring-1 ring-amber-500/40 transition hover:bg-amber-500/30"
            >
              {confirmando === 'seco' ? 'Pôr em só no papel' : 'Ligar mesmo assim'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AutomacoesPanel() {
  const { selectedUnit: unit } = useUnit();
  const [lista, setLista] = useState<Automacao[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!unit) return;
    setCarregando(true);
    setErro(null);
    try {
      const r = await api.automacoes(unit.id);
      setLista(r.automacoes);
    } catch {
      setErro('não consegui ler as automações desta unidade');
      setLista([]);
    } finally {
      setCarregando(false);
    }
  }, [unit]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const mexer = useCallback(
    async (id: string, acao: () => Promise<{ automacoes: Automacao[] }>) => {
      setSalvando(id);
      setErro(null);
      try {
        const r = await acao();
        setLista(r.automacoes);
      } catch {
        setErro('não consegui salvar — nada foi alterado');
        await carregar(); // a tela não pode ficar mostrando um estado que o banco não tem
      } finally {
        setSalvando(null);
      }
    },
    [carregar],
  );

  const ligadas = useMemo(() => lista.filter((a) => a.estado !== 'desligado').length, [lista]);

  if (!unit) return <div className="p-6 text-sm text-zinc-500">Escolha uma unidade.</div>;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-zinc-100">Automações</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-zinc-400">
            O que roda sozinho em <strong className="text-zinc-200">{unit.name}</strong> — sem ninguém clicar, todo dia.
            Estão aqui as {lista.length || 24}, ligadas e desligadas, porque o problema nunca foi o interruptor: foi não
            saber que a coisa existia.
          </p>
          {!carregando && lista.length > 0 && (
            <p className="mt-2 text-xs text-zinc-500">
              {ligadas} de {lista.length} em funcionamento nesta unidade.
            </p>
          )}
        </header>

        {erro && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-200">{erro}</div>
        )}

        {carregando && (
          <div className="flex items-center gap-2 px-4 py-10 text-sm text-zinc-500">
            <PiSpinnerGapBold className="animate-spin" /> lendo o que está ligado…
          </div>
        )}

        {!carregando &&
          GRUPOS.map(({ risco, titulo, explica, Icone }) => {
            const doGrupo = lista.filter((a) => a.risco === risco);
            if (!doGrupo.length) return null;
            return (
              <section key={risco} className="mb-6">
                <div className="mb-2 flex items-start gap-2.5 px-1">
                  <Icone className="mt-0.5 shrink-0 text-zinc-500" />
                  <div>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">{titulo}</h2>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{explica}</p>
                  </div>
                </div>
                <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                  {doGrupo.map((a) => (
                    <Linha
                      key={a.id}
                      unitId={unit.id}
                      a={a}
                      salvando={salvando === a.id}
                      onEstado={(estado) => void mexer(a.id, () => api.definirAutomacao(unit.id, a.id, estado))}
                      onDevolver={() => void mexer(a.id, () => api.limparAutomacao(unit.id, a.id))}
                    />
                  ))}
                </div>
              </section>
            );
          })}

        {!carregando && lista.length > 0 && (
          <p className="px-1 pb-2 text-xs leading-relaxed text-zinc-600">
            Mudança aqui vale em segundos, sem deploy. O que está marcado <em>vem do .env</em> nunca foi tocado por esta
            tela e segue a configuração antiga do servidor — mexer uma vez passa a decisão pra cá, e a seta devolve.
          </p>
        )}
    </div>
    </div>
  );
}
