// ============================================================================
// follow-up-worker.ts — Reengaja quem parou de responder.
//
// POR QUE ISTO EXISTE
// -------------------
// `followUpEnabled` e o texto no prompt já existiam há tempos — a IA chegava a
// prometer "te chamo depois". Só que ninguém chamava: não havia worker nenhum.
// Era uma promessa que o sistema nunca cumpriu.
//
// A ESCADA CABE NA JANELA DE 24 HORAS, e isso não é detalhe
// ----------------------------------------------------------
// O WhatsApp só permite mensagem livre dentro de 24h desde a última mensagem
// DO PACIENTE. Passou disso, só template aprovado pela Meta — outro produto,
// que custa por envio e não aceita texto escrito na hora. Uma escada que
// terminasse em 72h simplesmente não seria entregue.
//
// Por isso o último degrau é em 20h: última chance antes de a porta fechar, e
// por isso ele é o de despedida.
//
// Os intervalos crescem porque a razão do silêncio muda. Aos 5 minutos quase
// sempre é distração — a pessoa largou o celular no meio da conversa e volta.
// Depois de horas, distração já não explica: ou ela decidiu não seguir, ou algo
// travou. Insistir no mesmo ritmo aí vira perseguição, e paciente perseguido
// não só não volta como conta pros outros.
//
// UM CÉREBRO SÓ DECIDE QUANDO FALAR
// ---------------------------------
// O Salesbot é o CANAL (o PATCH no campo dispara a entrega), nunca um segundo
// motor de follow-up. Se o Kommo também tivesse um temporizador mirando o
// mesmo lead, os dois disparariam sem se ver — e mensagem duplicada no
// WhatsApp não tem desfazer. Este arquivo é o único lugar que decide o quando.
//
// QUANDO NÃO MANDA
// ----------------
//   - fora do horário comercial da unidade (mensagem às 3h queima o contato)
//   - se o paciente respondeu (a escada zera: quem voltou não sumiu)
//   - se já marcou consulta, ou pediu pra parar, ou a escada acabou
//
// Estado no BANCO, não em memória: diferente dos outros sweepers daqui, perder
// isto num restart faria a escada recomeçar e o paciente receber tudo de novo.
// ============================================================================

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';

/** Varredura a cada minuto: o primeiro degrau é de 5 min e precisa de resolução. */
const SWEEP_MS = 60_000;

/**
 * Degraus em minutos desde a última mensagem nossa sem resposta.
 * `intencao` vira instrução pro modelo — não é o texto final. Texto fixo em
 * cinco degraus soa exatamente como o que é.
 */
interface Degrau {
  aposMin: number;
  intencao: string;
}

const ESCADA: Degrau[] = [
  {
    aposMin: 5,
    intencao:
      'Toque leve, uma linha, como quem continua a mesma conversa. NÃO recomece ' +
      'nem se reapresente. Retome exatamente onde parou e devolva a pergunta que ' +
      'ficou no ar. Se você tinha oferecido horários, ofereça os mesmos de novo.',
  },
  {
    aposMin: 30,
    intencao:
      'Ele pode ter se distraído. Retome pelo lado DELE — a queixa que ele contou ' +
      '— e facilite a resposta: pergunta fechada, de escolher entre duas opções, ' +
      'não aberta.',
  },
  {
    aposMin: 2 * 60,
    intencao:
      'Traga algo de valor, não só cobrança. Um esclarecimento curto sobre o que ' +
      'acontece na consulta, ou o que a especialista avalia. Termine oferecendo ' +
      'horário de novo, sem pressa.',
  },
  {
    aposMin: 6 * 60,
    intencao:
      'Último toque com oferta ativa. Reconheça o tempo que passou sem cobrar ' +
      '("imagino que a correria apertou") e ofereça verificar os horários.',
  },
  {
    // 20h: última chance antes de a janela de 24h do WhatsApp fechar. Depois
    // disto só template pago, então é aqui que a conversa se encerra bem.
    aposMin: 20 * 60,
    intencao:
      'Encerramento educado, SEM pedir resposta. Deixe claro que ele pode chamar ' +
      'quando quiser e que a porta fica aberta. Esta é a última mensagem.',
  },
];

/**
 * Teto absoluto. Passou disto, a janela do WhatsApp fechou e mensagem livre não
 * chega — mandar seria gastar chamada de modelo pra produzir silêncio.
 */
const JANELA_WHATSAPP_MIN = 23 * 60;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** "agora" no relógio da clínica. */
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

/**
 * Mensagem fora do horário em que a clínica atende não é reengajamento, é
 * incômodo — e às 3h da manhã queima o contato de vez. Quem cair fora da janela
 * espera: o degrau não é perdido, só adiado.
 */
