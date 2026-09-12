import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { enviarMensagemDeChat, verificarEntregaDaNota } from '../services/kommo-chat.service.js';
import { avisarJoao } from './alerta-whatsapp.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';

/**
 * Resposta com BOTÕES pelo chat do Kommo (mesmo caminho da nota de voz).
 *
 * Só no caminho padrão. No modo widget a resposta precisa fechar o bot pelo
 * `return_url`; mandar por fora deixaria o bot pendurado. Qualquer falha — sem
 * sessão de chat, amojo recusou, Kommo marcou erro depois — cai em texto pelo
 * caminho normal (o texto já traz as opções escritas). Quem chama trata `null`
 * como "siga em texto".
 */

const VERIFICAR_APOS_MS = Number(process.env.VOICE_VERIFY_AFTER_MS) || 20_000;

export function botoesLigadosPara(slug: string): boolean {
  const raw = (process.env.CHAT_BOTOES_SLUGS ?? '*').trim();
  if (!raw) return false;
  const lista = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return lista.has('*') || lista.has(slug);
}

export interface TentativaDeBotoes {
  unit: Unit;
  leadId: number;
  reply: string;
  botoes: string[];
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  authorId: string | null;
  accountId: number | null;
  modoWidget: boolean;
  recorder: TraceRecorder;
}

export async function tentarBotoes(a: TentativaDeBotoes): Promise<{ via: string; detail: unknown } | null> {
  const { unit, leadId, reply, botoes, recorder } = a;
  if (!botoes.length || a.modoWidget || !botoesLigadosPara(unit.slug)) return null;

  const faltando = [!a.chatId && 'chat_id', !a.authorId && 'author.id (destinatário)', !unit.kommoSubdomain && 'subdomínio'].filter(Boolean);
  if (faltando.length) {
    await recorder.step({
      kind: 'THINKING',
      title: `🔘 Sem dados para botões (${faltando.join(', ')}) — respondendo em texto`,
      payload: { faltando, botoes },
    });
    return null;
  }

  const t0 = performance.now();
  try {
    const enviada = await enviarMensagemDeChat(unit, {
      chatId: a.chatId!,
      recipientId: a.authorId!,
      talkId: a.talkId ? Number(a.talkId) : null,
      contactId: a.contactId ? Number(a.contactId) : null,
      accountId: a.accountId,
      texto: reply,
      botoes,
    });
    const ms = Math.round(performance.now() - t0);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `🔘 Resposta enviada com ${botoes.length} botões (${botoes.join(' · ')}) em ${ms} ms`,
      payload: { messageId: enviada.messageId, deliveryStatus: enviada.deliveryStatus, botoes, ms },
      latencyMs: ms,
    });

    // O Kommo aceita e só depois tenta entregar. Se ele marcar erro, o paciente não
    // recebeu nada — aí vai o texto puro pelo caminho normal.
    setTimeout(() => {
      void (async () => {
        try {
          const v = await verificarEntregaDaNota(unit, a.chatId!, enviada.messageId);
          if (v.encontrada && v.erro) {
            await recorder.step({
              kind: 'ERROR',
              title: `🔘 Mensagem com botões marcada com erro pelo Kommo (${v.erro}) — reenviando em texto`,
              payload: { messageId: enviada.messageId, erro: v.erro, deliveryStatus: v.deliveryStatus },
            });
            void avisarJoao(
              `🔘 Botões da Sofia em ${unit.slug} (lead ${leadId}) foram aceitos e depois marcados com erro pelo Kommo: ${v.erro}. Reenviei em texto.`,
              `botoes-erro-kommo:${unit.slug}`,
            );
            const r = await createKommoClient(unit).sendChatReply({
              leadId,
              chatId: a.chatId,
              talkId: a.talkId,
              contactId: a.contactId,
              text: reply,
              recorder,
            });
            await recorder.step({
              kind: 'KOMMO_ACTION',
              title: `Resposta entregue ao paciente via ${r.via} (texto após falha dos botões)`,
              payload: { via: r.via },
            });
          }
        } catch (err) {
          logger.warn({ err: String(err), leadId, unit: unit.slug }, 'botões: verificação de entrega falhou (segue)');
        }
      })();
    }, VERIFICAR_APOS_MS).unref?.();

    return { via: 'chat_botoes', detail: { messageId: enviada.messageId, botoes } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'THINKING',
      title: `🔘 Botões não saíram (${msg.slice(0, 90)}) — respondendo em texto`,
      payload: { erro: msg, botoes },
      latencyMs: Math.round(performance.now() - t0),
    });
    return null;
  }
}
