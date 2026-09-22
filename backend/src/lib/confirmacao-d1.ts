import type { Conversation, Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { normalizarNome } from './kommo-schema.js';
import type { KommoClient } from '../services/kommo.service.js';
import { consultaDoLead } from '../services/agenda-reconcile.service.js';

export type RespostaD1 = 'confirmou' | 'remarcar';

export const JANELA_RESPOSTA_D1_MS = 48 * 3600_000;

export function classificarRespostaD1(texto: string): RespostaD1 | null {
  const s = texto.trim().toLowerCase().replace(/[!.…]+$/g, '');
  if (!s) return null;
  const negativo = /\bn[aã]o\b|remarc|reagend|cancel|desmarc|outro (dia|hor[aá]rio)|imprevisto/.test(s);
  if (/^2\b/.test(s) || negativo) return 'remarcar';
  if (/^[✅👍]/u.test(s)) return 'confirmou';
  if (/^(1|ok|okay|sim|confirmo|confirmado|confirmada|confirma|confirmar|estarei|vou sim|pode confirmar|isso)\b/.test(s) || /\bconfirm/.test(s)) {
    return 'confirmou';
  }
  return null;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function textoConfirmacaoD1(args: {
  nome: string | null | undefined;
  quando: string;
  especialista: string | null | undefined;
  endereco: string | null | undefined;
  /** 'd1' = véspera ("sua consulta de amanhã"); 'd2' = reforço dois dias antes. */
  antecedencia?: 'd1' | 'd2';
}): string {
  const dt = new Date(args.quando.length <= 16 ? `${args.quando}:00` : args.quando);
  const valida = !Number.isNaN(dt.getTime());
  const diaSem = valida ? DIAS[dt.getDay()] : '';
  const dia = valida ? `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}` : args.quando.slice(0, 10);
  const hora = valida ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` : args.quando.slice(11, 16);
  const primeiro = (args.nome ?? '').trim().split(/\s+/)[0];
  const oi = primeiro ? `Oi, ${primeiro}!` : 'Oi!';
  const quem = args.especialista ? ` com ${args.especialista}` : '';
  const onde = args.endereco ? `\n📍 ${args.endereco}` : '';
  const quando = args.antecedencia === 'd2' ? '' : 'de amanhã, ';
  return (
    `${oi} Passando para confirmar sua consulta ${quando}${diaSem ? diaSem + ', ' : ''}${dia} às ${hora}${quem}.${onde}\n\n` +
    'Responda *1* para confirmar ou *2* se precisar remarcar. 😊'
  );
}

/** "quinta, 24/09" — o dia da semana sai da própria data, nunca de cálculo do modelo. */
export function diaCurto(quando: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(quando)) return quando.slice(0, 10);
  const dt = new Date(quando.length <= 16 ? `${quando}:00` : quando);
  if (Number.isNaN(dt.getTime())) return quando.slice(0, 10);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${DIAS[dt.getDay()]}, ${dd}/${mm}`;
}

/** Rótulos dos botões da véspera — o classificador acima reconhece os dois. */
export const BOTOES_D1 = ['Confirmo', 'Preciso remarcar'];

/** Texto livre só chega no WhatsApp se o paciente escreveu nas últimas 24 h. Folga de 1 h. */
export const JANELA_WHATSAPP_MS = 23 * 3600_000;

export function janelaAberta(msgs: Array<{ direcao: 'entrada' | 'saida'; em: Date }>, agora: Date = new Date()): boolean {
  let ultimaEntrada: Date | null = null;
  for (const m of msgs) if (m.direcao === 'entrada' && (!ultimaEntrada || m.em > ultimaEntrada)) ultimaEntrada = m.em;
  return !!ultimaEntrada && agora.getTime() - ultimaEntrada.getTime() < JANELA_WHATSAPP_MS;
}

export interface ContextoDeChat {
  chatId: string;
  talkId: number | null;
  contactId: number | null;
  authorId: string;
  accountId: number | null;
}

/** Ids do chat (amojo) guardados na última mensagem do paciente — para mandar com botões. */
export async function contextoDeChatDoLead(unitId: string, leadId: number): Promise<ContextoDeChat | null> {
  const conv = await prisma.conversation.findFirst({ where: { unitId, leadId: String(leadId) }, orderBy: { lastMessageAt: 'desc' }, select: { id: true } });
  if (!conv) return null;
  const msgs = await prisma.message.findMany({
    where: { conversationId: conv.id, role: 'user' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { meta: true },
  });
  for (const m of msgs) {
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    const chatId = typeof meta.chatId === 'string' ? meta.chatId : null;
    const authorId = typeof meta.authorId === 'string' ? meta.authorId : null;
    if (!chatId || !authorId) continue;
    return {
      chatId,
      authorId,
      talkId: meta.talkId != null && Number.isFinite(Number(meta.talkId)) ? Number(meta.talkId) : null,
      contactId: meta.contactId != null && Number.isFinite(Number(meta.contactId)) ? Number(meta.contactId) : null,
      accountId: meta.accountId != null && Number.isFinite(Number(meta.accountId)) ? Number(meta.accountId) : null,
    };
  }
  return null;
}

export function textoAlertaSemJanela(args: { slug: string; nome: string | null | undefined; quando: string }): string {
  const hora = args.quando.slice(11, 16);
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] 📅 Consulta amanhã às ${hora} SEM confirmação: ` +
    'o paciente está há mais de 24 h sem escrever e o WhatsApp não aceita mensagem livre. Confirmar por telefone ou template.'
  );
}

async function marcarSituacaoConfirmada(kommo: KommoClient, leadId: number): Promise<boolean> {
  const campos = await kommo.listLeadCustomFieldsTyped();
  const alvo = normalizarNome('✓ Situação da consulta');
  const campo = campos.find((c) => normalizarNome(c.name) === alvo);
  if (!campo) return false;
  const enums = (campo.enums ?? []) as Array<{ id: number; value: string }>;
  const opcao = enums.find((e) => normalizarNome(e.value) === normalizarNome('Confirmado'));
  if (!opcao) return false;
  await kommo.setLeadCustomFieldValue(leadId, campo.id, 'select', opcao.value, enums);
  return true;
}

export async function tratarRespostaD1(args: {
  unit: Unit;
  leadId: number;
  texto: string;
  conv: Conversation;
  kommo: KommoClient;
}): Promise<RespostaD1 | null> {
  const { unit, leadId, texto, conv, kommo } = args;
  if (!conv.confirmacaoD1EnviadaEm || conv.confirmacaoD1Resposta) return null;
  if (Date.now() - conv.confirmacaoD1EnviadaEm.getTime() > JANELA_RESPOSTA_D1_MS) return null;
  const resposta = classificarRespostaD1(texto);
  if (!resposta) return null;

  const consulta = await consultaDoLead(unit, leadId).catch(() => null);
  const hora = consulta?.quando ? consulta.quando.slice(11, 16) : null;
  const quandoCurto = consulta?.quando ? diaCurto(consulta.quando) : null;
  const primeiro = (conv.contactName ?? '').trim().split(/\s+/)[0];
  const nome = primeiro ? `, ${primeiro}` : '';

  if (resposta === 'confirmou') {
    const marcou = await marcarSituacaoConfirmada(kommo, leadId).catch((err) => {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: não consegui marcar Situação = Confirmado');
      return false;
    });
    await kommo.sendChatReply({
      leadId,
      // Sem "amanhã": a mesma pergunta sai também dois dias antes (reforço D-2).
      text: `Confirmado${nome}! 💙 Te esperamos${quandoCurto ? ` ${quandoCurto}` : ''}${hora ? ` às ${hora}` : ''}. Chegue uns 15 minutinhos antes, tá? Qualquer coisa é só me chamar por aqui.`,
      chatId: null,
      talkId: null,
      contactId: null,
    });
    logger.info({ unit: unit.slug, leadId, situacaoMarcada: marcou }, 'confirmação D-1: paciente confirmou');
  } else {
    await kommo
      .createTask({
        leadId,
        text:
          `ALERTA · ${unit.slug} · [Contato: ${conv.contactName ?? 'paciente'}] 🔁 Pediu para remarcar a consulta de amanhã` +
          `${hora ? ` (${hora})` : ''}: "${texto.slice(0, 120)}". Combinar novo horário com o paciente.`,
        completeAt: Math.floor(Date.now() / 1000) + 30 * 60,
      })
      .catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: falha ao abrir tarefa de remarcação'));
    await kommo.sendChatReply({
      leadId,
      text: `Sem problema${nome}! 🙏 Vou pedir para a equipe combinar um novo horário com você por aqui. Se preferir, me diga qual dia e período ficam melhores.`,
      chatId: null,
      talkId: null,
      contactId: null,
    });
    logger.info({ unit: unit.slug, leadId }, 'confirmação D-1: paciente pediu para remarcar');
  }

  await prisma.conversation
    .update({ where: { id: conv.id }, data: { confirmacaoD1Resposta: resposta } })
    .catch(() => undefined);
  return resposta;
}
