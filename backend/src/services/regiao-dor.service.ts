/**
 * Lado com I/O da região da dor (o puro está em `lib/regiao-dor.ts`).
 * Nada aqui pode derrubar a resposta ao paciente: quem chama usa `void` e o erro vira warn.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { classificarRegiao, etiquetasDaRegiao, type Regiao } from '../lib/regiao-dor.js';
import type { KommoClient, KommoLead } from './kommo.service.js';

export const NOME_CAMPO_REGIAO = '⚕ Região da dor';

/** Coloca a etiqueta da região (lombar/cervical) e tira a outra. Torácica/Outra só tiram. */
export async function espelharEtiquetaRegiao(kommo: KommoClient, leadId: number, valor: unknown): Promise<void> {
  const { colocar, tirar } = etiquetasDaRegiao(valor);
  if (colocar) await kommo.addTag({ leadId, tag: colocar });
  for (const t of tirar) await kommo.removeTag(leadId, t).catch(() => undefined);
}

function valorAtual(lead: KommoLead, fieldId: number): string | null {
  const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === fieldId);
  const v = cf?.values?.[0]?.value;
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * A Sofia acabou de gravar a Queixa. Se a conta tem "⚕ Região da dor" e ela ainda está vazia,
 * deduz pela palavra-chave e grava (com etiqueta). "Outra" e "não sei" ficam pra regra dela.
 * Devolve a região gravada, ou null se não gravou.
 */
export async function deduzirRegiaoDaQueixa(unit: Unit, kommo: KommoClient, leadId: number, queixa: string): Promise<Regiao | null> {
  const regiao = classificarRegiao(queixa);
  if (!regiao || regiao === 'Outra') return null;
  const esquema = await esquemaDaUnidade(unit, kommo);
  const fieldId = esquema.campoPorNome(NOME_CAMPO_REGIAO);
  if (fieldId === null) return null;
  const lead = await kommo.getLead(leadId);
  if (valorAtual(lead, fieldId)) return null;
  await kommo.setLeadCustomFieldValue(leadId, fieldId, 'select', regiao);
  await espelharEtiquetaRegiao(kommo, leadId, regiao);
  logger.info({ unit: unit.slug, leadId, regiao }, 'regiao-dor: deduzida da queixa e gravada');
  return regiao;
}
