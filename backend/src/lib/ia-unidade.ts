/**
 * Página `/ia/:slug` — a recepção vê, no celular, se a Sofia e as colunas do Kommo estão certas
 * (pedido de Timbó, 04/11/2026: "a IA está fazendo os processos certos? colocando nas colunas certas?").
 *
 * Esta é a parte PURA: as regras do "Conferir", o agrupamento de quem mudou a coluna, a contagem por coluna e o
 * cache que aguenta falha. Quem lê o Kommo e o banco é `controllers/ia-unidade.controller.ts`. Nada aqui escreve
 * em lugar nenhum e nada aqui tem id de etapa ou de campo chumbado: etapas e campos são achados PELO NOME, por
 * conta (os ids mudam de conta para conta — já tivemos bug de id de outra unidade).
 */
import { normalizarNome } from './kommo-schema.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { CAMPO } from './parados.js';
import { ETAPA } from './franquia-move.js';
import { ehDaConsultoria } from './responsavel-da-tarefa.js';
import { epochDoValor, valorDoCampo, type CampoDoCartao } from './ponte-fila.js';

// ── prazos e tetos: todos aqui, para o revisor ver de uma vez ─────────────────────────────────────────────

export const PRAZOS_DA_PAGINA_IA = Object.freeze({
  /** AGENDADO com a consulta passada há mais que isto pede "compareceu ou não compareceu". */
  consultaPassadaHoras: 12,
  /** EM QUALIFICAÇÃO sem campo nenhum e sem mexer há mais que isto vira "cartão vazio". */
  cartaoVazioDias: 7,
  /** Quantos itens de cada grupo do Conferir aparecem (o total sempre aparece inteiro). */
  maxPorGrupo: 15,
  /** Exemplos do grupo "cartão vazio" (Timbó tem ~560): só o número e poucos exemplos. */
  maxExemplosVazios: 5,
  /** Mudanças de coluna listadas (a contagem por autor considera todas as lidas). */
  maxMudancasNaLista: 30,
  /** O Kommo é lido no máximo uma vez a cada N ms por conta (a Sofia divide o limitador com esta página). */
  cacheKommoMs: 5 * 60_000,
  /** Depois de uma falha do Kommo, não pergunta de novo antes de N ms. */
  cacheFalhaMs: 60_000,
  /** Páginas de 250 cartões abertos lidas, no máximo (12 = 3.000 cartões; Cerquilho tem ~2.900, 27 s no Kommo). */
  maxPaginasDeCartoes: 12,
  /** Páginas de 100 mudanças de coluna lidas, no máximo (3 = 300 mudanças no dia). */
  maxPaginasDeMudancas: 3,
  /** A montagem inteira desiste depois disto (ela roda por trás: quem pede não fica esperando tanto). */
  prazoDaMontagemMs: 60_000,
  /** Quem abre a página espera no máximo isto pela leitura do Kommo; passou, vê "lendo…" e a página pergunta de novo. */
  esperaDoPedidoMs: 12_000,
  /** Mudança de coluna e passo da Sofia no banco são "o mesmo fato" se distam menos que isto. */
  folgaDoCasamentoSeg: 120,
});

// ── datas no fuso da unidade ──────────────────────────────────────────────────────────────────────────────

/** Segundos do fuso (UTC − local) no instante dado: o inverso do deslocamento, para achar a meia-noite local. */
function deslocamentoMs(instante: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instante));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const comoUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return comoUtc - Math.floor(instante / 1000) * 1000;
}

/** O instante (epoch em SEGUNDOS) em que o dia de `agora` começou, no fuso da unidade. */
export function inicioDoDiaEpoch(agora: Date, tz: string): number {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora);
  const g = (t: string) => Number(partes.find((x) => x.type === t)?.value ?? 0);
  const meiaNoiteComoUtc = Date.UTC(g('year'), g('month') - 1, g('day'), 0, 0, 0);
  // duas passadas: a primeira estima, a segunda corrige se o deslocamento mudou (horário de verão)
  let instante = meiaNoiteComoUtc - deslocamentoMs(meiaNoiteComoUtc, tz);
  instante = meiaNoiteComoUtc - deslocamentoMs(instante, tz);
  return Math.floor(instante / 1000);
}

