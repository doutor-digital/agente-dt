/**
 * Leads PARADOS — a régua de prazos que o João decidiu em 18/09/2026 (entrevista, itens 8–10) e
 * reafirmou em 21/09: "não quero as meninas movendo nada; tudo é centralizado no CRM da franquia".
 *
 * As regras:
 *  - EM ESPERA há 30 dias → PERDIDO, motivo "Não deu continuidade ao atendimento".
 *  - EM NEGOCIAÇÃO há 45 dias → PERDIDO, motivo "Sem resposta após consulta".
 *    "Há N dias" = nos últimos N dias o paciente NÃO escreveu, o cartão NÃO mudou de etapa, a data de
 *    retomada NÃO é futura nem recente, e o cartão não é novo. Qualquer um desses sinais segura.
 *    E a franquia é consultada antes: consulta futura ou tratamento aberto segura (PERDIDO é
 *    intocável pro sincronizador — perder um paciente de verdade ali não tem volta).
 *  - NÃO COMPARECEU há 7 dias sem consulta futura na franquia → EM ESPERA (motivo "Outro",
 *    retomar em +7 dias, pra régua de retomada pegar).
 *  - Régua de follow-up esgotada sem resposta (o cartão diz "⬢ Status da conversa = Sem resposta"
 *    e o paciente não escreveu nas 24 h seguintes), ainda na entrada ou em EM QUALIFICAÇÃO →
 *    PERDIDO, motivo "Não interagiu". As 24 h são a chance de responder ao último toque.
 *  - Paciente em EM ESPERA que escreve de verdade (não "ok, obrigado") → volta pra EM QUALIFICAÇÃO
 *    na hora (webhook) e a retomada automática é cancelada.
 *
 * Liga por unidade (`PARADOS_SLUGS`, csv ou `*`; vazio = ninguém). `PARADOS_SECO=1` só registra o
 * que faria — é assim que se prova na Imperatriz antes de mover de verdade. Este arquivo é a parte
 * PURA (decisão e textos), testável sem Kommo; quem lê e move está em `parados-worker.ts`.
 */
import { ehEtapaDeEntrada } from './franquia-move.js';
import { normalizarNome } from './kommo-schema.js';

export const PRAZOS = {
  esperaDias: Number(process.env.PARADOS_ESPERA_DIAS) || 30,
  negociacaoDias: Number(process.env.PARADOS_NEGOCIACAO_DIAS) || 45,
  faltaDias: Number(process.env.PARADOS_FALTA_DIAS) || 7,
  /** horas depois do último toque da régua em que o paciente ainda pode responder */
  reguaRespostaHoras: Number(process.env.PARADOS_REGUA_RESPOSTA_HORAS) || 24,
} as const;

/** Quantos cartões uma varredura move POR REGRA por unidade: o estoque antigo entra aos poucos, não numa rajada. */
export const MAX_POR_VARREDURA = Number(process.env.PARADOS_MAX_POR_VARREDURA) || 10;

export const MOTIVO_PERDA = {
  ESPERA: 'Não deu continuidade ao atendimento',
  NEGOCIACAO: 'Sem resposta após consulta',
  FOLLOW_UP: 'Não interagiu',
} as const;

/** Campos do cartão (por NOME — id muda por conta). */
export const CAMPO = {
  MOTIVO_NAO_AGENDAMENTO: '⊘ Motivo do não agendamento',
  MOTIVO_NAO_FECHAMENTO: '⊘ Motivo de não fechamento',
  MOTIVO_ESPERA: '⊘ Motivo da espera',
  RETOMAR_EM: '◷ Retomar em',
  STATUS_CONVERSA: '⬢ Status da conversa',
} as const;

export const OPCAO_ESPERA_FALTA = 'Outro';
export const STATUS_SEM_RESPOSTA = 'Sem resposta';
export const TAG_PRAZO = '⏱ movido por prazo';
/** Etiqueta que os bots de PERDIDO da Imperatriz respeitam (gatilho not_equal): quem some depois de
 *  semanas não recebe a régua escrita pra quem nunca veio. Quem nunca interagiu, sim. */
export const TAG_SEM_REGUA = 'NO_FOLLOW_UP';

export const DIA_S = 24 * 60 * 60;

