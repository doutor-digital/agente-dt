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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PiArrowCounterClockwiseBold,
  PiArrowsLeftRightBold,
  PiCaretDownBold,
  PiChatCircleDotsBold,
  PiGearSixBold,
  PiPencilSimpleLineBold,
  PiSpinnerGapBold,
  PiWarningBold,
} from 'react-icons/pi';
import { api, type Automacao, type EstadoAutomacao, type RiscoAutomacao } from '../lib/api';
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

function Linha({
  a,
  salvando,
  onEstado,
  onDevolver,
}: {
  a: Automacao;
  salvando: boolean;
  onEstado: (estado: EstadoAutomacao) => void;
  onDevolver: () => void;
}) {
  const [aberta, setAberta] = useState(false);
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
                title={e === 'seco' ? 'Decide e registra no log, mas não toca no Kommo' : undefined}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${corDoBotao(e, a.estado === e)}`}
              >
                {salvando && a.estado === e ? <PiSpinnerGapBold className="animate-spin" /> : ROTULO[e]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {confirmando && (
        <div className="mx-4 mb-3.5 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
          <PiWarningBold className="shrink-0 text-amber-400" />
          <p className="min-w-[14rem] flex-1 text-xs leading-relaxed text-amber-100/90">
            {confirmando === 'seco' ? (
              <>
                Em <strong>só no papel</strong> ela decide e registra no log, mas não toca em cartão nenhum. É o jeito de
                ver o que ela faria antes de deixar fazer.
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
