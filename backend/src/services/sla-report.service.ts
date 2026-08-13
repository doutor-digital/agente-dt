// ============================================================================
// sla-report.service.ts — resumo do dia do SLA de resposta humana.
//
// Conta, por unidade (que tem o SLA ligado), quantos leads estouraram o SLA
// HOJE (foram alertados), quantos já foram respondidos (handoff zerado) e
// quais ainda estão sem resposta agora. Tudo derivado dos campos que o worker
// já grava — `slaAlertAt` e `handoffAt` — sem instrumentação nova.
//
// Consumido pelo n8n (workflow agendado de fim de dia) que formata e manda o
// resumo no grupo do WhatsApp. Ver [[project_sdr_whatsapp_alerts]].
// ============================================================================

import { prisma } from '../lib/prisma.js';

export interface SlaReportUnit {
  slug: string;
  name: string;
  subdomain: string | null;
  /** Leads que estouraram o SLA hoje (slaAlertAt de hoje). */
  alertedToday: number;
  /** Desses, quantos já foram respondidos (handoffAt zerado). */
  resolvedAfter: number;
  /** Ainda sem resposta agora (handoffAt ainda preenchido). */
  stillWaiting: Array<{ leadId: string; name: string | null }>;
}

export interface SlaReport {
  /** Data local (AAAA-MM-DD) da unidade de referência. */
  date: string;
  units: SlaReportUnit[];
}

/** Offset (local - UTC) em ms no fuso `tz` no instante `at`. */
function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - at.getTime();
}

/** Início do dia local (00:00 no fuso) como instante UTC. */
function startOfDayUtc(tz: string): { start: Date; localDate: string } {
  const now = new Date();
  const off = tzOffsetMs(tz, now);
  const local = new Date(now.getTime() + off);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const sodShifted = Date.UTC(y, m, d, 0, 0, 0);
  const localDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start: new Date(sodShifted - off), localDate };
}

/**
 * Monta o resumo do dia para todas as unidades com o SLA ligado.
 * NÃO escreve nada — só lê.
 */
export async function computeSlaReport(): Promise<SlaReport> {
  const units = await prisma.unit.findMany();
  const habilitadas = units.filter((u) => {
    const min = (u.pipelineIntents as Record<string, unknown> | null)?.sla_alert_minutes;
    return min != null && Number(min) > 0;
  });

  let refDate = startOfDayUtc('America/Sao_Paulo').localDate;
  const out: SlaReportUnit[] = [];

  for (const unit of habilitadas) {
    const { start, localDate } = startOfDayUtc(unit.spineTimezone ?? 'America/Sao_Paulo');
    refDate = localDate;

    const alertados = await prisma.conversation.findMany({
      where: { unitId: unit.id, slaAlertAt: { gte: start } },
      select: { leadId: true, contactName: true, handoffAt: true },
    });

    const stillWaiting = alertados
      .filter((c) => c.handoffAt !== null)
      .map((c) => ({ leadId: c.leadId, name: c.contactName }));

    out.push({
      slug: unit.slug,
      name: unit.name ?? unit.slug,
      subdomain: unit.kommoSubdomain,
      alertedToday: alertados.length,
      resolvedAfter: alertados.length - stillWaiting.length,
      stillWaiting,
    });
  }

  return { date: refDate, units: out };
}