export function paradosLiberado(slug: string, raw: string | undefined = process.env.PARADOS_SLUGS): boolean {
  const lista = (raw ?? '')
    .replace(/^['"]|['"]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return lista.includes('*') || lista.includes(slug);
}

/** `PARADOS_SECO=1`: decide e registra no log, mas não toca no Kommo. */
export function modoSeco(raw: string | undefined = process.env.PARADOS_SECO): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'sim';
}

const eh = (a: string, b: string) => normalizarNome(a) === normalizarNome(b);

export function ehEspera(etapa: string): boolean {
  return eh(etapa, 'EM ESPERA');
}
export function ehNegociacao(etapa: string): boolean {
  return eh(etapa, 'EM NEGOCIAÇÃO');
}

/** O que se sabe do cartão DENTRO da janela do prazo (últimos N dias). */
export interface Janela {
  /** o contato mandou mensagem nos últimos N dias */
  escreveuNaJanela: boolean;
  /** o cartão mudou de etapa nos últimos N dias (acabou de chegar aqui) */
  mudouEtapaNaJanela: boolean;
  /** "◷ Retomar em" do cartão (epoch s), se houver */
  retomarEmEpoch: number | null;
  /** criação do cartão (epoch s) */
  criadoEpoch: number | null;
}

export interface DecisaoParado {
  para: 'PERDIDO' | 'EM ESPERA';
  regra: string;
  /** dias de prazo que venceram (limite inferior — "há mais de N dias") */
  dias: number;
  /** motivo de perda do Kommo (loss reason), só pra PERDIDO */
  motivoPerda?: string;
  /** campo select do cartão a preencher junto */
  campo?: { nome: string; opcao: string };
  /** só pra EM ESPERA: quando a régua de retomada deve procurar o paciente */
  retomarEmEpoch?: number;
  /** PERDIDO por sumiço: não dispara a régua de templates de PERDIDO */
  semRegua?: boolean;
}

export function prazoDaEtapa(etapa: string, prazos: PrazosDeEtapa = PRAZOS): number | null {
  if (ehEspera(etapa)) return prazos.esperaDias;
  if (ehNegociacao(etapa)) return prazos.negociacaoDias;
  return null;
}

/** Só com os dados do próprio cartão: ainda pode estar parado? (barato — decide se vale consultar Kommo/franquia) */
type PrazosDeEtapa = { esperaDias: number; negociacaoDias: number };

export function candidatoPeloCartao(
  etapa: string,
  cartao: Pick<Janela, 'retomarEmEpoch' | 'criadoEpoch'>,
  agoraEpoch: number,
  prazos: PrazosDeEtapa = PRAZOS,
): boolean {
  const prazo = prazoDaEtapa(etapa, prazos);
  if (prazo === null) return false;
  const desde = agoraEpoch - prazo * DIA_S;
  if (cartao.retomarEmEpoch !== null && cartao.retomarEmEpoch > desde) return false;
  if (cartao.criadoEpoch !== null && cartao.criadoEpoch > desde) return false;
  return true;
}

/** EM ESPERA / EM NEGOCIAÇÃO: venceu o prazo sem nenhum sinal de vida? */
export function decidirParado(etapa: string, j: Janela, agoraEpoch: number, prazos: PrazosDeEtapa = PRAZOS): DecisaoParado | null {
  const prazo = prazoDaEtapa(etapa, prazos);
  if (prazo === null) return null;
  if (!candidatoPeloCartao(etapa, j, agoraEpoch, prazos)) return null;
  if (j.escreveuNaJanela || j.mudouEtapaNaJanela) return null;
  if (ehEspera(etapa)) {
    return {
      para: 'PERDIDO',
      regra: `EM ESPERA há mais de ${prazo} dias sem resposta do paciente`,
      dias: prazo,
      motivoPerda: MOTIVO_PERDA.ESPERA,
      campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.ESPERA },
      semRegua: true,
    };
  }
  return {
    para: 'PERDIDO',
    regra: `EM NEGOCIAÇÃO há mais de ${prazo} dias sem resposta do paciente`,
    dias: prazo,
    motivoPerda: MOTIVO_PERDA.NEGOCIACAO,
    campo: { nome: CAMPO.MOTIVO_NAO_FECHAMENTO, opcao: MOTIVO_PERDA.NEGOCIACAO },
    semRegua: true,
  };
}

