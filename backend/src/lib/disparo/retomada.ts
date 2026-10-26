/**
 * A regra de retomar uma onda pausada por SAIR — pura, sem banco, para o teste ler cada recusa.
 * Quem grava (e consulta a Meta) é `retomarOnda` em `onda.ts`.
 */
export interface SituacaoParaRetomar {
  /** o e-mail de quem pede está em DISPARO_APROVADORES */
  aprovador: boolean;
  estado: string;
  pausaCausa: string | null;
  aprovadaEm: Date | null;
  validadeDias: number;
  agora: Date;
  /** quantos SAIR existem agora */
  sairamAgora: number;
  /** quantos SAIR a tela mostrou ao João */
  sairamVisto: unknown;
}

export type Recusa = { status: number; erro: string };

/** `null` quando pode retomar; senão por que não (status HTTP + texto para a tela). */
export function recusaDaRetomada(s: SituacaoParaRetomar): Recusa | null {
  if (!s.aprovador) return { status: 403, erro: 'este usuário não está em DISPARO_APROVADORES' };
  if (s.estado !== 'pausada') return { status: 409, erro: `a onda está "${s.estado}"; só se retoma uma onda pausada` };
  if (s.pausaCausa !== 'sair') return { status: 422, erro: 'só dá para retomar a pausa por SAIR; esta parou por outro motivo: cancele e monte a onda de novo' };
  if (!s.aprovadaEm || s.agora.getTime() - s.aprovadaEm.getTime() > s.validadeDias * 86_400_000) {
    return { status: 422, erro: `a aprovação desta onda passou de ${s.validadeDias} dias; cancele e monte a onda de novo` };
  }
  if (s.sairamVisto !== s.sairamAgora) return { status: 409, erro: 'a lista de quem pediu SAIR mudou desde que você abriu a tela; recarregue e confira de novo' };
  return null;
}

/** A frase do paciente para a tela: uma linha, no máximo 140 caracteres, sem sequência de dígitos que possa ser telefone ou documento. */
export function respostaParaTela(texto: string | null | undefined): string {
  const limpo = (texto ?? '').replace(/\s+/g, ' ').replace(/\d[\d .()-]{6,}\d/g, '•••').trim();
  return limpo.length > 140 ? `${limpo.slice(0, 139)}…` : limpo;
}
