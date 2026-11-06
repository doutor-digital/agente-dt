/**
 * «Este cartão nunca agendou?» e o estado da régua ex-lead — o que o `etiquetas-auto` precisa saber sem importar o worker inteiro da
 * rotina (a Rotina «ex-lead» ABSORVE a ▶ Reativação de quem nunca agendou, onde está LIGADA).
 */
import type { Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { franquiaDoPaciente, type NaFranquia } from './parados-worker.js';
import { cartaoMostraConsulta, franquiaTemHistorico } from './rotina-nucleo.js';

export const ID_ROTINA_EXLEAD = 'rotina-exlead';

export const estadoDoExLead = (slug: string, raw: string | undefined = process.env.ROTINA_EXLEAD_SLUGS): Estado => estadoDaAutomacao(slug, ID_ROTINA_EXLEAD, raw);

/**
 * Este cartão nunca agendou? Nem o cartão mostra consulta, nem a franquia tem agendamento ou tratamento dele. Lança se a franquia
 * não responder — "caiu" nunca vira "nunca agendou". Sem franquia na unidade, vale o cartão. Paciente que a franquia não conhece
 * (nem por vínculo, nome ou telefone) conta como «nunca agendou»: é o caso normal do ex-lead, e o risco é um ex-paciente cadastrado
 * com outro nome receber a reativação.
 */
export async function nuncaAgendou(
  unit: Unit,
  lead: KommoLead,
  franquia: (unit: Unit, leadId: number, nome: string | null, agora: number) => Promise<NaFranquia> = franquiaDoPaciente,
  agora = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (cartaoMostraConsulta(lead)) return false;
  const f = await franquia(unit, lead.id, lead.name ?? null, agora);
  return !franquiaTemHistorico(f);
}
