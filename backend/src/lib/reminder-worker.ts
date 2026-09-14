import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import { addMessage } from '../services/conversations.service.js';
import { mensagensOficiais } from '../services/kommo-talks.service.js';
import { enviarMensagemDeChat } from '../services/kommo-chat.service.js';
import { BOTOES_D1, contextoDeChatDoLead, janelaAberta, textoAlertaSemJanela, textoConfirmacaoD1 } from './confirmacao-d1.js';
import type { Unit } from '@prisma/client';

/** Não repete a pergunta de véspera para a mesma consulta (o worker roda de hora em hora). */
const REENVIO_D1_MS = 36 * 3600_000;

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
  if (!unit.spineEnabled || !unit.spineToken) {
    ultimoEnvioPorUnidade.set(unit.id, dia);
    return;
  }

  // Quem tem Salesbot de lembrete (template aprovado) continua com ele. As
  // outras unidades recebem a confirmação de véspera em texto, com pergunta
  // (1 confirmo · 2 remarcar) — a resposta é tratada em código no webhook.
  const salesbotId = unit.reminderEnabled ? unit.reminderSalesbotId : null;
  const amanha = somarDias(dia, 1);

  const links = await prisma.spineLeadLink.findMany({
    where: { unitId: unit.id, spineIdSchedule: { not: null } },
  });

  const kommo = createKommoClient(unit);
  let enviados = 0;
  let pulados = 0;
  let semJanela = 0;

  for (const link of links) {
    const consulta = await AgendaReconcileService.consultaDoLead(unit, link.kommoLeadId);
    if (!consulta || consulta.estado === 'cancelada' || !consulta.quando) {
      pulados++;
      continue;
    }
    if (consulta.quando.slice(0, 10) !== amanha) continue;

    if (salesbotId) {
      if (consulta.estado !== 'confirmada') {
        pulados++;
        continue;
      }
      const r = await kommo.triggerSalesbot(salesbotId, link.kommoLeadId);
      if (r.ok) {
        enviados++;
      } else {
        logger.warn(
          { unit: unit.slug, kommoLeadId: link.kommoLeadId, erro: r.error },
          'lembrete: falha ao acionar o Salesbot',
        );
      }
      continue;
    }

    const conv = await prisma.conversation.findFirst({
      where: { unitId: unit.id, leadId: String(link.kommoLeadId) },
      orderBy: { lastMessageAt: 'desc' },
    });
    if (!conv) {
      pulados++;
      continue;
    }
    if (conv.confirmacaoD1EnviadaEm && Date.now() - conv.confirmacaoD1EnviadaEm.getTime() < REENVIO_D1_MS) continue;

    const texto = textoConfirmacaoD1({
      nome: conv.contactName,
      quando: consulta.quando,
      especialista: consulta.especialista,
      endereco: unit.clinicAddress,
    });
    try {
      // Texto livre só chega se o paciente escreveu nas últimas 24 h. Fora da janela,
      // mandar é falhar em silêncio (o Kommo marca "Erro" e ninguém vê): a equipe é
      // avisada no grupo para confirmar por telefone ou template.
      const oficiais = await mensagensOficiais(kommo, link.kommoLeadId, 15).catch(() => null);
      if (oficiais && !janelaAberta(oficiais)) {
        await kommo.createTask({
          leadId: link.kommoLeadId,
          text: textoAlertaSemJanela({ slug: unit.slug, nome: conv.contactName, quando: consulta.quando }),
          completeAt: Math.floor(Date.now() / 1000) + 60 * 60,
        });
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { confirmacaoD1EnviadaEm: new Date(), confirmacaoD1Resposta: 'sem_janela' },
        });
        semJanela++;
        continue;
      }

      // Com os ids do chat, vai pelo chat do Kommo com botões (Confirmo · Preciso
      // remarcar); sem eles, texto pelo caminho normal ("responda 1 ou 2").
      const ctx = await contextoDeChatDoLead(unit.id, link.kommoLeadId).catch(() => null);
      let via = 'salesbot';
      if (ctx) {
        try {
          await enviarMensagemDeChat(unit, {
            chatId: ctx.chatId,
            recipientId: ctx.authorId,
            talkId: ctx.talkId,
            contactId: ctx.contactId,
            accountId: ctx.accountId,
            texto: texto.replace(/Responda \*1\* para confirmar ou \*2\* se precisar remarcar\. 😊/, 'Toca no botão aqui embaixo pra me avisar 😊'),
            botoes: BOTOES_D1,
          });
          via = 'chat_botoes';
        } catch (err) {
          logger.warn({ unit: unit.slug, kommoLeadId: link.kommoLeadId, err: String(err) }, 'confirmação D-1: botões falharam, indo em texto');
        }
      }
      if (via !== 'chat_botoes') {
        await kommo.sendChatReply({ leadId: link.kommoLeadId, text: texto, chatId: null, talkId: null, contactId: null });
      }
      await addMessage({ conversationId: conv.id, role: 'assistant', content: texto, meta: { origem: 'confirmacao_d1', via } });
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { confirmacaoD1EnviadaEm: new Date(), confirmacaoD1Resposta: null },
      });
      enviados++;
    } catch (err) {
      logger.warn({ unit: unit.slug, kommoLeadId: link.kommoLeadId, err: String(err) }, 'confirmação D-1: falha ao enviar');
    }
  }

  ultimoEnvioPorUnidade.set(unit.id, dia);
  logger.info(
    { unit: unit.slug, amanha, enviados, pulados, semJanela, candidatos: links.length, via: salesbotId ? 'salesbot' : 'texto' },
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
