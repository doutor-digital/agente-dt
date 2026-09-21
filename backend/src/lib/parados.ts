/**
 * Leads PARADOS — a régua de prazos que o João decidiu em 18/09/2026 (entrevista, itens 8–10) e
 * reafirmou em 21/09: "não quero as meninas movendo nada; tudo é centralizado no CRM da franquia".
 *
 * As regras (todas contam da ÚLTIMA MENSAGEM DO PACIENTE; sem mensagem, da entrada na etapa):
 *  - EM ESPERA há 30 dias → PERDIDO, motivo "Não deu continuidade ao atendimento".
 *  - EM NEGOCIAÇÃO há 45 dias → PERDIDO, motivo "Sem resposta após consulta".
 *  - NÃO COMPARECEU há 7 dias sem consulta futura na franquia → EM ESPERA (motivo "Outro",
 *    retomar em +7 dias, pra régua de retomada pegar).
 *  - Régua de follow-up esgotada sem resposta, ainda na entrada/EM QUALIFICAÇÃO/EM ESPERA →
 *    PERDIDO, motivo "Não interagiu".
 *  - Paciente em EM ESPERA que escreve → volta pra EM QUALIFICAÇÃO na hora (webhook).
 *
 * Liga por unidade (`PARADOS_SLUGS`, csv ou `*`; vazio = ninguém). `PARADOS_SECO=1` só registra o
 * que faria — é assim que se prova na Imperatriz antes de mover de verdade. Este arquivo é a parte
 * PURA (decisão e textos), testável sem Kommo; quem move está em `parados-worker.ts`.
 */

export const PRAZOS = {
  esperaDias: Number(process.env.PARADOS_ESPERA_DIAS) || 30,
  negociacaoDias: Number(process.env.PARADOS_NEGOCIACAO_DIAS) || 45,
  faltaDias: Number(process.env.PARADOS_FALTA_DIAS) || 7,
} as const;

/** Quantos cartões uma varredura move por unidade: o estoque antigo entra aos poucos, não numa rajada de templates. */
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
} as const;

export const OPCAO_ESPERA_FALTA = 'Outro';
export const TAG_PRAZO = '⏱ movido por prazo';

const DIA_S = 24 * 60 * 60;

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

export interface SinaisDoLead {
  /** epoch (s) da última mensagem RECEBIDA do paciente, ou null se nunca escreveu */
  ultimaMsgPacienteEpoch: number | null;
  /** epoch (s) em que o cartão entrou na etapa atual */
  entrouNaEtapaEpoch: number | null;
  /** epoch (s) de criação do cartão */
  criadoEpoch: number | null;
}

/** De onde o prazo conta: última fala do paciente; sem fala, a entrada na etapa; sem nada, a criação. */
export function referenciaEpoch(s: SinaisDoLead): number | null {
  return s.ultimaMsgPacienteEpoch ?? s.entrouNaEtapaEpoch ?? s.criadoEpoch ?? null;
}

export function diasDesde(epoch: number, agoraEpoch: number): number {
  return Math.floor((agoraEpoch - epoch) / DIA_S);
}

export interface DecisaoParado {
  para: 'PERDIDO' | 'EM ESPERA';
  regra: string;
  dias: number;
  /** motivo de perda do Kommo (loss reason), só pra PERDIDO */
  motivoPerda?: string;
  /** campo select do cartão a preencher junto */
  campo?: { nome: string; opcao: string };
  /** só pra EM ESPERA: quando a régua de retomada deve procurar o paciente */
  retomarEmEpoch?: number;
}

function n(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** EM ESPERA / EM NEGOCIAÇÃO: passou do prazo sem o paciente falar? */
export function decidirParado(
  etapa: string,
  sinais: SinaisDoLead,
  agoraEpoch: number,
  prazos: { esperaDias: number; negociacaoDias: number } = PRAZOS,
): DecisaoParado | null {
  const ref = referenciaEpoch(sinais);
  if (ref === null) return null;
  const dias = diasDesde(ref, agoraEpoch);
  const e = n(etapa);
  if (e === n('EM ESPERA')) {
    if (dias < prazos.esperaDias) return null;
    return {
      para: 'PERDIDO',
      regra: `EM ESPERA há ${dias} dias sem resposta (prazo ${prazos.esperaDias})`,
      dias,
      motivoPerda: MOTIVO_PERDA.ESPERA,
      campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.ESPERA },
    };
  }
  if (e === n('EM NEGOCIAÇÃO')) {
    if (dias < prazos.negociacaoDias) return null;
    return {
      para: 'PERDIDO',
      regra: `EM NEGOCIAÇÃO há ${dias} dias sem resposta (prazo ${prazos.negociacaoDias})`,
      dias,
      motivoPerda: MOTIVO_PERDA.NEGOCIACAO,
      campo: { nome: CAMPO.MOTIVO_NAO_FECHAMENTO, opcao: MOTIVO_PERDA.NEGOCIACAO },
    };
  }
  return null;
}

/** NÃO COMPARECEU: faltou há N dias e a franquia não tem consulta futura → EM ESPERA. */
export function decidirFalta(
  dataFaltaEpoch: number | null,
  temConsultaFutura: boolean,
  agoraEpoch: number,
  faltaDias: number = PRAZOS.faltaDias,
): DecisaoParado | null {
  if (dataFaltaEpoch === null || temConsultaFutura) return null;
  const dias = diasDesde(dataFaltaEpoch, agoraEpoch);
  if (dias < faltaDias) return null;
  return {
    para: 'EM ESPERA',
    regra: `faltou há ${dias} dias e não remarcou (prazo ${faltaDias})`,
    dias,
    campo: { nome: CAMPO.MOTIVO_ESPERA, opcao: OPCAO_ESPERA_FALTA },
    retomarEmEpoch: agoraEpoch + faltaDias * DIA_S,
  };
}

/** Régua esgotada só derruba quem ainda não passou da porta: entrada, EM QUALIFICAÇÃO ou EM ESPERA. */
export function follopUpEsgotadoDerruba(etapa: string): boolean {
  const e = n(etapa);
  return e.includes('entrada') || e.includes('incoming') || e === n('EM QUALIFICAÇÃO') || e === n('EM ESPERA');
}

export function decisaoFollowUpEsgotado(): DecisaoParado {
  return {
    para: 'PERDIDO',
    regra: 'régua de follow-up esgotada sem resposta',
    dias: 0,
    motivoPerda: MOTIVO_PERDA.FOLLOW_UP,
    campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.FOLLOW_UP },
  };
}

export function textoDaNota(d: DecisaoParado, etapaAtual: string): string {
  if (d.para === 'PERDIDO') {
    return `⏱ Movido de ${etapaAtual} para PERDIDO pelo prazo: ${d.regra}. Motivo: ${d.motivoPerda}. ` +
      'Regra combinada em 18/09/2026 — o cartão anda sozinho; se o paciente voltar a escrever, a Sofia retoma.';
  }
  return `⏱ Movido de ${etapaAtual} para EM ESPERA: ${d.regra}. Retomada automática marcada; ` +
    'se o paciente remarcar na franquia, o cartão volta pra AGENDADO sozinho.';
}
