/**
 * "Esse telefone já está na franquia (como lead OU como paciente)?" — a checagem de duplicado de ANTES de criar o lead
 * no cadastro de todo lead no 1º contato (27/11/2026, chave `cadastro-lead-primeiro-contato`).
 *
 * Por que isto existe: a recepção cadastra paciente e lead à mão, e a franquia não impede o duplicado. Quando a Sofia passa a
 * cadastrar TODO lead no primeiro contato, a secretária que cadastrou primeiro não pode ganhar um segundo cadastro do mesmo telefone.
 *
 * COMO SE PROCURA: a franquia ignora filtro de telefone (`/api/clients/search` só filtra nome, `/api/leads/search` só janela de datas),
 * então a busca é feita do nosso lado, em duas camadas:
 *  1. o ÍNDICE de telefones da unidade (`franquia-indice-telefones.ts`: a base inteira lida página a página, até 20 h de idade). Achou
 *     o telefone = existe, e isso vale mesmo com índice velho (prova positiva não envelhece);
 *  2. o que a recepção cadastrou DEPOIS da última carga: os leads dos últimos dias (janela de datas) e as 2 últimas páginas de
 *     pacientes (a franquia devolve do mais antigo ao mais novo). Fica em memória 5 min por unidade — dez leads em rajada
 *     fazem uma leitura, não dez.
 *
 * NA DÚVIDA, NÃO CRIA. Índice ausente/velho/cortado, banco fora, franquia fora, telefone sem 8 dígitos, página que não cabe no teto:
 * tudo isso é `indeterminado`, e quem chama NÃO cria e tenta no próximo turno. Só um índice inteiro e fresco (< 36 h) mais a leitura
 * dos recentes sem erro autorizam "não está em lugar nenhum".
 *
 * A chave é os 8 últimos dígitos — com ou sem 55, com ou sem o nono dígito, o mesmo número casa (`chaveDoTelefone`).
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { agendarIndice, chaveDoTelefone, consultarIndice, type Entrada, type RespostaDoIndice } from './franquia-indice-telefones.js';
import { chaveDaFranquia } from './franquia-espacamento.js';
import { paginaDeTelefones, type SpineResult, type SpinePaginaTelefones } from '../services/spine.service.js';

export type JaCadastrado =
  | {
      tipo: 'achou'; origem: 'paciente' | 'lead'; id: number; por: 'indice' | 'recentes';
      /** Quando o cadastro nasceu na franquia (só o índice sabe): estreita a busca do nome do lead. */
      criado?: Date;
      /** O nome com que NÓS criamos este lead (só quando é o que acabamos de criar): dispensa ir buscá-lo na franquia. */
      nome?: string;
    }
  | { tipo: 'nao' }
  | { tipo: 'indeterminado'; motivo: string };

/** Os cadastros recentes da franquia, por telefone (chave de 8 dígitos). */
export type Recentes = Map<string, { origem: 'paciente' | 'lead'; id: number }>;

export interface DepsJaCadastrado {
  indice(unitId: string, chave: string): Promise<RespostaDoIndice>;
  agendarIndice(unit: Unit): void;
  /** Lê os cadastros recentes da franquia. Lança se algo falhar (quem chama trata como indeterminado). */
  recentes(unit: Unit): Promise<Recentes>;
}

/** Quantos dias para trás os leads recentes são lidos (o índice é refeito a cada 20 h; sobra folga para o fuso e para uma carga atrasada). */
export const DIAS_DE_LEADS_RECENTES = 3;
/** Quantas páginas, no máximo, da janela de leads recentes (500 leads em 3 dias numa unidade só já é fora do normal). */
export const MAX_PAGINAS_DE_LEADS_RECENTES = 5;
export const VALIDADE_DOS_RECENTES_MS = 5 * 60_000;

const DIA_MS = 86_400_000;
const dia = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type BuscarPagina = (unit: Unit, e: Parameters<typeof paginaDeTelefones>[1], page: number) => Promise<SpineResult<SpinePaginaTelefones>>;

async function ler(buscar: BuscarPagina, unit: Unit, e: Parameters<typeof paginaDeTelefones>[1], page: number): Promise<SpinePaginaTelefones> {
  const r = await buscar(unit, e, page);
  if (!r.ok || !r.data) throw new Error(r.error ?? 'a franquia não respondeu');
  return r.data;
}

function juntar(destino: Recentes, itens: SpinePaginaTelefones['itens'], origem: 'paciente' | 'lead'): void {
  for (const it of itens) {
    const chave = chaveDoTelefone(it.whatsapp);
    if (!chave || it.id === null) continue;
    // paciente vale mais que lead (é o cadastro que a recepção usa para agendar)
    const antes = destino.get(chave);
    if (!antes || (antes.origem === 'lead' && origem === 'paciente')) destino.set(chave, { origem, id: it.id });
  }
}

