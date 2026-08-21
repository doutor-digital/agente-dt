import { prisma } from '../lib/prisma.js';

export interface SlaReportUnit {
  slug: string;
  name: string;
  subdomain: string | null;
  alertedToday: number;
  resolvedAfter: number;
  stillWaiting: Array<{ leadId: string; name: string | null }>;
}

export interface SlaReport {
  date: string;
  units: SlaReportUnit[];
}

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
