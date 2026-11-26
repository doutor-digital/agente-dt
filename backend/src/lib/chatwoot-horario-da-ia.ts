/**
 * Horário e feriado da Sofia do CRM (Chatwoot) — a MESMA configuração que a Sofia do Kommo já usa.
 *
 * Por que existe (26/11/2026): as unidades reclamam que «a Sofia muda no fim de semana ou feriado» e que «fala por cima da equipe no
 * expediente». No Kommo o portão é `checkBusinessHours` (`business_hours_*`, `business_hours_expediente`, feriado nacional); a Sofia do
 * CRM nunca o consultou — respondia 24 h em qualquer unidade. Aqui ela passa a perguntar à MESMA função, sem regra nova:
 *
 *  - `business_hours_enabled = false` (o padrão, e o de Parauapebas): `checkBusinessHours` devolve `enabled: false` e NADA muda — 24 h como hoje;
 *  - janela comum (ex.: 9h–18h): a Sofia atende dentro dela, e o feriado nacional fecha;
 *  - janela invertida (18h→06h) ou expediente (`business_hours_expediente`: Caxias, Petrópolis, Taubaté): é o modo «só fora do expediente» —
 *    a IA atende quando a clínica está FECHADA (noite, fim de semana e feriado emendados) e fica calada enquanto a equipe atende.
 *
 * Fora da janela a Sofia NÃO responde e NÃO manda a mensagem de «fora do horário» (`out_of_hours_message`) — o CRM nunca mandou essa mensagem e a
 * equipe atende quando a clínica abre; a conversa vai para «Abertas». A exceção é «Sofia atende todos» (Ponte, `ia_todos_ate`): vale até o prazo.
 * O «Passar para a Sofia» POR CONVERSA (Ponte do Kommo) não existe no CRM e não é replicado aqui.
 */
import type { Unit } from '@prisma/client';
import { checkBusinessHours } from '../agent/prompt-composer.js';

/** A IA deve ficar calada agora nesta unidade por causa do horário (janela, expediente ou feriado)? Sem configuração: nunca. */
export function foraDoHorarioDaIa(unit: Unit, agora: Date = new Date()): boolean {
  if (!unit.businessHoursEnabled) return false;
  if (unit.iaTodosAte && unit.iaTodosAte.getTime() > agora.getTime()) return false;
  const h = checkBusinessHours(unit, agora);
  return h.enabled && !h.isOpen;
}
