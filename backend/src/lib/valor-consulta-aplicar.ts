/**
 * Escrever o "¤ Valor da Consulta" no cartão, do mesmo jeito nos dois caminhos que gravam (a varredura da franquia e a Sofia ao
 * agendar): relê o cartão, confere, grava e guarda a marca. Só quem DECIDIU (`decidirValorDaConsulta`) chama.
 */
import type { KommoClient, KommoLead, KommoLeadCustomField } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { emCentavos, type DecisaoValorDaConsulta } from './valor-consulta.js';
import type { MarcasDoValor } from './valor-consulta-marca.js';

export interface CampoDoValor {
  id: number;
  type: KommoLeadCustomField['type'];
  enums: Array<{ id: number; value: string }>;
}

/** O que o cartão tem hoje no campo: `null` = vazio. */
export const valorNoCartao = (lead: Pick<KommoLead, 'custom_fields_values'>, campoId: number): string | null => {
  const v = lead.custom_fields_values?.find((f) => f.field_id === campoId)?.values?.[0]?.value;
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v);
};

/**
 * A troca só vale para o que o PRÓPRIO robô pôs: o cartão tem exatamente o número da marca E a última mudança do campo foi de
 * integração (`created_by` 0), nunca de uma pessoa. Sem conseguir perguntar ao Kommo, não troca.
 */
export async function robotPodeTrocar(kommo: Pick<KommoClient, 'autorDaUltimaMudancaDoCampo'>, leadId: number, campoId: number): Promise<boolean> {
  return (await kommo.autorDaUltimaMudancaDoCampo(leadId, campoId)) === 0;
}

export type ResultadoDaGravacao = 'gravou' | 'mudou-no-meio' | 'nao-e-do-robo';

export async function gravarValorDaConsulta(a: {
  unit: { id: string; slug: string };
  kommo: Pick<KommoClient, 'getLead' | 'setLeadCustomFieldValue' | 'autorDaUltimaMudancaDoCampo'>;
  leadId: number;
  campo: CampoDoValor;
  decisao: Extract<DecisaoValorDaConsulta, { valor: number }>;
  /** a marca que sustentou a troca (centavos) */
  marcaEsperada: number | null;
  /** só unidade com pagamento antecipado guarda marca */
  marcas?: MarcasDoValor;
  origem: 'sofia' | 'sincronizador';
}): Promise<ResultadoDaGravacao> {
  const { unit, kommo, leadId, campo, decisao } = a;
  // O cartão desta decisão tem minutos de idade: a recepção pode ter digitado o valor (ou um 0 de cortesia) nesse meio-tempo.
  const fresco = await kommo.getLead(leadId);
  const atual = valorNoCartao(fresco, campo.id);
  if (decisao.troca) {
    if (atual === null || a.marcaEsperada === null || emCentavos(atual) !== a.marcaEsperada) return 'mudou-no-meio';
    if (!(await robotPodeTrocar(kommo, leadId, campo.id))) return 'nao-e-do-robo';
  } else if (atual !== null) {
    return 'mudou-no-meio';
  }
  await kommo.setLeadCustomFieldValue(leadId, campo.id, campo.type, decisao.valor, campo.enums);
  if (a.marcas && decisao.qual) {
    // sem a marca o valor fica como está (ninguém o troca): o lado seguro
    await a.marcas
      .guardar(unit.id, leadId, { centavos: Math.round(decisao.valor * 100), qual: decisao.qual }, a.origem)
      .catch((err) => logger.warn({ err, unit: unit.slug, leadId }, 'valor-consulta: gravei o valor mas não consegui guardar a marca — o robô não vai trocá-lo depois'));
  }
  return 'gravou';
}