/** "14:05" no fuso da unidade. */
export function horaCurta(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(epoch * 1000));
}

// ── o cartão, como a página o enxerga ─────────────────────────────────────────────────────────────────────

export interface CartaoDaPagina {
  id: number;
  nome: string;
  /** nome da coluna (como está no Kommo) */
  etapa: string;
  /** o cartão está no funil COMERCIAL (as regras do Conferir só valem lá) */
  comercial: boolean;
  atualizadoEpoch: number | null;
  /** "◷ Data da Consulta" */
  consultaEpoch: number | null;
  /** "✓ Situação da consulta" */
  situacao: string | null;
  /** "◷ Retomar em" */
  retomarEmEpoch: number | null;
  /** algum campo personalizado com valor */
  temCampo: boolean;
}

type CampoComValores = CampoDoCartao & { values?: ReadonlyArray<{ value?: unknown }> | null };

const valorPreenchido = (v: unknown): boolean => v !== null && v !== undefined && v !== '' && v !== false;

export function cartaoDaPagina(
  lead: { id: number; name?: string | null; updated_at?: number; custom_fields_values?: ReadonlyArray<CampoComValores> | null },
  etapa: string,
  comercial: boolean,
): CartaoDaPagina {
  const campos = lead.custom_fields_values ?? [];
  const situacao = valorDoCampo(campos, CAMPOS_SYNC.SITUACAO);
  return {
    id: lead.id,
    nome: (lead.name ?? '').trim() || `Cartão ${lead.id}`,
    etapa,
    comercial,
    atualizadoEpoch: lead.updated_at ?? null,
    consultaEpoch: epochDoValor(valorDoCampo(campos, CAMPOS_SYNC.DATA_CONSULTA)),
    situacao: situacao == null || situacao === '' ? null : String(situacao),
    retomarEmEpoch: epochDoValor(valorDoCampo(campos, CAMPO.RETOMAR_EM)),
    temCampo: campos.some((c) => (c.values ?? []).some((v) => valorPreenchido(v?.value))),
  };
}

// ── ⚠ Conferir ────────────────────────────────────────────────────────────────────────────────────────────

export type RegraDoConferir = 'consulta_passada' | 'atendido_fora' | 'desmarcado_fora' | 'espera_sem_data' | 'cartao_vazio';

export interface ItemDoConferir {
  leadId: number;
  nome: string;
  /** o que fazer, em português simples */
  oQueFazer: string;
}

export interface GrupoDoConferir {
  regra: RegraDoConferir;
  titulo: string;
  total: number;
  itens: ItemDoConferir[];
}

const ordemDosGrupos: RegraDoConferir[] = ['consulta_passada', 'atendido_fora', 'desmarcado_fora', 'espera_sem_data', 'cartao_vazio'];

const TITULOS: Record<RegraDoConferir, string> = {
  consulta_passada: 'Consulta já passou e o cartão continua em AGENDADO',
  atendido_fora: 'Paciente já foi atendido, mas o cartão não está em COMPARECEU',
  desmarcado_fora: 'Consulta desmarcada, mas o cartão não está em EM ESPERA',
  espera_sem_data: 'Em EM ESPERA sem data para retomar',
  cartao_vazio: 'Cartões vazios e parados em EM QUALIFICAÇÃO',
};

const n = normalizarNome;
const E = {
  agendado: n(ETAPA.AGENDADO),
  qualificacao: n(ETAPA.QUALIFICACAO),
  espera: n(ETAPA.ESPERA),
  desmarcou: n('DESMARCOU'),
  perdido: n(ETAPA.PERDIDO),
};

/** Ids dos cartões que o Conferir chamaria de "vazios e parados": o controller consulta o banco só para estes. */
export function candidatosCartaoVazio(cartoes: readonly CartaoDaPagina[], agora: Date): number[] {
  const limite = Math.floor(agora.getTime() / 1000) - PRAZOS_DA_PAGINA_IA.cartaoVazioDias * 86_400;
  return cartoes.filter((c) => c.comercial && n(c.etapa) === E.qualificacao && !c.temCampo && (c.atualizadoEpoch ?? 0) < limite).map((c) => c.id);
}

