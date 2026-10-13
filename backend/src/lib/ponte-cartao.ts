/**
 * Ponte (extensão do WhatsApp Web, fase 1 — só leitura): qual é o cartão do Kommo da conversa aberta.
 *
 * Aqui fica a parte pura: limpar o telefone que a extensão mandou, conferir o número completo, a ordem
 * dos 4 passos do casamento, e o resumo da pausa da Sofia. Quem fala com Kommo, banco e franquia é
 * `controllers/ponte.controller.ts`, que entra aqui com os passos já prontos (e o teste entra com falsos).
 *
 * Ordem do casamento, parando no primeiro que achar:
 *   1. telefone — busca de contato no Kommo e CONFERE o número (a busca casa só pelos últimos dígitos);
 *      número compartilhado (mãe e filho, dois contatos com nomes diferentes) vira lista para escolher;
 *   2. impressão da conversa — as mensagens do paciente que a Sofia guardou (ver `ponte-impressao.ts`);
 *   3. nome do cabeçalho — busca por texto; mais de um contato = lista para a atendente escolher;
 *   4. nada — a extensão mostra a busca manual.
 * Nada aqui escreve no Kommo nem na franquia.
 */
import { chaveTelefone, normalizar } from './franquia-sync.js';
import { limparNome } from './widget-agenda.js';
import { emPausa, type JanelaDePausa } from './pausa-unidade.js';
import { caixinhaMarcada } from '../services/kommo.service.js';

export { caixinhaMarcada };

export type ComoAchou = 'telefone' | 'impressao' | 'nome' | 'manual';

/**
 * O telefone que a extensão mandou, só os dígitos — ou `null`.
 *
 * Recusa qualquer coisa com `@`: o JID `…@lid` do WhatsApp é um id opaco, NÃO é telefone, e os dígitos dele
 * casariam por acaso com o número de outra pessoa. A extensão já manda só o que veio de `@c.us`; isto é a
 * segunda trava, para o dia em que alguém mandar o JID inteiro.
 */