/** NÃO COMPARECEU: faltou há N dias e a franquia não tem consulta futura → EM ESPERA. */
export function decidirFalta(
  dataFaltaEpoch: number | null,
  temConsultaFutura: boolean,
  agoraEpoch: number,
  faltaDias: number = PRAZOS.faltaDias,
): DecisaoParado | null {
  if (dataFaltaEpoch === null || temConsultaFutura) return null;
  const dias = Math.floor((agoraEpoch - dataFaltaEpoch) / DIA_S);
  if (dias < faltaDias) return null;
  return {
    para: 'EM ESPERA',
    regra: `faltou há ${dias} dias e não remarcou (prazo ${faltaDias})`,
    dias,
    campo: { nome: CAMPO.MOTIVO_ESPERA, opcao: OPCAO_ESPERA_FALTA },
    retomarEmEpoch: agoraEpoch + faltaDias * DIA_S,
  };
}

/** A régua esgotada só derruba quem ainda não passou da porta: entrada ou EM QUALIFICAÇÃO. */
export function reguaEsgotadaDerruba(etapa: string): boolean {
  return ehEtapaDeEntrada(etapa) || eh(etapa, 'EM QUALIFICAÇÃO');
}

/**
 * Régua esgotada = o cartão já diz "Sem resposta" (o follow-up-worker carimba no fim da escada) e
 * o paciente não escreveu nas horas seguintes ao último toque.
 */
export function decidirReguaEsgotada(statusConversa: string | null | undefined, escreveuDepoisDoUltimoToque: boolean): DecisaoParado | null {
  if (!statusConversa || normalizarNome(statusConversa) !== normalizarNome(STATUS_SEM_RESPOSTA)) return null;
  if (escreveuDepoisDoUltimoToque) return null;
  return {
    para: 'PERDIDO',
    regra: `régua de follow-up esgotada e ${PRAZOS.reguaRespostaHoras} h sem resposta ao último toque`,
    dias: 0,
    motivoPerda: MOTIVO_PERDA.FOLLOW_UP,
    campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.FOLLOW_UP },
    semRegua: false,
  };
}

// Só agradecimento, despedida e saudação. "sim", "pode ser", "tudo bem" ficam FORA: são resposta
// afirmativa à retomada ("quer que eu já marque?") e têm de trazer o cartão de volta.
const CORTESIA = new Set([
  'ok', 'okay', 'oks', 'okk', 'ta', 'tabom', 'blz', 'beleza', 'certo', 'combinado', 'valeu', 'vlw',
  'obrigado', 'obrigada', 'obg', 'brigado', 'brigada', 'grato', 'grata', 'gratidao', 'show', 'perfeito', 'otimo',
  'bom', 'dia', 'tarde', 'noite', 'boa', 'ate', 'logo', 'mais', 'amem', 'deus', 'abencoe', 'bjs', 'beijo', 'beijos',
  'abraco', 'abracos', 'igualmente', 'pra', 'voce', 'tambem',
]);

/** "ok, obrigado 🙏" não é o paciente voltando: não cancela a espera. */
export function ehRespostaDeCortesia(mensagem: string | null | undefined): boolean {
  const limpa = String(mensagem ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
  if (!limpa) return true;
  const palavras = limpa.split(/\s+/).filter(Boolean);
  if (palavras.length > 5) return false;
  return palavras.every((p) => CORTESIA.has(p));
}

export function textoDaNota(d: DecisaoParado, etapaAtual: string): string {
  if (d.para === 'PERDIDO') {
    return (
      `⏱ Movido de ${etapaAtual} para PERDIDO pelo prazo: ${d.regra}. Motivo: ${d.motivoPerda}. ` +
      'Regra combinada em 18/09/2026 — o cartão anda sozinho; se o paciente voltar a escrever, a Sofia retoma.'
    );
  }
  return (
    `⏱ Movido de ${etapaAtual} para EM ESPERA: ${d.regra}. Retomada automática marcada; ` +
    'se o paciente remarcar na franquia, o cartão volta pra AGENDADO sozinho.'
  );
}