function dentroDoHorario(unit: {
  spineAgendaStart: string | null;
  spineAgendaEnd: string | null;
  spineTimezone: string | null;
  spineAgendaDays: number[];
}): boolean {
  const { minutos, diaSemana } = agoraLocal(unit.spineTimezone ?? 'America/Sao_Paulo');
  const dias = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(diaSemana)) return false;
  // Janela deliberadamente mais estreita que a da agenda: 08:00 é cedo o
  // bastante pra não parecer madrugada, e parar às 20:00 evita o horário em que
  // mensagem comercial mais irrita.
  const abre = Math.max(paraMinutos(unit.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const fecha = Math.min(paraMinutos(unit.spineAgendaEnd) ?? 20 * 60, 20 * 60);
  return minutos >= abre && minutos < fecha;
}

async function varrer(): Promise<void> {
  if (rodando) return; // a varredura de 1min pode encavalar
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { followUpEnabled: true } });
    for (const unit of unidades) {
      if (!dentroDoHorario(unit)) continue;

      const candidatas = await prisma.conversation.findMany({
        where: {
          unitId: unit.id,
          followUpStoppedReason: null,
          followUpStep: { lt: ESCADA.length },
          convertedAt: null,
        },
        orderBy: { lastMessageAt: 'asc' },
        take: 40,
      });

      for (const conv of candidatas) {
        const proximo = ESCADA[conv.followUpStep];
        if (!proximo) continue;

        // A referência é a ÚLTIMA mensagem da conversa, não o último follow-up:
        // se o paciente respondeu, lastMessageAt andou e o silêncio recomeça.
        const paradoMin = (Date.now() - conv.lastMessageAt.getTime()) / 60_000;
        if (paradoMin < proximo.aposMin) continue;

        if (paradoMin > JANELA_WHATSAPP_MIN) {
          await prisma.conversation
            .update({
              where: { id: conv.id },
              data: { followUpStoppedReason: 'janela de 24h do WhatsApp fechou' },
            })
            .catch(() => undefined);
          continue;
        }

        const ultima = await prisma.message.findFirst({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'desc' },
          select: { role: true },
        });
        // Se a última fala é do PACIENTE, não é hora de reengajar — é hora de
        // responder, e disso cuida o webhook. Reengajar aqui atropelaria a
        // resposta que está sendo gerada.
        if (!ultima || ultima.role !== 'assistant') continue;

        // Consulta marcada encerra o assunto. Sem isto, quem já agendou
        // continuaria recebendo "ainda está aí?" — o caminho mais curto entre
        // reengajar e virar spam.
        const temConsulta = await prisma.spineLeadLink.findFirst({
          where: { unitId: unit.id, kommoLeadId: Number(conv.leadId), spineIdSchedule: { not: null } },
          select: { id: true },
        });
        if (temConsulta) {
          await prisma.conversation
            .update({ where: { id: conv.id }, data: { followUpStoppedReason: 'consulta marcada' } })
            .catch(() => undefined);
          continue;
        }

        await enviarDegrau(unit, conv, proximo);
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'follow-up: varredura falhou');
  } finally {
    rodando = false;
  }
}

async function enviarDegrau(
  unit: { id: string; slug: string },
  conv: { id: string; leadId: string; followUpStep: number },
  degrau: Degrau,
): Promise<void> {
  const leadId = Number(conv.leadId);
  if (!Number.isFinite(leadId)) return;

  try {
    const { runAgentFollowUp } = await import('../agent/follow-up.js');
    const texto = await runAgentFollowUp({
      unitId: unit.id,
      leadId,
      conversationId: conv.id,
      intencao: degrau.intencao,
      ultimoDegrau: conv.followUpStep === ESCADA.length - 1,
    });
    if (!texto) return;

    const unitCompleta = await prisma.unit.findUnique({ where: { id: unit.id } });
    if (!unitCompleta) return;
    const kommo = createKommoClient(unitCompleta);
    // chatId/talkId/contactId nulos de propósito: o caminho do Salesbot é um
    // PATCH no campo "Resposta IA", e é o Digital Pipeline do Kommo que
    // entrega. Os outros dois são fallback e não se aplicam aqui.
    await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null });

    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        followUpStep: conv.followUpStep + 1,
        followUpLastAt: new Date(),
        ...(conv.followUpStep + 1 >= ESCADA.length
          ? { followUpStoppedReason: 'escada concluída' }
          : {}),
      },
    });

    // NÃO mexe em lastMessageAt: ele marca o silêncio do paciente, e é o que
    // faz o próximo degrau contar do momento certo. Atualizar aqui reiniciaria
    // o relógio a cada follow-up e a escada nunca avançaria.
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: 'assistant',
        content: texto,
        meta: { followUp: conv.followUpStep + 1 },
      },
    });

    logger.info(
      { unit: unit.slug, leadId, degrau: conv.followUpStep + 1 },
      'follow-up: reengajamento enviado',
    );
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, leadId },
      'follow-up: falha ao enviar reengajamento',
    );
    // Não incrementa o degrau: falha de rede não pode consumir uma etapa da
    // escada. Na próxima varredura tenta de novo.
  }
}

/** Corta o reengajamento de vez. */
export async function pararFollowUp(
  unitId: string,
  leadId: string | number,
  motivo: string,
): Promise<void> {
  await prisma.conversation
    .updateMany({
      where: { unitId, leadId: String(leadId) },
      data: { followUpStoppedReason: motivo },
    })
    .catch(() => undefined);
}

/** Zera a escada — o paciente voltou a falar, então não é mais quem sumiu. */
export async function reiniciarFollowUp(unitId: string, leadId: string | number): Promise<void> {
  await prisma.conversation
    .updateMany({
      where: { unitId, leadId: String(leadId), followUpStep: { gt: 0 } },
      data: { followUpStep: 0, followUpLastAt: null },
    })
    .catch(() => undefined);
}

export function startFollowUpWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info({ degrausMin: ESCADA.map((d) => d.aposMin) }, 'follow-up: worker iniciado');
}

export function stopFollowUpWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export const ESCADA_FOLLOW_UP = ESCADA;