export function telefoneDaPonte(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const s = bruto.trim();
  if (!s || s.includes('@')) return null;
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  const d = s.replace(/\D+/g, '');
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** DDD de um número brasileiro (com ou sem o 55), ou `null` quando não dá para saber. */
export function dddBrasileiro(bruto: string | null | undefined): string | null {
  let d = String(bruto ?? '').replace(/\D+/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d.slice(0, 2) : null;
}

/**
 * O telefone do contato É o procurado? A busca do Kommo casa pelos últimos 7–8 dígitos e devolve gente
 * parecida; aqui se confere: os 8 últimos iguais (`chaveTelefone`, que atravessa o nono dígito) E, quando
 * os dois números trazem DDD, o mesmo DDD. Mesmo final em DDD diferente é outra pessoa.
 */
export function telefoneConfere(procurado: string | null | undefined, doContato: string | null | undefined): boolean {
  const a = chaveTelefone(procurado);
  const b = chaveTelefone(doContato);
  if (a.length < 8 || a !== b) return false;
  const da = dddBrasileiro(procurado);
  const db = dddBrasileiro(doContato);
  return !da || !db || da === db;
}

/**
 * O nome do contato tem todas as palavras do nome que aparece no cabeçalho? "Maria Silva" casa com
 * "Maria da Silva Santos"; "Maria" sozinha casa com toda Maria — por isso nome nunca escolhe sozinho
 * quando sobra mais de um contato. Palavra de 1 letra não conta.
 */
export function nomeCasa(procurado: string | null | undefined, doContato: string | null | undefined): boolean {
  const alvo = normalizar(limparNome(procurado)).split(' ').filter((p) => p.length >= 2);
  if (!alvo.length || !alvo.some((p) => p.length >= 3)) return false;
  const tem = new Set(normalizar(limparNome(doContato)).split(' '));
  return alvo.every((p) => tem.has(p));
}

/** Etapas finais do Kommo, iguais em todo funil. */
export const GANHO = 142;
export const PERDIDO = 143;

export interface CartaoParaOrdenar {
  id: number;
  status_id: number;
  updated_at?: number;
}

/** Dos cartões do mesmo paciente, qual mostrar: os abertos antes dos fechados, e dentro disso o mais mexido. */
export function ordenarCartoes<T extends CartaoParaOrdenar>(leads: T[]): T[] {
  const aberto = (l: T) => (l.status_id === GANHO || l.status_id === PERDIDO ? 1 : 0);
  return leads.slice().sort((a, b) => aberto(a) - aberto(b) || (b.updated_at ?? 0) - (a.updated_at ?? 0) || b.id - a.id);
}

export interface EntradaDoCasamento {
  telefone: string | null;
  impressoes: string[];
  nome: string | null;
  /** A atendente digitou o nome na busca manual: pula telefone e impressão, e o "como" vira `manual`. */
  manual: boolean;
}

/**
 * Os passos com acesso ao mundo. Cada um LANÇA quando não conseguiu perguntar (Kommo fora, banco fora) —
 * "não consegui perguntar" não é "não existe", e o resultado sai marcado `incompleto`.
 */
export interface ContatoAchado {
  nome: string | null;
  leadIds: number[];
}

export interface PassosDoCasamento {
  /** Contatos cujo telefone confere com o procurado, cada um com os ids dos seus cartões. */
  porTelefone(telefone: string): Promise<ContatoAchado[]>;
  /** O cartão da conversa guardada que bate com as impressões, ou `null`. */
  porImpressao(impressoes: string[]): Promise<number | null>;
  /** Contatos cujo nome casa, cada um com os ids dos seus cartões. */
  porNome(nome: string): Promise<number[][]>;
}

export type Casamento =
  | { tipo: 'achado'; como: ComoAchou; leadIds: number[]; incompleto: boolean }
  /** Um grupo por contato; a atendente escolhe. */
  | { tipo: 'candidatos'; como: 'telefone' | 'nome' | 'manual'; grupos: number[][]; incompleto: boolean }
  | { tipo: 'nada'; incompleto: boolean; passos: Array<'telefone' | 'impressao' | 'nome'> };

const unicos = (ids: number[]) => [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];

/**
 * Os contatos do mesmo telefone são a MESMA pessoa? Contato duplicado no Kommo é comum (mesmo nome, ou um
 * deles sem nome); nomes diferentes no mesmo número é família dividindo o WhatsApp — aí a atendente escolhe.
 */
function mesmaPessoa(contatos: ContatoAchado[]): boolean {
  const nomes = new Set(contatos.map((c) => normalizar(limparNome(c.nome))).filter(Boolean));
  return nomes.size <= 1;
}

export async function casarCartao(e: EntradaDoCasamento, passos: PassosDoCasamento): Promise<Casamento> {
  let incompleto = false;
  const tentados: Array<'telefone' | 'impressao' | 'nome'> = [];
  const tenta = async <T>(nome: 'telefone' | 'impressao' | 'nome', f: () => Promise<T>): Promise<T | null> => {
    tentados.push(nome);
    try {
      return await f();
    } catch {
      incompleto = true;
      return null;
    }
  };

  if (!e.manual && e.telefone) {
    const contatos = ((await tenta('telefone', () => passos.porTelefone(e.telefone!))) ?? [])
      .map((c) => ({ nome: c.nome, leadIds: unicos(c.leadIds) }))
      .filter((c) => c.leadIds.length);
    if (contatos.length && mesmaPessoa(contatos)) {
      return { tipo: 'achado', como: 'telefone', leadIds: unicos(contatos.flatMap((c) => c.leadIds)), incompleto };
    }
    if (contatos.length) return { tipo: 'candidatos', como: 'telefone', grupos: contatos.map((c) => c.leadIds), incompleto };
  }

  if (!e.manual && e.impressoes.length) {
    const id = await tenta('impressao', () => passos.porImpressao(e.impressoes));
    if (id && Number.isInteger(id) && id > 0) return { tipo: 'achado', como: 'impressao', leadIds: [id], incompleto };
  }

  if (e.nome && e.nome.trim()) {
    const grupos = ((await tenta('nome', () => passos.porNome(e.nome!.trim()))) ?? []).map(unicos).filter((g) => g.length);
    const como = e.manual ? 'manual' : 'nome';
    if (grupos.length === 1) return { tipo: 'achado', como, leadIds: grupos[0], incompleto };
    if (grupos.length > 1) return { tipo: 'candidatos', como, grupos, incompleto };
  }

  return { tipo: 'nada', incompleto, passos: tentados };
}

export interface EstadoDaSofia {
  pausada: boolean;
  /**
   * Por que ela está quieta: a unidade inteira pausada (recepção/teto), fora do horário em que a Sofia atende
   * (`businessHours*` da unidade), a caixinha do cartão, ou a pausa com data do widget.
   */
  por: 'unidade' | 'horario' | 'caixinha' | 'janela' | null;
  ate: string | null;
}

/**
 * As travas que calam a Sofia antes de responder, na ordem de `webhook.controller.ts`: pausa da unidade,
 * horário de atendimento, caixinha "Pausar IA", pausa com data. O painel diz "ativa" só se nenhuma vale agora.
 */
export function estadoDaSofia(
  p: { unidade: JanelaDePausa; foraDoHorario: boolean; caixinha: boolean; janelaAte: Date | null },
  agora: Date = new Date(),
): EstadoDaSofia {
  if (emPausa(p.unidade, agora)) return { pausada: true, por: 'unidade', ate: p.unidade.pausaAte?.toISOString() ?? null };
  if (p.foraDoHorario) return { pausada: true, por: 'horario', ate: null };
  if (p.caixinha) return { pausada: true, por: 'caixinha', ate: null };
  if (p.janelaAte && agora < p.janelaAte) return { pausada: true, por: 'janela', ate: p.janelaAte.toISOString() };
  return { pausada: false, por: null, ate: null };
}

export interface EtapaDaBarra {
  id: number;
  nome: string;
  atual: boolean;
}

/**
 * A barrinha do funil COMERCIAL: as etapas na ordem do Kommo, com a atual marcada. A etapa de "leads de
 * entrada" (tipo 1) só aparece se o cartão estiver nela — é a caixa de chegada, não um passo do funil.
 * GANHO e PERDIDO (142/143) existem em todo funil: a atual só é marcada se o cartão for DESTE funil.
 */
export function barraDoFunil(
  funil: { id: number; statuses: Array<{ id: number; name: string; sort?: number; type?: number }> } | null,
  lead: { pipeline_id: number; status_id: number },
): EtapaDaBarra[] {
  if (!funil) return [];
  const doFunil = lead.pipeline_id === funil.id;
  return funil.statuses
    .slice()
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .filter((s) => s.type !== 1 || (doFunil && s.id === lead.status_id))
    .map((s) => ({ id: s.id, nome: s.name, atual: doFunil && s.id === lead.status_id }));
}

/** O funil COMERCIAL da conta: pelo nome; se a conta não tiver um com esse nome, o principal. */
export function funilComercial<T extends { name: string; is_main?: boolean; is_archive?: boolean }>(funis: T[]): T | null {
  const vivos = funis.filter((f) => !f.is_archive);
  return vivos.find((f) => normalizar(f.name) === 'comercial') ?? vivos.find((f) => normalizar(f.name).includes('comercial')) ?? vivos.find((f) => f.is_main) ?? null;
}
