/**
 * "◷ Data do primeiro contato" vazia: preenche com a data de CRIAÇÃO do cartão. Sem IA, sem chute.
 *
 * Por que existe (24/11/2026): em Salto 86 e em Tatuí 319 cartões ativos estão com o campo vazio, e o Kommo sabe quando cada um nasceu.
 * É a mesma data que o `tipo-lead-chegada` já usa como piso do 1º contato (`primeiroContatoEm` toma a MAIS ANTIGA entre criação,
 * campo e datas no nome), então preencher com a criação NÃO muda nenhum "Resgate/Cadastro" calculado hoje.
 *
 * Regras: nunca sobrescreve; só campo de data (date / date_time); o nome do campo tem de casar com UM campo da conta (zero ou
 * mais de um = não faz nada naquela conta); cartão sem `created_at` válido fica de fora. Cartão fechado (Ganho/Perdido) só
 * entra com `incluirFechados`.
 */
import { acharCampo } from './tipo-lead-chegada.js';

export const NOME_DO_CAMPO = '◷ Data do primeiro contato';

export interface CartaoParaData {
  id: number;
  status_id: number;
  created_at?: number | null;
  custom_fields_values?: Array<{ field_id: number; values?: Array<{ value?: unknown }> }> | null;
}

export interface CampoDaContaData {
  id: number;
  name: string;
  type: string;
}

export interface PlanoDeData {
  campo: CampoDaContaData | null;
  /** por que não há campo utilizável */
  semCampo?: string;
  gravar: Array<{ leadId: number; epoch: number }>;
  jaTinham: number;
  semCriacao: number;
  fechadosIgnorados: number;
}

/** Ganho (142) e Perdido (143) são os ids fixos do Kommo em qualquer funil. */
export const ETAPAS_FECHADAS: ReadonlySet<number> = new Set([142, 143]);

function temValor(c: CartaoParaData, campoId: number): boolean {
  const v = (c.custom_fields_values ?? []).find((f) => f.field_id === campoId)?.values?.[0]?.value;
  return v !== null && v !== undefined && v !== '';
}

export function planejarDataDoPrimeiroContato(
  cartoes: ReadonlyArray<CartaoParaData>,
  campos: ReadonlyArray<CampoDaContaData>,
  incluirFechados = false,
): PlanoDeData {
  const vazio: PlanoDeData = { campo: null, gravar: [], jaTinham: 0, semCriacao: 0, fechadosIgnorados: 0 };
  const campo = acharCampo(campos, NOME_DO_CAMPO, true);
  if (!campo) return { ...vazio, semCampo: `a conta não tem UM campo chamado "${NOME_DO_CAMPO}"` };
  if (campo.type !== 'date' && campo.type !== 'date_time') {
    return { ...vazio, campo, semCampo: `o campo é "${campo.type}", não de data` };
  }
  const plano: PlanoDeData = { ...vazio, campo };
  for (const c of cartoes) {
    if (!incluirFechados && ETAPAS_FECHADAS.has(c.status_id)) {
      plano.fechadosIgnorados++;
      continue;
    }
    if (temValor(c, campo.id)) {
      plano.jaTinham++;
      continue;
    }
    const criado = Number(c.created_at);
    if (!Number.isFinite(criado) || criado <= 0) {
      plano.semCriacao++;
      continue;
    }
    plano.gravar.push({ leadId: c.id, epoch: Math.floor(criado) });
  }
  return plano;
}
