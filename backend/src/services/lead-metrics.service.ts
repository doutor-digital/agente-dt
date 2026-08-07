// ============================================================================
// lead-metrics.service.ts — as MÉTRICAS IA que são conta, não julgamento.
//
// Os campos "Status", "Intenção", "Sentimento" etc. a IA preenche por decisão
// (registra_*). Estes NÃO são decisão: são timestamp, tempo e contagem, que a
// gente já tem no banco (Conversation, Message). Ninguém os calculava, então
// ficavam 0% preenchidos até nos leads que conversaram. Aqui a gente computa e
// carimba no Kommo.
//
// FIRE-AND-FORGET: rodam FORA do caminho da resposta (a mensagem já saiu). Uma
// falha aqui não pode atrasar nem derrubar o atendimento.
//
// IDs desta unidade (mesmo padrão de agenda-tools). Multi-unidade → virar
// config por-unit depois.
// ============================================================================

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient } from './kommo.service.js';
import type { Unit } from '@prisma/client';

const CAMPO_DATA_1A_RESPOSTA = 2443015; // ◷ Data/hora da 1ª resposta (date_time)
const CAMPO_TEMPO_1A_RESPOSTA = 2443017; // # Tempo até 1ª resposta (min)
const CAMPO_NUM_MENSAGENS = 2443021; // # Nº de mensagens trocadas
const CAMPO_TEMPO_AGENDAMENTO = 2443019; // # Tempo até agendamento (h)

type KommoUnit = Parameters<typeof createKommoClient>[0];

/** Dispara a atualização das métricas de turno sem bloquear a resposta. */
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

  // Nº de mensagens: muda a cada turno, então grava sempre.
  await kommo.setLeadCustomFieldValue(leadId, CAMPO_NUM_MENSAGENS, 'numeric', msgs.length);

  // 1ª resposta: acontece UMA vez. Grava só no turno em que a 1ª resposta da IA
  // aparece (1 mensagem de assistente) — nas voltas seguintes o valor não muda,
  // e reescrever toda vez seria chamada de API à toa.
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

/**
 * Tempo até agendamento (h) — do 1º contato até marcar a consulta. Chamado
 * quando a marcação dá certo (agenda-tools). Recebe o kommo já pronto porque
 * quem chama já tem um.
 */
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
