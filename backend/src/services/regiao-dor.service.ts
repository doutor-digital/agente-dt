/**
 * Lado com I/O da região da dor (o puro está em `lib/regiao-dor.ts`).
 * Nada aqui pode derrubar a resposta ao paciente: quem chama usa `void` e o erro vira warn.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { classificarRegiao, etiquetasDaRegiao, normalizarTexto, type Regiao } from '../lib/regiao-dor.js';
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

type CampoTipado = Awaited<ReturnType<KommoClient['listLeadCustomFieldsTyped']>>[number];
const TTL_TIPO_MS = 30 * 60_000;
const cacheTipo = new Map<string, { campo: CampoTipado | undefined; expiraEm: number }>();

/** Tipo e opções do campo (cache de 30 min por unidade+campo, como o esquema): evita um GET de todos os campos por dedução. */
async function tipoDoCampo(unit: Unit, kommo: KommoClient, fieldId: number): Promise<CampoTipado | undefined> {
  const chave = `${unit.id}:${fieldId}`;
  const guardado = cacheTipo.get(chave);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.campo;
  const campo = (await kommo.listLeadCustomFieldsTyped()).find((c) => c.id === fieldId);
  cacheTipo.set(chave, { campo, expiraEm: Date.now() + TTL_TIPO_MS });
  return campo;
}

/**
 * A Sofia acabou de gravar a Queixa. Se a conta tem "⚕ Região da dor" e ela ainda está vazia,
 * deduz pela palavra-chave e grava (com etiqueta). "Outra" e "não sei" ficam pra regra dela.
 * Devolve a região gravada, ou null se não gravou.
 */
export async function deduzirRegiaoDaQueixa(
  unit: Unit,
  kommo: KommoClient,
  leadId: number,
  queixa: string,
  esperaMs = 4000,
): Promise<Regiao | null> {
  const regiao = classificarRegiao(queixa);
  if (!regiao || regiao === 'Outra') return null;
  const esquema = await esquemaDaUnidade(unit, kommo);
  const fieldId = esquema.campoPorNome(NOME_CAMPO_REGIAO);
  if (fieldId === null) return null;
  // A IA costuma gravar Região e Queixa no mesmo lote de tools; espera a escrita explícita
  // pousar antes de olhar o cartão, senão a dedução sobrescreve o que ela mesma decidiu.
  // O campo é SELECT na Serra/Imperatriz e MULTISELECT na Timbó (30/10/2026). Multiselect gravado como
  // 'select' sem opções cai em `{value: texto}` e o Kommo pode recusar: aqui vai como lista, com o enum.
  // O tipo é resolvido ANTES da espera e do getLead (e fica em cache), para a checagem "campo vazio" ficar
  // colada na escrita. Se a leitura do tipo falhar, não grava (o chamador registra o aviso).
  const campo = await tipoDoCampo(unit, kommo, fieldId);
  await new Promise((r) => setTimeout(r, esperaMs));
  const lead = await kommo.getLead(leadId);
  if (valorAtual(lead, fieldId)) return null;
  if (campo?.type === 'multiselect') {
    if (!campo.enums.some((e) => normalizarTexto(e.value) === normalizarTexto(regiao))) {
      logger.warn({ unit: unit.slug, leadId, regiao }, 'regiao-dor: opção não existe no multiselect, dedução não gravou');
      return null;
    }
    await kommo.setLeadCustomFieldValue(leadId, fieldId, 'multiselect', [regiao], campo.enums);
  } else {
    await kommo.setLeadCustomFieldValue(leadId, fieldId, 'select', regiao);
  }
  await espelharEtiquetaRegiao(kommo, leadId, regiao);
  logger.info({ unit: unit.slug, leadId, regiao }, 'regiao-dor: deduzida da queixa e gravada');
  return regiao;
}
