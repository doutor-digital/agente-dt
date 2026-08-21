import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import type { Unit } from '@prisma/client';

const SWEEP_MS = 60 * 60_000;
let timer: NodeJS.Timeout | null = null;
let rodando = false;

const ultimoEnvioPorUnidade = new Map<string, string>();

function agoraLocal(tz: string): { dia: string; hora: number } {
  const iso = SpineService.instanteNoFuso(new Date(), tz || 'America/Sao_Paulo');
  return { dia: iso.slice(0, 10), hora: Number(iso.slice(11, 13)) };
}

function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

async function lembrarUnidade(unit: Unit): Promise<void> {
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const { dia, hora } = agoraLocal(tz);

  if (hora < unit.reminderHourLocal) return;
  if (ultimoEnvioPorUnidade.get(unit.id) === dia) return;
  if (!unit.reminderEnabled || !unit.reminderSalesbotId) {
    ultimoEnvioPorUnidade.set(unit.id, dia);
    return;
  }
  if (!unit.spineEnabled || !unit.spineToken) {
    ultimoEnvioPorUnidade.set(unit.id, dia);
    return;
  }

  const amanha = somarDias(dia, 1);

  const links = await prisma.spineLeadLink.findMany({
    where: { unitId: unit.id, spineIdSchedule: { not: null } },
  });

  const kommo = createKommoClient(unit);
  let enviados = 0;
  let pulados = 0;

  for (const link of links) {
    const consulta = await AgendaReconcileService.consultaDoLead(unit, link.kommoLeadId);
    if (!consulta || consulta.estado !== 'confirmada' || !consulta.quando) {
      pulados++;
      continue;
    }
    if (consulta.quando.slice(0, 10) !== amanha) continue;

    const r = await kommo.triggerSalesbot(unit.reminderSalesbotId, link.kommoLeadId);
    if (r.ok) {
      enviados++;
    } else {
      logger.warn(
        { unit: unit.slug, kommoLeadId: link.kommoLeadId, erro: r.error },
        'lembrete: falha ao acionar o Salesbot',
      );
    }
  }

  ultimoEnvioPorUnidade.set(unit.id, dia);
  logger.info(
    { unit: unit.slug, amanha, enviados, pulados, candidatos: links.length },
    'lembrete de véspera: varredura concluída',
  );
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { spineEnabled: true } });
    for (const unit of unidades) {
      await lembrarUnidade(unit).catch((err) => {
        logger.warn({ err: String(err), unit: unit.slug }, 'lembrete: erro na unidade (ignorado)');
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'lembrete: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startReminderWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  void varrer();
  logger.info('lembrete de véspera: worker iniciado (guardado por reminderEnabled)');
}

export function stopReminderWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