/**
 * As regras do Conferir. Cada cartão cai em NO MÁXIMO uma, na ordem mais específica primeiro: "atendido" e
 * "desmarcado" dizem mais do que "a data passou". Só olha o funil COMERCIAL.
 *
 * - `etapasDaConta`: nomes das colunas do funil comercial desta conta. Serve para o texto não mandar mover para
 *   uma coluna que a conta não tem (Timbó não tem DESMARCOU; Cerquilho tem).
 * - `comConversaRecente`: cartões (candidatos a "vazio") em que a Sofia conversou nos últimos dias — têm mensagem,
 *   então não são vazios.
 */
export function conferir(
  cartoes: readonly CartaoDaPagina[],
  contexto: { agora: Date; etapasDaConta: readonly string[]; comConversaRecente?: ReadonlySet<number> },
): { total: number; grupos: GrupoDoConferir[] } {
  const agoraEpoch = Math.floor(contexto.agora.getTime() / 1000);
  const existentes = new Set(contexto.etapasDaConta.map(n));
  const destinoDoDesmarcado = [existentes.has(E.espera) ? ETAPA.ESPERA : null, existentes.has(E.desmarcou) ? 'DESMARCOU' : null].filter((x): x is string => !!x);
  const textoDestino = destinoDoDesmarcado.length ? destinoDoDesmarcado.join(' ou ') : 'EM ESPERA';
  const passadoDaConsulta = agoraEpoch - PRAZOS_DA_PAGINA_IA.consultaPassadaHoras * 3600;
  const vaziosLimite = agoraEpoch - PRAZOS_DA_PAGINA_IA.cartaoVazioDias * 86_400;

  const achados = new Map<RegraDoConferir, Array<ItemDoConferir & { ordem: number }>>();
  const add = (regra: RegraDoConferir, c: CartaoDaPagina, oQueFazer: string, ordem: number) => {
    const l = achados.get(regra) ?? [];
    l.push({ leadId: c.id, nome: c.nome, oQueFazer, ordem });
    achados.set(regra, l);
  };

  for (const c of cartoes) {
    if (!c.comercial) continue;
    const etapa = n(c.etapa);
    const situacao = c.situacao ? n(c.situacao) : '';
    if (situacao === 'atendido' && (etapa === E.agendado || etapa === E.qualificacao)) {
      add('atendido_fora', c, 'Mover para COMPARECEU.', c.consultaEpoch ?? c.atualizadoEpoch ?? 0);
    } else if (situacao === 'desmarcado' && etapa !== E.espera && etapa !== E.desmarcou && etapa !== E.perdido) {
      add('desmarcado_fora', c, `Mover para ${textoDestino}.`, c.atualizadoEpoch ?? 0);
    } else if (etapa === E.agendado && c.consultaEpoch !== null && c.consultaEpoch < passadoDaConsulta) {
      add('consulta_passada', c, 'Marcar COMPARECEU ou NÃO COMPARECEU.', c.consultaEpoch);
    } else if (etapa === E.espera && c.retomarEmEpoch === null) {
      add('espera_sem_data', c, 'Preencher a data de retomada (◷ Retomar em).', c.atualizadoEpoch ?? 0);
    } else if (
      etapa === E.qualificacao &&
      !c.temCampo &&
      (c.atualizadoEpoch ?? 0) < vaziosLimite &&
      !contexto.comConversaRecente?.has(c.id)
    ) {
      add('cartao_vazio', c, 'Cartão vazio e parado: fechar ou conferir.', c.atualizadoEpoch ?? 0);
    }
  }

  const grupos: GrupoDoConferir[] = [];
  for (const regra of ordemDosGrupos) {
    const l = achados.get(regra);
    if (!l?.length) continue;
    // os mais antigos primeiro: são os que estão esquecidos há mais tempo
    l.sort((a, b) => a.ordem - b.ordem || a.leadId - b.leadId);
    const teto = regra === 'cartao_vazio' ? PRAZOS_DA_PAGINA_IA.maxExemplosVazios : PRAZOS_DA_PAGINA_IA.maxPorGrupo;
    grupos.push({
      regra,
      titulo: TITULOS[regra],
      total: l.length,
      itens: l.slice(0, teto).map(({ leadId, nome, oQueFazer }) => ({ leadId, nome, oQueFazer })),
    });
  }
  return { total: grupos.reduce((s, g) => s + g.total, 0), grupos };
}

