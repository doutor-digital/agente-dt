/**
 * O motivo no topo do cartão perdido (20/10/2026).
 *
 * O Kommo tem DOIS motivos para um cartão perdido: o "motivo da perda" dele, no topo do cartão ao lado da etapa, e
 * os nossos campos ⊘ — o que a SDR escolhe (o Kommo exige para ir a PERDIDO) e o que os relatórios leem. Ninguém
 * escolhia o do topo, e o cartão mostrava "Motivo indefinido" com o motivo preenchido logo abaixo. No vídeo de
 * treinamento de Petrópolis isso confundia as SDRs (João, 20/10). O robô copia o ⊘ para o topo: a SDR continua
 * escolhendo um motivo só.
 *
 * Regras:
 *  - só cartão perdido (143) com o topo VAZIO — o que alguém ou um robô de prazo já pôs ali nunca é trocado;
 *  - só copia o que está no campo, nunca inventa: campo vazio, nada a fazer;
 *  - qual campo: no TRATAMENTO, o motivo do cancelamento; no COMERCIAL, o de não fechamento (quem consultou e não
 *    fechou — é o mais recente) e, sem ele, o do não agendamento.
 */
import { normalizarNome } from './kommo-schema.js';
import { CAMPO, nomesDoCampo } from './parados.js';

/** Fechado como perdido — o mesmo id nos dois funis (PERDIDO no COMERCIAL, TRATAMENTO CANCELADO no TRATAMENTO). */
export const PERDIDO = 143;

export type FunilDoMotivo = 'COMERCIAL' | 'TRATAMENTO';

/** Por funil, na ordem de preferência. Por NOME (o id muda por conta); cada um com os nomes antigos. */
export const CAMPOS_DO_MOTIVO: Record<FunilDoMotivo, readonly string[]> = {
  COMERCIAL: [...nomesDoCampo(CAMPO.MOTIVO_NAO_FECHAMENTO), CAMPO.MOTIVO_NAO_AGENDAMENTO],
  TRATAMENTO: ['⊘ Motivo do cancelamento do tratamento', '⊘ Motivo do cancelamento'],
};

type Campos = ReadonlyArray<{ field_name?: string; values?: ReadonlyArray<{ value?: unknown }> | null }> | null | undefined;

/** Puro. O primeiro motivo preenchido nos campos do funil, ou null. */
export function motivoDoCampo(campos: Campos, funil: FunilDoMotivo): string | null {
  for (const nome of CAMPOS_DO_MOTIVO[funil]) {
    const alvo = normalizarNome(nome);
    const campo = (campos ?? []).find((f) => normalizarNome(f.field_name ?? '') === alvo);
    const v = String(campo?.values?.[0]?.value ?? '').trim();
    if (v) return v;
  }
  return null;
}

/** Puro. O motivo a copiar para o topo, ou null quando não há o que fazer. */
export function planejarMotivoNoCabecalho(
  lead: { status_id?: number; loss_reason_id?: number | null; custom_fields_values?: Campos },
  funil: FunilDoMotivo | null,
): string | null {
  if (!funil || lead.status_id !== PERDIDO || lead.loss_reason_id) return null;
  return motivoDoCampo(lead.custom_fields_values, funil);
}

/**
 * Puro. De onde a próxima rodada lê (epoch s), varrendo do mais antigo para o mais novo:
 *  - sobrou cartão além do teto → a partir dele (o filtro do Kommo inclui o próprio segundo; reler um ou outro é inofensivo);
 *  - parou no limite de páginas → a partir do último lido;
 *  - leu tudo → a partir do começo desta rodada.
 */
export function proximoDesde(e: { inicio: number; completo: boolean; sobra?: { updated_at?: number }; ultimo?: { updated_at?: number } }): number {
  if (e.sobra?.updated_at) return e.sobra.updated_at;
  if (!e.completo && e.ultimo?.updated_at) return e.ultimo.updated_at;
  return e.inicio;
}
