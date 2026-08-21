import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { estadoEtapaDoLead } from '../services/lead-stage.service.js';

const SWEEP_MS = 5 * 60_000;
const ESPERA_MIN = 30;
const JANELA_WHATSAPP_MIN = 23 * 60;
const MAX_REATIVACOES = 2;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

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

async function encerrar(convId: string): Promise<void> {
  await prisma.conversation
    .update({ where: { id: convId }, data: { handoffAt: null } })
    .catch(() => undefined);
}

async function reativarUnidade(unit: Unit): Promise<void> {
  if (!dentroDoHorario(unit)) return;

  const limite = new Date(Date.now() - ESPERA_MIN * 60_000);
  const candidatas = await prisma.conversation.findMany({
    where: {
      unitId: unit.id,
      handoffAt: { not: null, lte: limite },
      convertedAt: null,
      reactivations: { lt: MAX_REATIVACOES },
    },
    orderBy: { handoffAt: 'asc' },
    take: 40,
  });
  if (candidatas.length === 0) return;

  const kommo = createKommoClient(unit);

  for (const conv of candidatas) {
    const leadId = Number(conv.leadId);
    if (!Number.isFinite(leadId)) {
      await encerrar(conv.id);
      continue;
    }

    const paradoMin = (Date.now() - conv.lastMessageAt.getTime()) / 60_000;
    if (paradoMin > JANELA_WHATSAPP_MIN) {
      await encerrar(conv.id);
      continue;
    }

    try {
      const temConsulta = await prisma.spineLeadLink.findFirst({
        where: { unitId: unit.id, kommoLeadId: leadId, spineIdSchedule: { not: null } },
        select: { id: true },
      });
      if (temConsulta) {
        await encerrar(conv.id);
        continue;
      }

      const etapa = await estadoEtapaDoLead(unit, leadId);
      if (etapa?.jaAgendadoOuPaciente) {
        await encerrar(conv.id);
        continue;
      }

      if (unit.qualificationEnabled) {
        const lead = await kommo.getLead(leadId);
        const tags = (lead?._embedded?.tags ?? []).map((t) => (t.name ?? '').toLowerCase());
        const alvo = (unit.qualificationHotTag ?? 'Quente').toLowerCase();
        if (!tags.includes(alvo)) {
          await encerrar(conv.id);
          continue;
        }
      }

      if (unit.kommoPausedFieldId) {
        await kommo
          .setLeadFieldFlag(leadId, unit.kommoPausedFieldId, false)
          .catch((e) => logger.warn({ err: String(e), leadId }, 'reativação: falha ao despausar'));
      }

      const { runAgentFollowUp } = await import('../agent/follow-up.js');
      const texto = await runAgentFollowUp({
        unitId: unit.id,
        leadId,
        conversationId: conv.id,
        intencao:
          'REABERTURA PÓS-HANDOFF. Este paciente é QUENTE, demonstrou interesse e tinha ' +
          'queixa de coluna, mas a consulta NÃO foi marcada e a equipe não deu sequência. ' +
          'Reabra o contato com acolhimento, retome de onde parou e conduza pro agendamento ' +
          '(ou encaixe, se a agenda estava cheia). Uma mensagem curta, calorosa e humana — ' +
          'sem parecer automática, sem cobrar, sem citar que houve pausa ou transferência. ' +
          'Ex: "Oi {nome}, aqui é a Sofia 😊 não quero te deixar sem sua consulta — consegui ' +
          'um retorno pra ver seu horário. Quer que eu veja as opções pra você?"',
        ultimoDegrau: false,
      });
      if (!texto) {
        continue;
      }

      await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null });

      await prisma.conversation.update({
        where: { id: conv.id },
        data: { handoffAt: null, reactivations: { increment: 1 } },
      });
      await prisma.message.create({
        data: { conversationId: conv.id, role: 'assistant', content: texto, meta: { reactivation: conv.reactivations + 1 } },
      });

      logger.info(
        { unit: unit.slug, leadId, tentativa: conv.reactivations + 1 },
        'reativação: lead quente reaberto pela IA',
      );
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'reativação: falha — segue');
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { reactivationEnabled: true } });
    for (const unit of unidades) {
      await reativarUnidade(unit).catch((err) =>
        logger.warn({ err: String(err), unit: unit.slug }, 'reativação: unidade falhou'),
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'reativação: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startReactivationWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('reativação: worker iniciado (guardado por reactivationEnabled)');
}

export function stopReactivationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
