/**
 * ◷ Retomar em: a SDR (ou a Sofia) decidiu ESPERAR o paciente até aquela data. O robô respeita.
 *
 * Auditoria da Açailândia (16/10/2026, item 10): 28 cartões em 7 dias no pingue-pongue SDR × robô.
 * A SDR punha o cartão em EM ESPERA com data de retomada e, em minutos, um robô tirava de lá:
 *  - o `franquia-move` (varredura de 15 em 15 min) lia a avaliação atendida de sempre e devolvia
 *    pra COMPARECEU/EM NEGOCIAÇÃO — 25162400: a SDR pôs em EM ESPERA às 14:34 de 13/10 com
 *    "Exames" e retomada em 20/10; às 14:44 o robô devolveu pra COMPARECEU. 27441243, idem (10/10,
 *    retomada em 13/10), duas vezes em 40 min;
 *  - a `volta-espera` (paciente escreveu → EM QUALIFICAÇÃO, retomada apagada) desfazia a espera que
 *    acabara de ser marcada — 28651944: a Sofia pôs em EM ESPERA às 11:23 de 15/10 ("Viajando",
 *    retomada em 22/10) e às 11:24 a volta tirou de lá; 10822030 foi e voltou três vezes em 14/10.
 *
 * Regra: EM ESPERA com ◷ Retomar em ainda por vir é decisão de gente. Fato VELHO da franquia (a
 * mesma avaliação atendida) não puxa o cartão de volta; fato NOVO, sim — consulta marcada (AGENDADO),
 * tratamento aberto (GANHO) e a jornada do tratamento seguem valendo. O dia da retomada conta como
 * "ainda por vir" para o `franquia-move`: é às 9 h desse dia que o robô do Kommo manda a mensagem de
 * retomada, e ele só manda pra quem ainda está em EM ESPERA. Para a volta, o dia da retomada é
 * justamente quando o paciente responde a essa mensagem — aí a volta faz o trabalho dela.
 *
 * Este arquivo é PURO (decisão), mais um embrulho que loga. Cada automação continua atrás da sua
 * própria chave (`franquia-move`, `volta-espera`): isto só diz quando ela NÃO deve mexer.
 */
import { normalizarNome } from './kommo-schema.js';
import { ETAPA, type EtapaAtual } from './franquia-move.js';
import { logger } from './logger.js';

export const CAMPO_RETOMAR_EM = '◷ Retomar em';

/** Em relação a hoje (no fuso da unidade), quando cai o ◷ Retomar em do cartão. */
export type DiaDaRetomada = 'sem' | 'passou' | 'hoje' | 'futuro';

const TZ_PADRAO = 'America/Sao_Paulo';

/**
 * Dia do calendário de um campo `date` do Kommo. O Kommo guarda meia-noite no fuso da CONTA (20/10 em
 * Brasília = 03:00 UTC). Somar 12 h e ler em UTC devolve o dia certo para qualquer fuso de UTC-11 a
 * UTC+11, sem precisar saber o fuso da conta (mesmo truque de `epochDeCampoData`).
 */
export function diaDoCampoData(epoch: number): string {
  return new Date((epoch + 12 * 3600) * 1000).toISOString().slice(0, 10);
}

/** Hoje (AAAA-MM-DD) no fuso da unidade. */
export function hojeNaUnidade(agoraEpoch: number, tz: string = TZ_PADRAO): string {
  return new Date(agoraEpoch * 1000).toLocaleDateString('en-CA', { timeZone: tz });
}

export function diaDaRetomada(retomarEmEpoch: number | null | undefined, agoraEpoch: number, tz: string = TZ_PADRAO): DiaDaRetomada {
  if (retomarEmEpoch == null || !Number.isFinite(retomarEmEpoch) || retomarEmEpoch <= 0) return 'sem';
  const dia = diaDoCampoData(retomarEmEpoch);
  const hoje = hojeNaUnidade(agoraEpoch, tz);
  if (dia > hoje) return 'futuro';
  return dia === hoje ? 'hoje' : 'passou';
}

/** ◷ Retomar em do cartão (epoch s), pelo NOME do campo. Aceita epoch em s, em ms ou ISO. */
export function retomarEmDoCartao(
  campos: ReadonlyArray<{ field_name?: string; values?: ReadonlyArray<{ value?: unknown }> }> | null | undefined,
): number | null {
  const alvo = normalizarNome(CAMPO_RETOMAR_EM);
  const v = (campos ?? []).find((c) => normalizarNome(c.field_name ?? '') === alvo)?.values?.[0]?.value;
  if (v == null || v === '') return null;
  const num = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(num) && num > 0) return num > 1e11 ? Math.floor(num / 1000) : num;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

const eh = (a: string, b: string) => normalizarNome(a) === normalizarNome(b);

/**
 * Para onde a franquia ainda pode levar um cartão que a SDR deixou esperando: só fato NOVO. Consulta
 * marcada (AGENDADO), tratamento aberto (GANHO), a volta do ex-paciente (RETORNO) e a jornada do
 * tratamento. COMPARECEU, EM NEGOCIAÇÃO e NÃO COMPARECEU são releitura do que já aconteceu — ficam.
 */
const FATO_NOVO_PASSA = [ETAPA.AGENDADO, ETAPA.GANHO, ETAPA.RETORNO, ETAPA.EM_TRATAMENTO, ETAPA.ALTA];

/** PURA: o `franquia-move` deve deixar o cartão em EM ESPERA (em vez de levá-lo para `para`)? */
export function esperaSeguraMovimento(atual: EtapaAtual | null, para: string, dia: DiaDaRetomada): boolean {
  if (!atual || atual.funil !== 'COMERCIAL' || !eh(atual.status, ETAPA.ESPERA)) return false;
  if (dia !== 'hoje' && dia !== 'futuro') return false;
  return !FATO_NOVO_PASSA.some((e) => eh(para, e));
}

/** PURA: a volta de EM ESPERA (paciente escreveu) deve deixar o cartão onde está? Só antes do dia da retomada. */
export function esperaSeguraVolta(dia: DiaDaRetomada): boolean {
  return dia === 'futuro';
}

/**
 * Embrulho do `franquia-move`: decide e loga. Uma linha no ponto de chamada, nada mais (o sincronizador
 * é mexido por outras frentes ao mesmo tempo).
 */
export function franquiaRespeitaEspera(
  unit: { slug: string; spineTimezone?: string | null },
  lead: { id: number; custom_fields_values?: ReadonlyArray<{ field_name?: string; values?: ReadonlyArray<{ value?: unknown }> }> | null },
  atual: EtapaAtual | null,
  para: string,
  agoraEpoch: number,
): boolean {
  const retomarEm = retomarEmDoCartao(lead.custom_fields_values);
  const dia = diaDaRetomada(retomarEm, agoraEpoch, unit.spineTimezone ?? TZ_PADRAO);
  if (!esperaSeguraMovimento(atual, para, dia)) return false;
  logger.debug(
    { unit: unit.slug, leadId: lead.id, para, retomarEm: retomarEm ? diaDoCampoData(retomarEm) : null },
    'franquia-move: EM ESPERA com ◷ Retomar em marcado — a SDR decidiu esperar, não puxei de volta',
  );
  return true;
}
