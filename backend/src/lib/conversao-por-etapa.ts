/**
 * Qual mudança de etapa (`status_lead`) é CONVERSÃO — "agendou" para o juiz e para a memória do lead.
 *
 * `units.kommo_won_status_ids` guarda só ids de etapa, e 142 (ganho) / 143 (perdido) são ids de SISTEMA
 * que se repetem em todo funil: o 142 do funil TRATAMENTO é a ALTA. Com o `status_lead` chegando (16/10/2026),
 * paciente recebendo alta contaria como "agendou" (revisão de 16/10, item 4). Regra:
 *  - etapa no funil TRATAMENTO nunca é conversão (é o pós-venda);
 *  - 142/143 só valem com o funil conhecido; sem saber o funil, não se afirma conversão;
 *  - etapa de id próprio da conta (não 142/143) diz o funil sozinha — vale como sempre valeu.
 */
import { normalizarNome } from './kommo-schema.js';

const IDS_DE_SISTEMA = new Set([142, 143]);

export interface EventoDeEtapa {
  id: number;
  status_id?: number;
  pipeline_id?: number;
}

export function ehFunilDeTratamento(nomeDoFunil: string | null | undefined): boolean {
  return normalizarNome(nomeDoFunil ?? '').includes('tratamento');
}

/** PURA: o primeiro evento que é conversão de verdade, ou null. `nomeDoFunil` null = esquema da conta indisponível. */
export function eventoDeConversao<T extends EventoDeEtapa>(
  eventos: readonly T[],
  ganho: ReadonlySet<number>,
  nomeDoFunil: ((pipelineId: number) => string | null) | null,
): T | null {
  for (const e of eventos) {
    if (e.status_id === undefined || !ganho.has(e.status_id)) continue;
    const funil = e.pipeline_id && nomeDoFunil ? nomeDoFunil(e.pipeline_id) : null;
    if (funil && ehFunilDeTratamento(funil)) continue;
    if (!funil && IDS_DE_SISTEMA.has(e.status_id)) continue;
    return e;
  }
  return null;
}