// ── cartões por coluna ───────────────────────────────────────────────────────────────────────────────────

export interface FunilParaContar {
  id: number;
  name: string;
  is_archive?: boolean;
  is_main?: boolean;
  statuses: ReadonlyArray<{ id: number; name: string; sort?: number }>;
}

/** 142 = ganho e 143 = perdido em TODO funil do Kommo: cartão ali está fechado, não conta como "aberto". */
export const STATUS_FECHADOS: ReadonlySet<number> = new Set([142, 143]);

/** As colunas abertas de todos os funis vivos da conta, para pedir ao Kommo. */
export function etapasAbertas(funis: readonly FunilParaContar[]): Array<{ pipelineId: number; statusId: number }> {
  return funis.filter((f) => !f.is_archive).flatMap((f) => f.statuses.filter((s) => !STATUS_FECHADOS.has(s.id)).map((s) => ({ pipelineId: f.id, statusId: s.id })));
}

export interface ColunasDoFunil {
  funil: string;
  total: number;
  etapas: Array<{ nome: string; total: number }>;
}

/** Conta os cartões lidos em cada coluna aberta, na ordem do Kommo (o COMERCIAL primeiro). Coluna sem cartão aparece com 0. */
export function contarPorColuna(leads: ReadonlyArray<{ pipeline_id: number; status_id: number }>, funis: readonly FunilParaContar[]): ColunasDoFunil[] {
  const contagem = new Map<string, number>();
  for (const l of leads) contagem.set(`${l.pipeline_id}:${l.status_id}`, (contagem.get(`${l.pipeline_id}:${l.status_id}`) ?? 0) + 1);
  const vivos = funis.filter((f) => !f.is_archive);
  const comercialPrimeiro = [...vivos].sort((a, b) => Number(n(b.name) === 'comercial') - Number(n(a.name) === 'comercial'));
  return comercialPrimeiro.map((f) => {
    const etapas = f.statuses
      .filter((s) => !STATUS_FECHADOS.has(s.id))
      .slice()
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map((s) => ({ nome: s.name, total: contagem.get(`${f.id}:${s.id}`) ?? 0 }));
    return { funil: f.name, total: etapas.reduce((x, e) => x + e.total, 0), etapas };
  });
}

// ── quem mudou a coluna ──────────────────────────────────────────────────────────────────────────────────

export type TipoDeAutor = 'equipe' | 'ia' | 'robo' | 'consultoria';

export interface MudancaLida {
  leadId: number;
  nome: string | null;
  /** `created_by` do Kommo: 0 = integração/robô */
  por: number;
  em: number;
  de: { pipelineId: number; statusId: number } | null;
  para: { pipelineId: number; statusId: number } | null;
}

/** Uma mudança de coluna que o NOSSO banco registrou como feita pela Sofia (passo "Lead movido para etapa N"). */
export interface MovimentoDaIa {
  leadId: number;
  statusId: number;
  /** epoch em segundos */
  em: number;
}

export interface Autor {
  tipo: TipoDeAutor;
  /** o que aparece na tela */
  nome: string;
}

const ROTULO_IA = 'Sofia (IA)';
const ROTULO_ROBO = 'Robô automático (franquia, rotinas ou Kommo)';
const ROTULO_CONSULTORIA = 'Doutor Digital (consultoria)';

/**
 * Quem fez a mudança. O Kommo só diz `created_by`, e TODA integração (a Sofia, o sincronizador da franquia, os
 * gatilhos) chega como 0 — por isso a Sofia é reconhecida pelo NOSSO banco: um passo "Lead movido para etapa" do
 * mesmo cartão, para a mesma coluna, a poucos segundos do evento. Sem esse par, 0 é "robô automático" (franquia ou
 * automação do Kommo; a API não separa os dois). Usuário com nome = alguém da equipe; o login da consultoria
 * ("Doutor Digital") aparece separado para não passar por recepcionista.
 */
