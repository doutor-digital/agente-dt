/**
 * NO MÁXIMO 2 COBRANÇAS POR DIA (auditoria de Araguaína, 21/10/2026).
 *
 * O caso: Cristina, lead 28655414, 15/10. A Sofia ofereceu horário às 08:20 e a régua mandou degrau às 08:30,
 * 09:28, 11:28 e 17:29 — quatro cobranças no mesmo dia para quem não respondeu, com a equipe ligando e escrevendo
 * no meio. A escada de qualificação tem degraus de 5 min, 30 min, 2 h, 6 h e 20 h: só o de 20 h cai no dia seguinte,
 * então quatro saíam no mesmo dia por desenho.
 *
 * A REGRA: por conversa (o lead, em todas as unidades da mesma conta do Kommo — comercial e resgate dividem o
 * cartão), contam os envios automáticos de retomada (degrau da régua e reativação) feitos no DIA DE CALENDÁRIO da
 * unidade, no fuso dela. Chegou a 2, nada mais sai até a meia-noite local. O degrau não é pulado: no dia seguinte a
 * régua retoma de onde der (ou para, se a janela de 24 h do WhatsApp fechou).
 *
 * A fala da EQUIPE não entra na conta de propósito: equipe falando por último já para a régua de vez
 * (`decidirCobranca` → 'parar_equipe', e a pausa pela equipe do #100); contá-la aqui não mudaria nada.
 */
import { prisma } from './prisma.js';
import { dataLocalISO } from './feriados.js';

export const LIMITE_COBRANCAS_POR_DIA = 2;

/** A mensagem gravada é um envio automático de retomada (degrau da régua ou reativação)? */
export function ehEnvioDeRetomada(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as { followUp?: unknown; reactivation?: unknown };
  return m.followUp != null || m.reactivation != null;
}

/** PURA. Quantos envios caem no mesmo dia de calendário de `agora`, no fuso `tz`. */
export function cobrancasNoDia(envios: ReadonlyArray<Date>, agora: Date, tz: string): number {
  const hoje = dataLocalISO(agora, tz);
  return envios.filter((e) => dataLocalISO(e, tz) === hoje).length;
}

/** PURA. Já saíram as cobranças do dia? */
export function limiteDoDiaAtingido(
  envios: ReadonlyArray<Date>,
  agora: Date,
  tz: string,
  limite: number = LIMITE_COBRANCAS_POR_DIA,
): boolean {
  return cobrancasNoDia(envios, agora, tz) >= limite;
}

/**
 * Os envios de retomada das últimas 24 h para este lead, em todas as unidades da mesma conta do Kommo. A janela de
 * 24 h cobre qualquer "hoje" local; o corte pelo dia é de `cobrancasNoDia`.
 */
export async function enviosDeRetomadaRecentes(
  unit: { id: string; kommoSubdomain: string | null },
  leadId: string,
  agora: Date = new Date(),
): Promise<Date[]> {
  const unidades = unit.kommoSubdomain
    ? (await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } })).map((u) => u.id)
    : [unit.id];
  const msgs = await prisma.message.findMany({
    where: {
      role: 'assistant',
      createdAt: { gte: new Date(agora.getTime() - 24 * 3600_000) },
      conversation: { leadId, unitId: { in: unidades.length ? unidades : [unit.id] } },
    },
    select: { createdAt: true, meta: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return msgs.filter((m) => ehEnvioDeRetomada(m.meta)).map((m) => m.createdAt);
}
