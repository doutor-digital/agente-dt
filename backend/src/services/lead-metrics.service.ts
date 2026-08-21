import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient } from './kommo.service.js';
import type { Unit } from '@prisma/client';

const CAMPO_DATA_1A_RESPOSTA = 2443015;
const CAMPO_TEMPO_1A_RESPOSTA = 2443017;
const CAMPO_NUM_MENSAGENS = 2443021;
const CAMPO_TEMPO_AGENDAMENTO = 2443019;

type KommoUnit = Parameters<typeof createKommoClient>[0];

export function scheduleLeadMetrics(unit: Unit, leadId: number): void {
  void atualizarMetricasDeTurno(unit, leadId).catch((err) => {
    logger.warn({ err: String(err), leadId }, 'lead-metrics: falha ao atualizar (ignorada)');
  });
}

async function atualizarMetricasDeTurno(unit: Unit, leadId: number): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
    select: { id: true },
  });
  if (!conv) return;

  const msgs = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: 'asc' },
    select: { role: true, createdAt: true },
  });
  if (msgs.length === 0) return;

  const kommo = createKommoClient(unit as KommoUnit);

  await kommo.setLeadCustomFieldValue(leadId, CAMPO_NUM_MENSAGENS, 'numeric', msgs.length);

  const assistants = msgs.filter((m) => m.role === 'assistant');
  if (assistants.length === 1) {
    const primeiraResposta = assistants[0].createdAt;
    const primeiroContato = msgs.find((m) => m.role === 'user')?.createdAt ?? msgs[0].createdAt;
    await kommo.setLeadCustomFieldValue(
      leadId,
      CAMPO_DATA_1A_RESPOSTA,
      'date',
      primeiraResposta.toISOString(),
    );
    const min = Math.max(0, Math.round((primeiraResposta.getTime() - primeiroContato.getTime()) / 60_000));
    await kommo.setLeadCustomFieldValue(leadId, CAMPO_TEMPO_1A_RESPOSTA, 'numeric', min);
  }
}

export async function registrarTempoAteAgendamento(
  unit: Unit,
  kommo: ReturnType<typeof createKommoClient>,
  leadId: number,
): Promise<void> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
      select: { id: true },
    });
    if (!conv) return;
    const primeiro = await prisma.message.findFirst({
      where: { conversationId: conv.id, role: 'user' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (!primeiro) return;
    const horas = Math.max(0, Math.round((Date.now() - primeiro.createdAt.getTime()) / 3_600_000));
    await kommo.setLeadCustomFieldValue(leadId, CAMPO_TEMPO_AGENDAMENTO, 'numeric', horas);
  } catch (err) {
    logger.warn({ err: String(err), leadId }, 'lead-metrics: falha no tempo até agendamento');
  }
}
