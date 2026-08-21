import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';

const SWEEP_MS = 60_000;
const DEFAULT_MIN = 5;
const MAX_ATRASO_MIN = 30;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

function limiarMin(unit: Unit): number | null {
  const cfg = (unit.pipelineIntents as Record<string, unknown> | null)?.sla_alert_minutes;
  if (cfg === true) return DEFAULT_MIN;
  const n = Number(cfg);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function agoraLocal(tz: string): { minutos: number; diaSemana: number } {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minutos: h * 60 + m,
    diaSemana: dias[p.find((x) => x.type === 'weekday')?.value ?? 'Mon'] ?? 1,
  };
}

function paraMinutos(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function dentroDoHorario(unit: Unit): boolean {
  const { minutos, diaSemana } = agoraLocal(unit.spineTimezone ?? 'America/Sao_Paulo');
  const dias = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(diaSemana)) return false;
  const abre = Math.max(paraMinutos(unit.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const fecha = Math.min(paraMinutos(unit.spineAgendaEnd) ?? 20 * 60, 20 * 60);
  return minutos >= abre && minutos < fecha;
}

function humanizarEspera(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
}

async function alertarUnidade(unit: Unit): Promise<void> {
  const min = limiarMin(unit);
  if (!min) return;
  if (!dentroDoHorario(unit)) return;

  const agora = Date.now();
  const teto = new Date(agora - min * 60_000);
  const piso = new Date(agora - (min + MAX_ATRASO_MIN) * 60_000);
  const candidatas = await prisma.conversation.findMany({
    where: {
      unitId: unit.id,
      handoffAt: { not: null, lte: teto, gte: piso },
      slaAlertAt: null,
      convertedAt: null,
    },
    orderBy: { handoffAt: 'asc' },
    take: 40,
  });
  if (candidatas.length === 0) return;

  const kommo = createKommoClient(unit);
  const filtroEtapas = unit.slaAlertStatusIds ?? [];

  for (const conv of candidatas) {
    const leadId = Number(conv.leadId);
    if (!Number.isFinite(leadId)) {
      await prisma.conversation
        .update({ where: { id: conv.id }, data: { slaAlertAt: new Date() } })
        .catch(() => undefined);
      continue;
    }

    try {
      const precisaLead = filtroEtapas.length > 0 || !conv.contactName?.trim();
      const lead = precisaLead ? await kommo.getLead(leadId).catch(() => null) : null;

      if (filtroEtapas.length > 0) {
        if (!lead) continue;
        if (!filtroEtapas.includes(lead.status_id)) {
          await prisma.conversation
            .update({ where: { id: conv.id }, data: { handoffAt: null } })
            .catch(() => undefined);
          continue;
        }
      }

      const nome = conv.contactName?.trim() || (lead?.name ?? '').trim();
      const contato = nome ? `[Contato: ${nome}] ` : '';
      const espera = humanizarEspera(Date.now() - (conv.handoffAt as Date).getTime());
      const texto =
        `ALERTA · ${unit.slug} · ${contato}` +
        `Lead aguardando há ${espera} e ninguém respondeu (IA pausada). Priorizar!`;
      const completeAt = Math.floor(Date.now() / 1000);

      const res = await kommo.createTask({ leadId, text: texto, completeAt });
      if (res) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { slaAlertAt: new Date() },
        });
        logger.info({ unit: unit.slug, leadId, espera }, 'SLA: alerta de humano sem resposta criado');
      }
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'SLA: falha ao criar alerta — segue');
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany();
    for (const unit of unidades) {
      await alertarUnidade(unit).catch((err) =>
        logger.warn({ err: String(err), unit: unit.slug }, 'SLA: unidade falhou'),
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'SLA: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startSlaAlertWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('SLA: worker iniciado (opt-in por pipelineIntents.sla_alert_minutes)');
}

export function stopSlaAlertWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
