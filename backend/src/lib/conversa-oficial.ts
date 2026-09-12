/**
 * Antes de responder, a Sofia olha a conversa como o WhatsApp a vê (rota oficial
 * do Kommo) e recupera o que o webhook não trouxe: a resposta da equipe humana e
 * a mensagem do paciente que ficou para trás (áudio inclusive). O resultado é um
 * bloco de contexto que vai junto com a mensagem do turno — e as mensagens
 * recuperadas entram no histórico local, para o rastro e o follow-up baterem
 * com a realidade.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';
import { createKommoClient } from '../services/kommo.service.js';
import {
  desdeUltimaFalaDaSofia,
  mensagensOficiais,
  renderConversaOficial,
  type MensagemOficial,
} from '../services/kommo-talks.service.js';
import { transcribeAudio } from '../services/transcription.service.js';

/** Mensagem mais nova que isto é o turno atual, que já chegou pelo webhook. */
export const JANELA_DO_TURNO_MS = 3 * 60_000;
const MAX_ITENS = 12;

export type ItemOficial = MensagemOficial & { transcricao?: string | null };

/**
 * Filtra o que vale a pena mostrar ao modelo: equipe sempre; paciente só quando a
 * mensagem não está na entrada deste turno nem é do turno atual.
 */
export function selecionarItens(recentes: MensagemOficial[], humanMessage: string, agora: number): MensagemOficial[] {
  const jaNaEntrada = new Set(humanMessage.split('\n').map((s) => s.trim()).filter(Boolean));
  const itens: MensagemOficial[] = [];
  for (const m of recentes) {
    if (m.autor === 'sofia') continue;
    if (m.autor === 'paciente') {
      if (m.texto && jaNaEntrada.has(m.texto)) continue;
      if (agora - m.em.getTime() < JANELA_DO_TURNO_MS) continue;
    }
    itens.push(m);
  }
  return itens.slice(-MAX_ITENS);
}

async function registrarNoHistorico(unit: Unit, leadId: number, itens: ItemOficial[]): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { unitId: unit.id, leadId: String(leadId) },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  if (!conv) return;
  for (const m of itens) {
    const existe = await prisma.message.findFirst({
      where: { conversationId: conv.id, meta: { path: ['kommoMessageId'], equals: m.id } },
      select: { id: true },
    });
    if (existe) continue;
    const conteudo = m.transcricao ? `[áudio do cliente]: ${m.transcricao}` : m.texto || (m.anexo ? `[${m.anexo.tipo}]` : '');
    if (!conteudo) continue;
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: m.autor === 'paciente' ? 'user' : 'assistant',
        content: conteudo,
        createdAt: m.em,
        meta: { origem: 'kommo_talks', kommoMessageId: m.id, autor: m.autor, nome: m.autorNome || null },
      },
    });
  }
}

export async function blocoDaConversaOficial(args: {
  unit: Unit;
  leadId: number;
  humanMessage: string;
  recorder: TraceRecorder;
}): Promise<string> {
  const { unit, leadId, humanMessage, recorder } = args;
  const msgs = await mensagensOficiais(createKommoClient(unit), leadId, 40);
  const selecionados = selecionarItens(desdeUltimaFalaDaSofia(msgs), humanMessage, Date.now());
  if (!selecionados.length) return '';

  const itens: ItemOficial[] = [];
  for (const m of selecionados) {
    let transcricao: string | null = null;
    if (m.autor === 'paciente' && m.anexo?.tipo === 'voice' && m.anexo.link) {
      transcricao = await transcribeAudio(unit, m.anexo.link)
        .then((t) => t.text || null)
        .catch((err) => {
          logger.warn({ err: String(err), leadId, unit: unit.slug }, 'conversa oficial: áudio antigo não transcrito');
          return null;
        });
    }
    itens.push({ ...m, transcricao });
  }

  const daEquipe = itens.filter((m) => m.autor === 'equipe').length;
  await recorder.step({
    kind: 'THINKING',
    title: `Conversa oficial: ${daEquipe} mensagem(ns) da equipe e ${itens.length - daEquipe} do paciente desde a última fala da Sofia`,
    payload: {
      itens: itens.map((m) => ({ em: m.em, autor: m.autor, nome: m.autorNome, texto: (m.transcricao ?? m.texto).slice(0, 120) })),
    },
  });
  await registrarNoHistorico(unit, leadId, itens).catch((err) =>
    logger.warn({ err: String(err), leadId }, 'conversa oficial: falha ao gravar no histórico (segue)'),
  );
  return renderConversaOficial(itens, unit.spineTimezone ?? 'America/Sao_Paulo');
}
