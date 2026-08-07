// ============================================================================
// reminder-worker.ts — lembrete de véspera da consulta.
//
// O QUE ELE FAZ, E O QUE NÃO FAZ
// ------------------------------
// Uma vez por dia, na hora configurada da unidade, varre as consultas de
// AMANHÃ e aciona o Salesbot de lembrete. Ele NÃO manda mensagem — o Salesbot
// é quem envia, e envia um TEMPLATE (a única coisa que atravessa a janela de
// 24h; quem marcou faz dias já está fora dela). O worker é só o relógio.
//
// POR QUE NO NOSSO BACKEND, E NÃO NO KOMMO OU N8N
// -----------------------------------------------
// A verdade do horário mora na franquia, e a recepção remarca por lá sem
// avisar. Só o nosso `agenda-reconcile` lê isso ao vivo. Um timer do Kommo
// preso ao momento do agendamento lembraria o horário velho; um fluxo n8n
// teria que reimplementar toda a leitura da franquia. Aqui reaproveitamos o
// que já está testado.
//
// NASCE GUARDADO
// --------------
// Sem `reminderEnabled` e `reminderSalesbotId` na unidade, a varredura roda e
// não faz nada. Pode subir antes do template existir — dorme até ser ligado.
//
// UMA VEZ POR DIA, DE VERDADE
// ---------------------------
// A varredura roda de hora em hora, mas só AGE quando o relógio local cruza a
// hora configurada. `ultimoEnvioPorUnidade` trava reenvio no mesmo dia — sem
// isso, um restart do processo na hora do disparo mandaria o lembrete de novo.
// ============================================================================

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import type { Unit } from '@prisma/client';

const SWEEP_MS = 60 * 60_000; // de hora em hora; só age na hora configurada
let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** unitId → "YYYY-MM-DD" do último dia em que o lembrete já disparou. */
const ultimoEnvioPorUnidade = new Map<string, string>();

/** "YYYY-MM-DD" e hora local (0–23) agora, no fuso da clínica. */
function agoraLocal(tz: string): { dia: string; hora: number } {
  const iso = SpineService.instanteNoFuso(new Date(), tz || 'America/Sao_Paulo');
  return { dia: iso.slice(0, 10), hora: Number(iso.slice(11, 13)) };
}

/** Soma dias a "YYYY-MM-DD" sem depender de fuso. */
function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

async function lembrarUnidade(unit: Unit): Promise<void> {
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const { dia, hora } = agoraLocal(tz);

  // Já não é a hora, ou já disparou hoje.
  if (hora < unit.reminderHourLocal) return;
  if (ultimoEnvioPorUnidade.get(unit.id) === dia) return;
  // GUARD: só age com bot e flag. Marca o dia como feito mesmo assim, pra não
  // reavaliar de hora em hora até a meia-noite.
  if (!unit.reminderEnabled || !unit.reminderSalesbotId) {
    ultimoEnvioPorUnidade.set(unit.id, dia);
    return;
  }
  if (!unit.spineEnabled || !unit.spineToken) {
    ultimoEnvioPorUnidade.set(unit.id, dia);
    return;
  }

  const amanha = somarDias(dia, 1);

  // Consultas de amanhã que a NOSSA IA marcou (têm vínculo). Reengajar quem a
  // recepção marcou direto não dá: não temos o lead do Kommo pra acionar.
  const links = await prisma.spineLeadLink.findMany({
    where: { unitId: unit.id, spineIdSchedule: { not: null } },
  });

  const kommo = createKommoClient(unit);
  let enviados = 0;
  let pulados = 0;

  for (const link of links) {
    // LÊ O HORÁRIO AO VIVO — pega remarcação/cancelamento de graça. Um lembrete
    // com hora velha é pior que nenhum: manda o paciente na hora errada.
    const consulta = await AgendaReconcileService.consultaDoLead(unit, link.kommoLeadId);
    if (!consulta || consulta.estado !== 'confirmada' || !consulta.quando) {
      pulados++;
      continue;
    }
    if (consulta.quando.slice(0, 10) !== amanha) continue; // não é amanhã

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
    // Varre TODAS as unidades com agenda — o guard interno decide quem age.
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
  // Uma passada no boot, pra não esperar até a próxima hora cheia.
  void varrer();
  logger.info('lembrete de véspera: worker iniciado (guardado por reminderEnabled)');
}

export function stopReminderWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
