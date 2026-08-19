// ============================================================================
// reactivation-worker.ts — NUNCA PERDER LEAD QUENTE.
//
// O PROBLEMA
// ----------
// A IA passa o lead pra um humano (pausar_ia) — red flag, "aguardando encaixe",
// pediu atendente. Aí a secretária esquece, ou não dá sequência, e um lead
// QUENTE, com queixa de coluna, que já queria marcar, apodrece no CRM. Esse é o
// lead mais caro que existe: ele estava a um passo de agendar.
//
// A REGRA (decidida pelo João, 2026-08-10)
// -----------------------------------------
// 30 minutos após o handoff, SE o humano não respondeu nem agendou e o lead é
// quente → a IA despausa e reabre o contato, retomando de onde parou. Se o
// humano respondeu, o webhook zera o `handoffAt` — e este worker nem olha pra
// esse lead. É assim que a IA não atropela a secretária.
//
// POR QUE REUSA O FOLLOW-UP
// -------------------------
// O motor de "IA manda mensagem sozinha" já existe (runAgentFollowUp +
// sendChatReply). Aqui só muda O ALVO e A INTENÇÃO — não reinventamos entrega.
//
// GUARDAS
// -------
//   - só unidades com `reactivationEnabled` (OFF por padrão — piloto)
//   - dentro do horário comercial (msg às 3h queima o contato)
//   - lead sem consulta marcada (SpineLeadLink.spineIdSchedule)
//   - lead QUENTE (tag de quente no Kommo), quando a unidade usa qualificação
//   - janela de 24h do WhatsApp aberta (senão msg livre não chega)
//   - teto de reativações por conversa (anti-perseguição)
//
// Estado no BANCO (`handoffAt`, `reactivations`): sobrevive a restart e vale
// pra todas as réplicas ao mesmo tempo.
// ============================================================================

import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { estadoEtapaDoLead } from '../services/lead-stage.service.js';

const SWEEP_MS = 5 * 60_000; // a cada 5 min — o degrau é de 30, não precisa de mais fino
const ESPERA_MIN = 30; // 30 min após o handoff (regra do João)
const JANELA_WHATSAPP_MIN = 23 * 60; // fora disso, mensagem livre não é entregue
const MAX_REATIVACOES = 2; // teto por conversa — depois disso, para de insistir

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** "agora" no relógio da clínica: minutos do dia + dia da semana (0=dom). */
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

/** Mesma janela estreita do follow-up: 08:00–20:00 nos dias de atendimento. */
function dentroDoHorario(unit: Unit): boolean {
  const { minutos, diaSemana } = agoraLocal(unit.spineTimezone ?? 'America/Sao_Paulo');
  const dias = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(diaSemana)) return false;
  const abre = Math.max(paraMinutos(unit.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const fecha = Math.min(paraMinutos(unit.spineAgendaEnd) ?? 20 * 60, 20 * 60);
  return minutos >= abre && minutos < fecha;
}

/** Limpa o handoff pendente (não é mais candidato) sem estourar por erro. */
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

    // Janela de 24h: passou disso, mensagem livre não chega. Desiste sem gastar
    // chamada de modelo. (Referência: última atividade da conversa.)
    const paradoMin = (Date.now() - conv.lastMessageAt.getTime()) / 60_000;
    if (paradoMin > JANELA_WHATSAPP_MIN) {
      await encerrar(conv.id);
      continue;
    }

    try {
      // 1. Consulta já marcada? Então não há o que reativar.
      const temConsulta = await prisma.spineLeadLink.findFirst({
        where: { unitId: unit.id, kommoLeadId: leadId, spineIdSchedule: { not: null } },
        select: { id: true },
      });
      if (temConsulta) {
        await encerrar(conv.id);
        continue;
      }

      // 1b. TRAVA por etapa (pega o LEGADO). O `temConsulta` acima só enxerga
      //     agendamento feito pela própria IA (SpineLeadLink). Lead migrado do
      //     sistema antigo, já agendado, não tem esse link — e a reabertura
      //     ("não quero te deixar sem sua consulta") cai justamente em cima de
      //     quem JÁ está agendado (bug de Parauapebas). A etapa do Kommo é a
      //     verdade que vale pro legado: se ele já agendou / é paciente, encerra.
      const etapa = await estadoEtapaDoLead(unit, leadId);
      if (etapa?.jaAgendadoOuPaciente) {
        await encerrar(conv.id);
        continue;
      }

      // 2. É quente? Só reativa lead quente. Se a unidade não usa qualificação,
      //    o próprio handoff + sem-consulta já basta como sinal.
      if (unit.qualificationEnabled) {
        const lead = await kommo.getLead(leadId);
        const tags = (lead?._embedded?.tags ?? []).map((t) => (t.name ?? '').toLowerCase());
        const alvo = (unit.qualificationHotTag ?? 'Quente').toLowerCase();
        if (!tags.includes(alvo)) {
          await encerrar(conv.id); // frio/morno não entra na rede
          continue;
        }
      }

      // 3. Despausa a IA (senão a mensagem dela é barrada pelo guard de pausa).
      if (unit.kommoPausedFieldId) {
        await kommo
          .setLeadFieldFlag(leadId, unit.kommoPausedFieldId, false)
          .catch((e) => logger.warn({ err: String(e), leadId }, 'reativação: falha ao despausar'));
      }

      // 4. Gera a reabertura (reusa o motor do follow-up) e entrega.
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
        // Falha de geração: não consome tentativa, tenta na próxima varredura.
        continue;
      }

      await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null });

      // 5. Consome a tentativa e fecha este handoff. Só re-arma se a IA pausar de
      //    novo (novo handoffAt). O contador é o teto vitalício por conversa.
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
      // Não encerra nem consome tentativa: erro de rede tenta de novo depois.
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
