/**
 * «Este paciente já tem cartão ATIVO no Kommo desta unidade?» — decisão 31 do João (12/11/2026): se tem, quem atende é o Kommo e a
 * Sofia do Chatwoot NÃO responde (só deixa nota). Duas Sofias falando com a mesma pessoa, uma em cada canal, é o pior dos mundos.
 *
 * Mesma regra da régua (PR #291, `cartaoNoKommoDaUnidade` em chatwoot-regua-worker.ts, ainda não mesclado): casa pelos 8 últimos
 * dígitos do telefone (com e sem o 9, com e sem o +55) e ignora cartão fechado (142 ganho, 143 perdido). Quando o #291 entrar, esta
 * função deve virar um import dele — está num arquivo à parte justamente para não brigar com aquele PR. Diferença de propósito: os
 * cartões saem numa leitura só (`listLeadsPorIds`, até 50), não um a um — paciente com muitos cartões antigos não esconde o ativo, e um
 * cartão apagado ou fundido não derruba a conferência.
 */
import { createKommoClientSemFreio, type KommoClient } from '../services/kommo.service.js';
import { fim8 } from './paciente-existente.js';

/** Cartão ativo no Kommo da unidade para este telefone (null = nenhum). LANÇA se não deu para consultar. */
export type CartaoNoKommo = (telefone: string) => Promise<{ leadId: number } | null>;

/** status do Kommo que fecham o cartão: 142 = ganho, 143 = perdido */
const FECHADOS_NO_KOMMO = new Set([142, 143]);
const MAX_CARTOES = 50;

export function cartaoNoKommoDaUnidade(
  unit: Parameters<typeof createKommoClientSemFreio>[0],
  /** só o teste troca */
  kommo: Pick<KommoClient, 'buscarContatosPorTelefone' | 'listLeadsPorIds'> = createKommoClientSemFreio(unit),
): CartaoNoKommo {
  return async (telefone) => {
    const fim = fim8(telefone);
    if (!fim) return null;
    const contatos = await kommo.buscarContatosPorTelefone(fim, 10);
    const ids = [...new Set(contatos.filter((c) => c.telefones.some((t) => fim8(t) === fim)).flatMap((c) => c.leadIds))].slice(0, MAX_CARTOES);
    if (!ids.length) return null;
    const cartoes = await kommo.listLeadsPorIds(ids);
    const ativo = cartoes.find((l) => !FECHADOS_NO_KOMMO.has(Number(l.status_id)));
    return ativo ? { leadId: ativo.id } : null;
  };
}