export function autorDaMudanca(m: MudancaLida, usuarios: ReadonlyMap<number, string>, movimentosDaIa: readonly MovimentoDaIa[]): Autor {
  const alvo = m.para?.statusId;
  const casou = movimentosDaIa.some(
    (x) => x.leadId === m.leadId && x.statusId === alvo && Math.abs(x.em - m.em) <= PRAZOS_DA_PAGINA_IA.folgaDoCasamentoSeg,
  );
  if (casou) return { tipo: 'ia', nome: ROTULO_IA };
  if (m.por === 0) return { tipo: 'robo', nome: ROTULO_ROBO };
  const nome = usuarios.get(m.por);
  if (!nome) return { tipo: 'equipe', nome: 'Alguém da equipe (usuário removido)' };
  if (ehDaConsultoria({ id: m.por, name: nome })) return { tipo: 'consultoria', nome: ROTULO_CONSULTORIA };
  return { tipo: 'equipe', nome };
}

export interface ResumoDasMudancas {
  total: number;
  /** quantas mudanças de cada tipo de autor */
  porTipo: Array<{ tipo: TipoDeAutor; rotulo: string; total: number }>;
  /** a equipe, pessoa por pessoa */
  pessoas: Array<{ nome: string; total: number }>;
  /** as mais recentes (teto `maxMudancasNaLista`) */
  lista: Array<{ leadId: number; paciente: string; de: string; para: string; quem: string; tipo: TipoDeAutor; hora: string }>;
}

const ROTULO_TIPO: Record<TipoDeAutor, string> = {
  equipe: 'Equipe da unidade',
  ia: ROTULO_IA,
  robo: ROTULO_ROBO,
  consultoria: ROTULO_CONSULTORIA,
};

export function resumirMudancas(
  mudancas: readonly MudancaLida[],
  contexto: {
    usuarios: ReadonlyMap<number, string>;
    movimentosDaIa: readonly MovimentoDaIa[];
    /** (funil, coluna) → nome da coluna; `null` quando a coluna não existe mais */
    nomeDaColuna: (pipelineId: number, statusId: number) => string | null;
    tz: string;
  },
): ResumoDasMudancas {
  const porTipo = new Map<TipoDeAutor, number>();
  const pessoas = new Map<string, number>();
  const classificadas = mudancas
    .filter((m) => m.para !== null)
    .map((m) => ({ m, autor: autorDaMudanca(m, contexto.usuarios, contexto.movimentosDaIa) }));
  for (const { autor } of classificadas) {
    porTipo.set(autor.tipo, (porTipo.get(autor.tipo) ?? 0) + 1);
    if (autor.tipo === 'equipe') pessoas.set(autor.nome, (pessoas.get(autor.nome) ?? 0) + 1);
  }
  const ordemTipos: TipoDeAutor[] = ['equipe', 'ia', 'robo', 'consultoria'];
  const nomeCol = (e: { pipelineId: number; statusId: number } | null) => (e ? (contexto.nomeDaColuna(e.pipelineId, e.statusId) ?? 'coluna removida') : '—');
  const recentes = [...classificadas].sort((a, b) => b.m.em - a.m.em).slice(0, PRAZOS_DA_PAGINA_IA.maxMudancasNaLista);
  return {
    total: classificadas.length,
    porTipo: ordemTipos.filter((t) => porTipo.has(t)).map((t) => ({ tipo: t, rotulo: ROTULO_TIPO[t], total: porTipo.get(t) ?? 0 })),
    pessoas: [...pessoas.entries()].map(([nome, total]) => ({ nome, total })).sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR')),
    lista: recentes.map(({ m, autor }) => ({
      leadId: m.leadId,
      paciente: (m.nome ?? '').trim() || `Cartão ${m.leadId}`,
      de: nomeCol(m.de),
      para: nomeCol(m.para),
      quem: autor.nome,
      tipo: autor.tipo,
      hora: horaCurta(m.em, contexto.tz),
    })),
  };
}

