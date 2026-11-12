/**
 * «Este paciente já tem cartão ATIVO no Kommo desta unidade?» — decisão 31 do João (12/11/2026): se tem, quem atende é o Kommo e a
 * Sofia do Chatwoot NÃO responde (só deixa nota). Duas Sofias falando com a mesma pessoa, uma em cada canal, é o pior dos mundos.
 *
 * Mesma regra da régua (PR #291, `cartaoNoKommoDaUnidade` em chatwoot-regua-worker.ts, ainda não mesclado): casa pelos 8 últimos
 * dígitos do telefone (com e sem o 9, com e sem o +55) e ignora cartão fechado (142 ganho, 143 perdido). Quando o #291 entrar,
 * esta cópia deve virar um import dele — está num arquivo à parte justamente para não brigar com aquele PR.
 */
import { createKommoClientSemFreio } from '../services/kommo.service.js';

/** Cartão ativo no Kommo da unidade para este telefone (null = nenhum). LANÇA se não deu para consultar. */
export type CartaoNoKommo = (telefone: string) => Promise<{ leadId: number } | null>;

/** status do Kommo que fecham o cartão: 142 = ganho, 143 = perdido */
const FECHADOS_NO_KOMMO = new Set([142, 143]);

/** Os 8 últimos dígitos: casa com e sem o 9 e com e sem o +55. */
export function finalDoTelefone(telefone: string | undefined | null): string | null {
  const d = String(telefone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

export function cartaoNoKommoDaUnidade(unit: Parameters<typeof createKommoClientSemFreio>[0]): CartaoNoKommo {
  const kommo = createKommoClientSemFreio(unit);
  return async (telefone) => {
    const fim = finalDoTelefone(telefone);
    if (!fim) return null;
    const contatos = await kommo.buscarContatosPorTelefone(fim, 10);
    const leads = contatos
      .filter((c) => c.telefones.some((t) => finalDoTelefone(t) === fim))
      .flatMap((c) => c.leadIds)
      .slice(0, 8);
    for (const id of leads) {
      const lead = await kommo.getLead(id);
      if (lead && !FECHADOS_NO_KOMMO.has(Number(lead.status_id))) return { leadId: id };
    }
    return null;
  };
}
