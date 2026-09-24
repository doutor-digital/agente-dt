/**
 * Cartão de chegada: logo depois do "Fechado!", uma mensagem só com a foto da
 * fachada, o endereço e o link do mapa. Pino de localização não existe no chat
 * do Kommo (provado em 12/09/2026); foto com legenda e link, sim.
 *
 * O gatilho é a ferramenta `agendar_consulta` ter dado certo neste turno — não o
 * texto do modelo. Só sai depois que a confirmação em texto foi entregue, só no
 * caminho padrão, e nunca segura nem derruba a resposta principal.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';
import { enviarMensagemDeChat } from '../services/kommo-chat.service.js';

const marcados = new Map<string, number>();
const TTL_MS = 10 * 60_000;

export function marcarConsultaNoTurno(traceId: string): void {
  const agora = Date.now();
  for (const [k, em] of marcados) if (agora - em > TTL_MS) marcados.delete(k);
  marcados.set(traceId, agora);
}

/** Consome a marca: cada turno manda no máximo um cartão. */
export function consultaMarcadaNoTurno(traceId: string): boolean {
  return marcados.delete(traceId);
}

export function legendaDoCartao(unit: Pick<Unit, 'clinicAddress' | 'clinicMapUrl'>): string | null {
  const endereco = (unit.clinicAddress ?? '').trim();
  const mapa = (unit.clinicMapUrl ?? '').trim();
  if (!endereco && !mapa) return null;
  const linhas = [];
  if (endereco) linhas.push(`📍 ${endereco}`);
  if (mapa) linhas.push(`🗺️ Como chegar: ${mapa}`);
  linhas.push('');
  linhas.push('Chega uns 15 minutos antes, tá? Te esperamos! 💙');
  return linhas.join('\n');
}

export interface EnvioDoCartao {
  unit: Unit;
  leadId: number;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  authorId: string | null;
  accountId: number | null;
  modoWidget: boolean;
  recorder: TraceRecorder;
}

export async function enviarCartaoDeChegada(a: EnvioDoCartao): Promise<void> {
  const { unit, leadId, recorder } = a;
  if (a.modoWidget || !a.chatId || !a.authorId) return;
  const legenda = legendaDoCartao(unit);
  const anexo =
    unit.clinicPhotoDriveUuid && unit.clinicPhotoDriveVersion
      ? { uuid: unit.clinicPhotoDriveUuid, versionUuid: unit.clinicPhotoDriveVersion, tipo: 'picture' as const }
      : undefined;
  // Sem foto e sem mapa, o endereço já foi dito na confirmação — não repete.
  if (!legenda || (!anexo && !unit.clinicMapUrl)) return;

  const t0 = performance.now();
  try {
    const enviada = await enviarMensagemDeChat(unit, {
      chatId: a.chatId,
      recipientId: a.authorId,
      talkId: a.talkId ? Number(a.talkId) : null,
      contactId: a.contactId ? Number(a.contactId) : null,
      accountId: a.accountId,
      texto: legenda,
      anexo,
    });
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `🏥 Cartão de chegada enviado (${anexo ? 'foto + ' : ''}endereço${unit.clinicMapUrl ? ' + mapa' : ''})`,
      payload: { messageId: enviada.messageId, deliveryStatus: enviada.deliveryStatus, comFoto: !!anexo },
      latencyMs: Math.round(performance.now() - t0),
    });
    const conv = await prisma.conversation.findFirst({
      where: { unitId: unit.id, leadId: String(leadId) },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true },
    });
    if (conv) {
      await prisma.message.create({
        data: { conversationId: conv.id, traceId: recorder.traceId, role: 'assistant', content: legenda, meta: { via: 'chat_cartao', comFoto: !!anexo } },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, leadId, unit: unit.slug }, 'cartão de chegada não saiu (segue)');
    await recorder.step({ kind: 'THINKING', title: `🏥 Cartão de chegada não saiu (${msg.slice(0, 90)})`, payload: { erro: msg } });
  }
}