/** Pela data de cadastro do primeiro e do último item da página: do mais antigo ao mais novo, o contrário, ou `null` (sem 2 datas diferentes, não confirma). */
export function ordemDaPagina(itens: SpinePaginaTelefones['itens']): 'crescente' | 'decrescente' | null {
  const datas = itens.map((i) => (i.created ? Date.parse(i.created) : NaN)).filter((d) => Number.isFinite(d));
  if (datas.length < 2) return null;
  const primeira = datas[0]!;
  const ultima = datas[datas.length - 1]!;
  if (primeira < ultima) return 'crescente';
  if (primeira > ultima) return 'decrescente';
  return null;
}

export async function lerRecentes(unit: Unit, agora: number, buscar: BuscarPagina = paginaDeTelefones): Promise<Recentes> {
  const out: Recentes = new Map();
  // leads: janela de datas curta (≤ 100 dias, é o limite da franquia)
  const e = { tipo: 'lead' as const, initialDate: dia(agora - DIAS_DE_LEADS_RECENTES * DIA_MS), endDate: dia(agora + DIA_MS) };
  const p1 = await ler(buscar, unit, e, 1);
  juntar(out, p1.itens, 'lead');
  const paginasDeLeads = p1.totalPages ?? (p1.itens.length >= 100 ? null : 1);
  if (paginasDeLeads === null || paginasDeLeads > MAX_PAGINAS_DE_LEADS_RECENTES) {
    throw new Error(`a janela de leads recentes não coube em ${MAX_PAGINAS_DE_LEADS_RECENTES} páginas — não dá para afirmar que o telefone não está lá`);
  }
  for (let p = 2; p <= paginasDeLeads; p++) juntar(out, (await ler(buscar, unit, e, p)).itens, 'lead');

  // pacientes: a franquia devolve do mais antigo ao mais novo (os recentes no fim), mas isso é conferido, não suposto: pela data do
  // primeiro e do último item da página 1. Ordem invertida = os recentes estão no começo; sem datas para confirmar, lê os dois pontos.
  const c1 = await ler(buscar, unit, { tipo: 'paciente' }, 1);
  const totalDePaginas = c1.totalPages ?? (c1.itens.length >= 100 ? null : 1);
  if (totalDePaginas === null) throw new Error('a franquia não disse quantas páginas de pacientes há');
  if (totalDePaginas === 1) juntar(out, c1.itens, 'paciente');
  else {
    const ordem = ordemDaPagina(c1.itens);
    const paginas = new Set<number>();
    if (ordem !== 'crescente') [1, 2].forEach((n) => paginas.add(n)); // invertida ou não confirmada: o começo também
    if (ordem !== 'decrescente') [totalDePaginas - 1, totalDePaginas].forEach((n) => paginas.add(n)); // a ordem de sempre (ou não confirmada): o fim
    for (const n of [...paginas].filter((x) => x >= 1 && x <= totalDePaginas).sort((a, b) => a - b)) {
      juntar(out, n === 1 ? c1.itens : (await ler(buscar, unit, { tipo: 'paciente' }, n)).itens, 'paciente');
    }
  }
  return out;
}

/** Leitura que falhou fica guardada pouco: a franquia lenta ou fora não pode virar uma rajada de leituras (uma por mensagem, cada uma com várias chamadas). */
export const VALIDADE_DA_FALHA_MS = 2 * 60_000;
const guardados = new Map<string, { em: number; falhou: boolean; valor: Promise<Recentes> }>();

/** Lead que NÓS acabamos de criar: o cache dos recentes (5 min) e o índice (até 20 h) ainda não o conhecem, e um 2º cartão do mesmo número chegaria antes. */
export const VALIDADE_DOS_CRIADOS_MS = 36 * 3600_000;
const criadosPorMim = new Map<string, { em: number; id: number; nome: string | null }>();
const chaveDoCriado = (franquia: string, chave: string) => `${franquia}|${chave}`;

/**
 * A franquia de uma unidade, para a memória de criados e o cache dos recentes: a unidade e o `-resgate` dela usam o MESMO token (e a
 * mesma base de leads), então o que uma criou a outra tem de achar. Sem token (só teste) cai no id da unidade.
 */
export type UnidadeDaFranquia = { id: string; spineBaseUrl?: string | null; spineToken?: string | null };
export const franquiaDe = (unit: UnidadeDaFranquia): string => (unit.spineToken ? chaveDaFranquia(unit) : unit.id);

