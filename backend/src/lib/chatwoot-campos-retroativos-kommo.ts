/**
 * Os cartões do Kommo de um telefone, já em nomes (funil, etapa, motivo de perda) para `decidirCampos`. Só leitura.
 * Separado do script para ser testado com um Kommo de mentira.
 *
 *  - o número tem de ser o MESMO (DDI+DDD e os 8 últimos dígitos; o Kommo guarda muita gente sem o 55): os 8 dígitos sozinhos juntariam gente de DDD diferente;
 *  - TODOS os cartões do número, sem corte: quem tem muitos cartões antigos não pode esconder o aberto e carimbar Perdido de um velho. Leitura em lotes
 *    de 50 (`listLeadsPorIds`), como `chatwoot-cartao-kommo.ts`: um cartão apagado ou fundido não derruba a consulta do telefone.
 */
import type { KommoClient, KommoPipeline } from '../services/kommo.service.js';
import { mesmoFone, type LeadDoKommo } from './chatwoot-campos-retroativos.js';

export interface DadosDoKommo {
  kommo: Pick<KommoClient, 'buscarContatosPorTelefone' | 'listLeadsPorIds'>;
  funilDe: ReadonlyMap<number, KommoPipeline>;
  motivoDe: ReadonlyMap<number, string>;
  /** pausa entre a busca e a leitura (≤ 4 requisições por segundo no Kommo) */
  pausa: (ms: number) => Promise<void>;
}

export async function leadsDoTelefone(k: DadosDoKommo, telefone: string): Promise<LeadDoKommo[]> {
  const d = telefone.replace(/\D/g, '');
  if (d.length < 8) return [];
  const contatos = await k.kommo.buscarContatosPorTelefone(d.slice(-8), 10);
  const ids = [...new Set(contatos.filter((c) => c.telefones.some((t) => mesmoFone(t, telefone))).flatMap((c) => c.leadIds))];
  if (!ids.length) return [];
  await k.pausa(300);
  const saida: LeadDoKommo[] = [];
  for (const l of await k.kommo.listLeadsPorIds(ids)) {
    const funil = k.funilDe.get(l.pipeline_id);
    const status = funil?.statuses.find((x) => x.id === l.status_id);
    if (!funil || !status) continue;
    saida.push({ id: l.id, funil: funil.name, etapa: status.name, statusId: l.status_id, atualizadoEm: Number(l.updated_at) || 0, motivoPerda: l.loss_reason_id ? k.motivoDe.get(l.loss_reason_id) ?? null : null });
  }
  return saida;
}