// ── cache que aguenta falha ──────────────────────────────────────────────────────────────────────────────

export type LeituraComCache<T> =
  | { ok: true; valor: T; lidoEm: number; desatualizado: false }
  /** falhou agora, mas há uma leitura boa antiga: mostra com aviso */
  | { ok: true; valor: T; lidoEm: number; desatualizado: true; motivo: string }
  | { ok: false; motivo: string };

/**
 * Guarda o último resultado BOM por chave por `ttlMs`; falha guarda-se por `ttlFalhaMs` (não pergunta de novo ao Kommo
 * a cada toque no botão "Atualizar"). Com falha e uma leitura boa antiga, devolve a antiga marcada `desatualizado`.
 * Várias pessoas pedindo juntas viram UMA ida ao Kommo (a mesma promessa). `agora` é injetável para teste.
 */
export class CacheQueAguentaFalha<T> {
  private readonly bom = new Map<string, { em: number; valor: T; ttl: number }>();
  private readonly falha = new Map<string, { em: number; motivo: string }>();
  private readonly emAndamento = new Map<string, Promise<LeituraComCache<T>>>();

  constructor(
    private readonly ttlMs: number,
    private readonly ttlFalhaMs: number,
    private readonly agora: () => number = Date.now,
    private readonly maxChaves = 200,
  ) {}

  /** `ttlDoValor` deixa uma leitura incompleta valer menos que uma inteira. */
  async obter(chave: string, ler: () => Promise<T>, ttlDoValor?: (valor: T) => number): Promise<LeituraComCache<T>> {
    const t = this.agora();
    const b = this.bom.get(chave);
    if (b && t - b.em < b.ttl) return { ok: true, valor: b.valor, lidoEm: b.em, desatualizado: false };
    const f = this.falha.get(chave);
    if (f && t - f.em < this.ttlFalhaMs) return this.semLeituraNova(b, f.motivo);
    const andando = this.emAndamento.get(chave);
    if (andando) return andando;
    const p = (async (): Promise<LeituraComCache<T>> => {
      try {
        const valor = await ler();
        if (this.bom.size >= this.maxChaves) this.bom.clear();
        const em = this.agora();
        this.bom.set(chave, { em, valor, ttl: ttlDoValor ? ttlDoValor(valor) : this.ttlMs });
        this.falha.delete(chave);
        return { ok: true, valor, lidoEm: em, desatualizado: false };
      } catch (err) {
        const motivo = err instanceof Error ? err.message : String(err);
        if (this.falha.size >= this.maxChaves) this.falha.clear();
        this.falha.set(chave, { em: this.agora(), motivo });
        return this.semLeituraNova(this.bom.get(chave), motivo);
      } finally {
        this.emAndamento.delete(chave);
      }
    })();
    this.emAndamento.set(chave, p);
    return p;
  }

  /** A última leitura boa da chave, mesmo vencida (nunca consulta o Kommo). */
  espiar(chave: string): { valor: T; lidoEm: number } | null {
    const b = this.bom.get(chave);
    return b ? { valor: b.valor, lidoEm: b.em } : null;
  }

  private semLeituraNova(antiga: { em: number; valor: T; ttl: number } | undefined, motivo: string): LeituraComCache<T> {
    return antiga ? { ok: true, valor: antiga.valor, lidoEm: antiga.em, desatualizado: true, motivo } : { ok: false, motivo };
  }
}

/**
 * Fila de UM: as montagens que falam com o Kommo (de qualquer unidade) rodam uma de cada vez. Sem isto, três
 * recepções abrindo a página juntas disputariam o limitador com a Sofia; em fila, cada chamada da Sofia espera,
 * no pior caso, uma chamada desta página, nunca uma rajada.
 */
export function criarFilaDeUm(): <T>(tarefa: () => Promise<T>) => Promise<T> {
  let cauda: Promise<unknown> = Promise.resolve();
  return <T>(tarefa: () => Promise<T>): Promise<T> => {
    const rodando = cauda.then(tarefa, tarefa);
    cauda = rodando.catch(() => undefined);
    return rodando;
  };
}