/** Chamado logo depois de `createLead` dar certo. `nome` = o que mandamos, para saber depois se é a mesma pessoa. */
export function lembrarLeadCriado(unit: UnidadeDaFranquia, telefone: string | null | undefined, idLead: number | null | undefined, nome: string | null = null, agora: number = Date.now()): void {
  const chave = chaveDoTelefone(telefone);
  if (!chave || !idLead) return;
  if (criadosPorMim.size > 20_000) criadosPorMim.clear();
  criadosPorMim.set(chaveDoCriado(franquiaDe(unit), chave), { em: agora, id: idLead, nome });
}

export const depsPadrao: DepsJaCadastrado = {
  indice: (unitId, chave) => consultarIndice(unitId, chave),
  agendarIndice: (unit) => agendarIndice(unit),
  recentes(unit) {
    const agora = Date.now();
    const franquia = franquiaDe(unit);
    const g = guardados.get(franquia);
    if (g && agora - g.em < (g.falhou ? VALIDADE_DA_FALHA_MS : VALIDADE_DOS_RECENTES_MS)) return g.valor;
    const entrada = { em: agora, falhou: false, valor: lerRecentes(unit, agora) };
    guardados.set(franquia, entrada);
    entrada.valor.catch(() => { entrada.falhou = true; entrada.em = Date.now(); });
    if (guardados.size > 200) guardados.clear();
    return entrada.valor;
  },
};

/** Só para teste. */
export function _limparRecentesParaTeste(): void {
  guardados.clear();
  criadosPorMim.clear();
}

/** O cadastro que vale quando o índice tem o telefone como paciente e como lead: o de paciente. */
function melhorEntrada(entradas: readonly Entrada[]): Entrada | null {
  const comId = entradas.filter((e) => e.id !== null && e.id > 0);
  return comId.find((e) => e.origem === 'paciente') ?? comId[0] ?? null;
}

export async function verificarJaCadastrado(
  unit: Pick<Unit, 'id' | 'slug'> & Partial<Unit>,
  telefone: string | null | undefined,
  deps: DepsJaCadastrado = depsPadrao,
): Promise<JaCadastrado> {
  const chave = chaveDoTelefone(telefone);
  if (!chave) return { tipo: 'indeterminado', motivo: 'o telefone não tem 8 dígitos — não dá para conferir se já está na franquia' };

  const criado = criadosPorMim.get(chaveDoCriado(franquiaDe(unit), chave));
  if (criado && Date.now() - criado.em < VALIDADE_DOS_CRIADOS_MS) {
    return { tipo: 'achou', origem: 'lead', id: criado.id, por: 'recentes', ...(criado.nome ? { nome: criado.nome } : {}) };
  }

  let resposta: RespostaDoIndice;
  try {
    resposta = await deps.indice(unit.id, chave);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-ja-cadastrado: não consegui ler o índice de telefones');
    return { tipo: 'indeterminado', motivo: 'não consegui ler o índice de telefones da franquia' };
  }
  const noIndice = melhorEntrada(resposta.entradas);
  if (noIndice) return { tipo: 'achou', origem: noIndice.origem, id: noIndice.id as number, por: 'indice', ...(noIndice.criado ? { criado: noIndice.criado } : {}) };
  // Telefone presente no índice mas sem id utilizável: existe, mas não dá para ligar a ninguém — também não cria.
  if (resposta.entradas.length > 0) return { tipo: 'indeterminado', motivo: 'o telefone está na franquia mas o cadastro veio sem id' };

  if (!resposta.fresco) {
    // pede a carga (em segundo plano, sem esperar) e não cria agora: o lead volta na próxima mensagem
    try { deps.agendarIndice(unit as Unit); } catch { /* nunca lança */ }
    return { tipo: 'indeterminado', motivo: `o índice de telefones da franquia ainda não está inteiro (${resposta.idadeHoras === null ? 'nunca carregou' : `tem ${resposta.idadeHoras} h`}) — a carga foi pedida` };
  }

  let recentes: Recentes;
  try {
    recentes = await deps.recentes(unit as Unit);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-ja-cadastrado: não consegui ler os cadastros recentes da franquia');
    return { tipo: 'indeterminado', motivo: `não consegui ler os cadastros recentes da franquia: ${String(err instanceof Error ? err.message : err).slice(0, 160)}` };
  }
  const recente = recentes.get(chave);
  if (recente) return { tipo: 'achou', origem: recente.origem, id: recente.id, por: 'recentes' };
  return { tipo: 'nao' };
}

