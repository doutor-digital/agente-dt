/**
 * Painel do suporte — suporte.doutordigitalconsultoria.com (pedido do João, 09/11/2026).
 *
 * A equipe manda a demanda no WhatsApp do suporte; o menu abre o protocolo e a IA analisa (só leitura). Aqui o João e a
 * Suzanne veem cada demanda com a análise, e o botão "Resolvido" avisa a pessoa no WhatsApp para testar (ela responde 1/2;
 * "ainda não" reabre sozinho). A aba "Base de conhecimento" é o que a IA lê antes de analisar: causa conhecida, como
 * reconhecer, o que fazer — quanto melhor a base, melhor a análise.
 *
 * O relato é texto de quem escreveu: aparece como texto, nunca como HTML.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PiArrowSquareOutBold,
  PiRobotBold,
  PiArrowCounterClockwiseBold,
  PiBookOpenTextBold,
  PiCheckCircleBold,
  PiLifebuoyBold,
  PiPauseBold,
  PiPlayBold,
  PiPencilSimpleLineBold,
  PiPlusBold,
  PiSpinnerGapBold,
  PiTrashBold,
  PiWarningBold,
} from 'react-icons/pi';
import { apiSuporte, erroDaApi, type DemandaSuporte, type ItemConhecimento, type PausaSuporte } from '../lib/api';

type Aba = 'demandas' | 'base';
type Filtro = 'abertas' | 'resolvidas' | 'todas';

const NOME_PRIORIDADE: Record<string, string> = { urgente: 'Urgente', hoje: 'Hoje', pode_esperar: 'Pode esperar' };
const COR_PRIORIDADE: Record<string, string> = {
  urgente: 'bg-red-500/15 text-red-300 ring-red-500/30',
  hoje: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  pode_esperar: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
};
const COR_CONFIANCA: Record<string, string> = { alta: 'text-emerald-300', media: 'text-amber-300', baixa: 'text-zinc-400' };

const quando = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(iso)) : '—';

function Selo({ children, cor }: { children: React.ReactNode; cor: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cor}`}>{children}</span>;
}

export default function SuportePanel() {
  const [aba, setAba] = useState<Aba>('demandas');
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <PiLifebuoyBold className="h-7 w-7 text-sky-400" />
            <div>
              <h1 className="text-lg font-semibold text-zinc-100">Suporte</h1>
              <p className="text-xs text-zinc-400">Demandas da equipe pelo WhatsApp, com a análise automática.</p>
            </div>
          </div>
          <div className="flex rounded-lg bg-zinc-900 p-1 ring-1 ring-zinc-800">
            {(
              [
                ['demandas', 'Demandas', PiLifebuoyBold],
                ['base', 'Base de conhecimento', PiBookOpenTextBold],
              ] as const
            ).map(([id, rotulo, Icone]) => (
              <button
                key={id}
                onClick={() => setAba(id)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${aba === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Icone className="h-4 w-4" />
                {rotulo}
              </button>
            ))}
          </div>
        </header>
        <BarraDePausa />
        {aba === 'demandas' ? <Demandas /> : <Base />}
      </div>
    </div>
  );
}

// ─── Pausa do menu (a mesma chave do /pausar do @ddchamados_bot) ──────────────────────────────────────────

function BarraDePausa() {
  const [pausa, setPausa] = useState<PausaSuporte | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [mudando, setMudando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setPausa(await apiSuporte.pausa());
      setErro(null);
    } catch (e) {
      setErro(erroDaApi(e));
    }
  }, []);

  useEffect(() => {
    void carregar();
    const t = setInterval(() => void carregar(), 30_000);
    return () => clearInterval(t);
  }, [carregar]);

  async function mudar(pausar: boolean) {
    setMudando(true);
    setConfirmar(false);
    try {
      setPausa(await apiSuporte.mudarPausa(pausar));
      setErro(null);
    } catch (e) {
      setErro(erroDaApi(e));
    } finally {
      setMudando(false);
    }
  }

  if (!pausa) return erro ? <Aviso texto={`Não consegui ler a pausa do menu: ${erro}`} /> : null;

  const modo = pausa.menu === 'ligado' ? null : pausa.menu === 'seco' ? 'O menu está em modo seco no servidor (não responde nem grava).' : 'O menu está DESLIGADO no servidor (não responde de qualquer jeito).';
  return (
    <div className={`mb-5 rounded-xl p-3 ring-1 ${pausa.pausado ? 'bg-amber-500/10 ring-amber-500/30' : 'bg-zinc-900/60 ring-zinc-800'}`}>
      <div className="flex flex-wrap items-center gap-3">
        {pausa.pausado ? <PiPauseBold className="h-5 w-5 text-amber-300" /> : <PiPlayBold className="h-5 w-5 text-emerald-400" />}
        <div className="min-w-0 flex-1 text-sm">
          {pausa.pausado ? (
            <>
              <p className="font-medium text-amber-200">Menu PAUSADO desde {quando(pausa.desde)}{pausa.por ? ` (${pausa.por === 'telegram' ? 'pelo Telegram' : pausa.por})` : ''}</p>
              <p className="text-xs text-amber-200/80">
                Não responde nem grava ninguém, nem manda o "pode testar?" ao marcar como resolvida. Cerca de {pausa.ignoradas} mensagem(ns) sem resposta até agora: quem escreveu precisa mandar de novo depois que voltar.
              </p>
            </>
          ) : (
            <p className="text-zinc-200">Menu ativo. <span className="text-xs text-zinc-500">Também dá para pausar com /pausar no @ddchamados_bot.</span></p>
          )}
          {modo && <p className="mt-0.5 text-xs text-zinc-400">{modo}</p>}
        </div>
        {pausa.pausado ? (
          <button onClick={() => void mudar(false)} disabled={mudando} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            {mudando ? <PiSpinnerGapBold className="h-4 w-4 animate-spin" /> : <PiPlayBold className="h-4 w-4" />} Retomar
          </button>
        ) : confirmar ? (
          <span className="flex items-center gap-2 text-xs">
            <button onClick={() => void mudar(true)} disabled={mudando} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">
              Pausar mesmo
            </button>
            <button onClick={() => setConfirmar(false)} className="text-zinc-400 hover:text-zinc-200">Cancelar</button>
          </span>
        ) : (
          <button onClick={() => setConfirmar(true)} disabled={mudando} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-amber-200 ring-1 ring-amber-500/40 hover:bg-amber-500/10 disabled:opacity-50">
            <PiPauseBold className="h-4 w-4" /> Pausar
          </button>
        )}
      </div>
      {erro && <p className="mt-2 text-xs text-red-300">{erro}</p>}
    </div>
  );
}

// ─── Demandas ───────────────────────────────────────────────────────────────────────────────────────────

function Demandas() {
  const [lista, setLista] = useState<DemandaSuporte[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('abertas');

  const carregar = useCallback(async () => {
    try {
      const r = await apiSuporte.demandas();
      setLista(r.demandas);
      setErro(null);
    } catch (e) {
      setErro(erroDaApi(e));
    }
  }, []);

  useEffect(() => {
    void carregar();
    const t = setInterval(() => void carregar(), 30_000);
    return () => clearInterval(t);
  }, [carregar]);

  const visiveis = useMemo(() => {
    if (!lista) return [];
    if (filtro === 'abertas') return lista.filter((d) => d.status !== 'resolvida');
    if (filtro === 'resolvidas') return lista.filter((d) => d.status === 'resolvida');
    return lista;
  }, [lista, filtro]);

  const abertas = lista?.filter((d) => d.status !== 'resolvida').length ?? 0;

  return (
    <section>
      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ['abertas', `Abertas (${abertas})`],
            ['resolvidas', 'Resolvidas'],
            ['todas', 'Todas'],
          ] as const
        ).map(([id, rotulo]) => (
          <button
            key={id}
            onClick={() => setFiltro(id)}
            className={`rounded-full px-3 py-1 text-xs ring-1 ${filtro === id ? 'bg-sky-500/15 text-sky-200 ring-sky-500/40' : 'text-zinc-400 ring-zinc-700 hover:text-zinc-200'}`}
          >
            {rotulo}
          </button>
        ))}
      </div>
      {erro && <Aviso texto={`Não consegui carregar: ${erro}`} />}
      {!lista && !erro && <Carregando />}
      {lista && visiveis.length === 0 && <p className="py-10 text-center text-sm text-zinc-500">Nenhuma demanda aqui.</p>}
      <div className="space-y-4">
        {visiveis.map((d) => (
          <CartaoDemanda key={d.protocolo} d={d} aoMudar={carregar} />
        ))}
      </div>
    </section>
  );
}

function CartaoDemanda({ d, aoMudar }: { d: DemandaSuporte; aoMudar: () => Promise<void> }) {
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  const verificacao =
    d.verificacao === 'grupo'
      ? { texto: 'verificada pelo grupo', cor: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' }
      : { texto: d.gruposVistos > 1 ? `não verificada (em ${d.gruposVistos} grupos)` : 'não verificada', cor: 'bg-amber-500/10 text-amber-300 ring-amber-500/30' };

  async function resolver() {
    setEnviando(true);
    setResultado(null);
    try {
      const r = await apiSuporte.resolver(d.protocolo, nota.trim());
      setResultado(r.whatsapp ? (r.perguntou ? 'Avisada no WhatsApp para testar (vai responder 1 ou 2).' : 'Avisada no WhatsApp (sem a pergunta: ela está em outra conversa).') : 'Marcada como resolvida, mas a pessoa NÃO foi avisada no WhatsApp (menu fora do modo ligado, pausado ou envio recusado).');
      setNota('');
      await aoMudar();
    } catch (e) {
      setResultado(`Erro: ${erroDaApi(e)}`);
    } finally {
      setEnviando(false);
    }
  }

  async function reabrir() {
    setEnviando(true);
    try {
      await apiSuporte.reabrir(d.protocolo);
      await aoMudar();
    } catch (e) {
      setResultado(`Erro: ${erroDaApi(e)}`);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <article className="rounded-xl bg-zinc-900/70 p-4 ring-1 ring-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-zinc-100">#{d.protocolo}</span>
        <span className="text-sm text-zinc-300">{d.categoria}</span>
        {d.prioridade && <Selo cor={COR_PRIORIDADE[d.prioridade] ?? COR_PRIORIDADE.pode_esperar!}>{NOME_PRIORIDADE[d.prioridade]}</Selo>}
        {d.status === 'resolvida' && <Selo cor="bg-emerald-500/15 text-emerald-300 ring-emerald-500/30">Resolvida</Selo>}
        {d.status === 'reaberta' && <Selo cor="bg-red-500/15 text-red-300 ring-red-500/30">Reaberta{d.vezesReaberta > 1 ? ` ${d.vezesReaberta}×` : ''}</Selo>}
        <span className="ml-auto text-xs text-zinc-500">
          {quando(d.criadoEm)}
          {d.prazoEm && d.status !== 'resolvida' ? ` · prazo ${quando(d.prazoEm)}` : ''}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="text-zinc-200">{d.nome ?? '(sem nome)'}</span>
        <span>· {d.unidadeSlug ?? 'unidade não informada'}</span>
        {d.numero && <span>· {d.numero}</span>}
        <Selo cor={verificacao.cor}>{verificacao.texto}</Selo>
      </div>

      <p className="mt-3 whitespace-pre-wrap rounded-lg bg-zinc-950/60 p-3 text-sm text-zinc-200 ring-1 ring-zinc-800">{d.relato}</p>

      {d.analise ? (
        <div className="mt-3 rounded-lg bg-sky-500/5 p-3 ring-1 ring-sky-500/20">
          <p className="text-sm text-sky-100">
            <span className="font-medium">Análise:</span> {d.analise.resumo}
          </p>
          {d.analise.hipoteses.length > 0 && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-300">
              {d.analise.hipoteses.map((h, i) => (
                <li key={i}>
                  {h.causa} <span className={`text-xs ${COR_CONFIANCA[h.confianca] ?? ''}`}>(confiança {h.confianca})</span>
                  {h.evidencia && <span className="block text-xs text-zinc-500">{h.evidencia}</span>}
                </li>
              ))}
            </ol>
          )}
          {d.analise.conferir.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-zinc-400">
              {d.analise.conferir.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      ) : d.analiseFalha ? (
        <Aviso texto={`A análise não saiu: ${d.analiseFalha}`} />
      ) : (
        <p className="mt-3 text-xs text-zinc-500">Sem análise automática (desligada ou ainda rodando).</p>
      )}

      <BlocoDoAgente d={d} aoMudar={aoMudar} />

      <div className="mt-4 border-t border-zinc-800 pt-3">
        {d.status === 'resolvida' ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
            <PiCheckCircleBold className="h-4 w-4 text-emerald-400" />
            <span>
              Resolvida por {d.resolvidaPor ?? '—'} em {quando(d.resolvidaEm)}
              {d.notaResolucao ? ` — “${d.notaResolucao}”` : ''}
            </span>
            <button onClick={() => void reabrir()} disabled={enviando} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-zinc-300 ring-1 ring-zinc-700 hover:bg-zinc-800 disabled:opacity-50">
              <PiArrowCounterClockwiseBold className="h-3.5 w-3.5" /> Reabrir
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <textarea
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              maxLength={600}
              rows={2}
              placeholder="Nota para a pessoa (opcional): o que foi feito, o que testar…"
              className="min-h-[2.5rem] flex-1 rounded-lg bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:ring-sky-500/60"
            />
            <button
              onClick={() => void resolver()}
              disabled={enviando}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {enviando ? <PiSpinnerGapBold className="h-4 w-4 animate-spin" /> : <PiCheckCircleBold className="h-4 w-4" />}
              Resolvido — avisar para testar
            </button>
          </div>
        )}
        {resultado && <p className="mt-2 text-xs text-zinc-400">{resultado}</p>}
      </div>
    </article>
  );
}

// ─── o agente (Claude Code 24 h na VPS) ──────────────────────────────────────────────────────────────

const NOME_STATUS_AGENTE: Record<string, string> = {
  fila: 'na fila do agente',
  trabalhando: 'o agente está trabalhando',
  feito: 'o agente terminou',
  falhou: 'o agente não concluiu',
};

function BlocoDoAgente({ d, aoMudar }: { d: DemandaSuporte; aoMudar: () => Promise<void> }) {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const c = d.claude;
  const podeMandar = d.status !== 'resolvida' && (!c || c.status === 'feito' || c.status === 'falhou');

  async function mandar() {
    setEnviando(true);
    setErro(null);
    try {
      await apiSuporte.mandarParaClaude(d.protocolo);
      await aoMudar();
    } catch (e) {
      setErro(erroDaApi(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg bg-violet-500/5 p-3 ring-1 ring-violet-500/20">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <PiRobotBold className="h-4 w-4 text-violet-300" />
        <span className="text-violet-100">{c ? NOME_STATUS_AGENTE[c.status] : 'O agente ainda não pegou esta demanda.'}</span>
        {c?.status === 'trabalhando' && <PiSpinnerGapBold className="h-4 w-4 animate-spin text-violet-300" />}
        {c?.autorizadoPor && <span className="text-xs text-zinc-500">({c.autorizadoPor === 'grupo' ? 'entrou sozinha: número verificado' : `mandada por ${c.autorizadoPor}`})</span>}
        {podeMandar && (
          <button onClick={() => void mandar()} disabled={enviando} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-violet-200 ring-1 ring-violet-500/40 hover:bg-violet-500/10 disabled:opacity-50">
            {enviando ? <PiSpinnerGapBold className="h-3.5 w-3.5 animate-spin" /> : <PiRobotBold className="h-3.5 w-3.5" />}
            {c ? 'Mandar de novo para o Claude' : 'Mandar para o Claude'}
          </button>
        )}
      </div>
      {c?.resumo && <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{c.resumo}</p>}
      {c?.prUrl && (
        <a href={c.prUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-sky-300 hover:underline">
          <PiArrowSquareOutBold className="h-4 w-4" /> PR para revisar e mesclar
        </a>
      )}
      {c?.oQueFazer && (
        <p className="mt-2 text-sm text-amber-200">
          <span className="font-medium">O que uma pessoa precisa fazer:</span> {c.oQueFazer}
        </p>
      )}
      {erro && <p className="mt-2 text-xs text-red-300">{erro}</p>}
    </div>
  );
}

// ─── Base de conhecimento ───────────────────────────────────────────────────────────────────────────────

function Base() {
  const [itens, setItens] = useState<ItemConhecimento[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [novo, setNovo] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setItens(await apiSuporte.conhecimento());
      setErro(null);
    } catch (e) {
      setErro(erroDaApi(e));
    }
  }, []);
  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <section>
      <p className="mb-4 text-sm text-zinc-400">
        A IA lê estes itens antes de analisar cada demanda. Escreva a <b className="text-zinc-300">causa</b>, como reconhecer e o que fazer. Item desligado não é lido.
      </p>
      {erro && <Aviso texto={`Não consegui carregar: ${erro}`} />}
      {!itens && !erro && <Carregando />}
      <div className="space-y-3">
        {novo ? (
          <EditorItem
            aoSalvar={async (t, x) => {
              await apiSuporte.criarConhecimento({ titulo: t, texto: x });
              setNovo(false);
              await carregar();
            }}
            aoCancelar={() => setNovo(false)}
          />
        ) : (
          <button onClick={() => setNovo(true)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-sky-300 ring-1 ring-sky-500/30 hover:bg-sky-500/10">
            <PiPlusBold className="h-4 w-4" /> Novo item
          </button>
        )}
        {itens?.map((it) => (
          <ItemDaBase key={it.id} it={it} aoMudar={carregar} />
        ))}
      </div>
    </section>
  );
}

function ItemDaBase({ it, aoMudar }: { it: ItemConhecimento; aoMudar: () => Promise<void> }) {
  const [editando, setEditando] = useState(false);
  const [confirmarApagar, setConfirmarApagar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const acao = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setErro(null);
      await aoMudar();
    } catch (e) {
      setErro(erroDaApi(e));
    }
  };

  if (editando) {
    return (
      <EditorItem
        inicial={it}
        aoSalvar={async (t, x) => {
          await apiSuporte.editarConhecimento(it.id, { titulo: t, texto: x });
          setEditando(false);
          await aoMudar();
        }}
        aoCancelar={() => setEditando(false)}
      />
    );
  }
  return (
    <article className={`rounded-xl p-4 ring-1 ${it.ativo ? 'bg-zinc-900/70 ring-zinc-800' : 'bg-zinc-900/30 ring-zinc-800/60 opacity-60'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-zinc-100">{it.titulo}</h3>
        {!it.ativo && <Selo cor="bg-zinc-500/15 text-zinc-400 ring-zinc-500/30">desligado</Selo>}
        <div className="ml-auto flex items-center gap-1">
          <label className="flex cursor-pointer items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={it.ativo} onChange={(e) => void acao(() => apiSuporte.editarConhecimento(it.id, { ativo: e.target.checked }))} />
            a IA lê
          </label>
          <button onClick={() => setEditando(true)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" title="Editar">
            <PiPencilSimpleLineBold className="h-4 w-4" />
          </button>
          {confirmarApagar ? (
            <span className="flex items-center gap-1 text-xs">
              <button onClick={() => void acao(() => apiSuporte.apagarConhecimento(it.id))} className="rounded px-2 py-1 text-red-300 ring-1 ring-red-500/40 hover:bg-red-500/10">
                Apagar mesmo
              </button>
              <button onClick={() => setConfirmarApagar(false)} className="rounded px-2 py-1 text-zinc-400 hover:text-zinc-200">
                Cancelar
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirmarApagar(true)} className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-300" title="Apagar">
              <PiTrashBold className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{it.texto}</p>
      <p className="mt-2 text-[11px] text-zinc-500">
        {it.autor ?? '—'} · atualizado {quando(it.atualizadoEm)}
      </p>
      {erro && <Aviso texto={erro} />}
    </article>
  );
}

function EditorItem({ inicial, aoSalvar, aoCancelar }: { inicial?: ItemConhecimento; aoSalvar: (titulo: string, texto: string) => Promise<void>; aoCancelar: () => void }) {
  const [titulo, setTitulo] = useState(inicial?.titulo ?? '');
  const [texto, setTexto] = useState(inicial?.texto ?? '');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <div className="rounded-xl bg-zinc-900 p-4 ring-1 ring-sky-500/30">
      <input
        value={titulo}
        onChange={(e) => setTitulo(e.target.value)}
        maxLength={120}
        placeholder="Título (ex.: Kommo em modo só leitura)"
        className="w-full rounded-lg bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 focus:outline-none focus:ring-sky-500/60"
      />
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        maxLength={2000}
        rows={5}
        placeholder="A causa, como reconhecer (o que aparece no log ou no cartão) e o que fazer."
        className="mt-2 w-full rounded-lg bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 focus:outline-none focus:ring-sky-500/60"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={salvando || !titulo.trim() || !texto.trim()}
          onClick={async () => {
            setSalvando(true);
            try {
              await aoSalvar(titulo.trim(), texto.trim());
            } catch (e) {
              setErro(erroDaApi(e));
            } finally {
              setSalvando(false);
            }
          }}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
        <button onClick={aoCancelar} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
          Cancelar
        </button>
        <span className="ml-auto text-[11px] text-zinc-500">{texto.length}/2000</span>
      </div>
      {erro && <Aviso texto={erro} />}
    </div>
  );
}

function Aviso({ texto }: { texto: string }) {
  return (
    <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200 ring-1 ring-amber-500/30">
      <PiWarningBold className="mt-0.5 h-4 w-4 shrink-0" />
      {texto}
    </p>
  );
}

function Carregando() {
  return (
    <p className="flex items-center gap-2 py-10 text-sm text-zinc-500">
      <PiSpinnerGapBold className="h-4 w-4 animate-spin" /> Carregando…
    </p>
  );
}
