import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { createKommoClient, MIME_VOZ } from '../services/kommo.service.js';
import { sintetizarFala } from '../services/tts.service.js';
import { enviarNotaDeVoz, podeVirarAudio, verificarEntregaDaNota } from '../services/kommo-chat.service.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';

/**
 * Resposta em NOTA DE VOZ — espelho do paciente.
 *
 * Regra (decisão do João, 05/09/2026): a Sofia só fala em áudio quando o paciente
 * mandou áudio, e só quando o texto dá para ouvir (curto, sem chave Pix, sem link,
 * sem bloco de confirmação). QUALQUER falha na cadeia — gerar voz, subir no Drive,
 * mandar pelo chat, ou o Kommo marcar erro depois — cai em texto pelo caminho
 * normal. Quem chama trata `null` como "siga em texto".
 *
 * Só no caminho padrão (PATCH + Salesbot). No modo widget a resposta precisa
 * fechar o bot pelo `return_url`, e mandar voz por fora deixaria o bot pendurado.
 */

const VERIFICAR_APOS_MS = Number(process.env.VOICE_VERIFY_AFTER_MS) || 20_000;

export interface TentativaDeVoz {
  unit: Unit;
  leadId: number;
  reply: string;
  /** Áudio que o paciente mandou neste turno — sem ele, não há espelho. */
  audioUrl: string | null;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  /** Id (amojo) do paciente, `author.id` da mensagem recebida. */
  authorId: string | null;
  accountId: number | null;
  /** true = modo widget (não usar voz). */
  modoWidget: boolean;
  recorder: TraceRecorder;
}

export async function tentarNotaDeVoz(a: TentativaDeVoz): Promise<{ via: string; detail: unknown } | null> {
  const { unit, leadId, reply, recorder } = a;
  if (!unit.voiceReplyEnabled || a.modoWidget || !a.audioUrl) return null;

  const faltando = [
    !a.chatId && 'chat_id',
    !a.authorId && 'author.id (destinatário)',
    !unit.kommoSubdomain && 'subdomínio',
  ].filter(Boolean);
  if (faltando.length) {
    await recorder.step({
      kind: 'THINKING',
      title: `🔊 Sem dados para áudio (${faltando.join(', ')}) — respondendo em texto`,
      payload: { faltando },
    });
    return null;
  }

  const apto = podeVirarAudio(reply);
  if (!apto.ok) {
    await recorder.step({
      kind: 'THINKING',
      title: `🔊 Resposta fica em texto: ${apto.motivo}`,
      payload: { motivo: apto.motivo, chars: reply.length },
    });
    return null;
  }

  const t0 = performance.now();
  try {
    const fala = await sintetizarFala(unit, reply);
    const kommo = createKommoClient(unit);
    const nome = `sofia-${Date.now()}.ogg`;
    const arquivo = await kommo.uploadToDriveDetalhado(fala.audio, nome, MIME_VOZ);
    if (!arquivo.versionUuid) throw new Error('Drive não devolveu version_uuid');

    const enviada = await enviarNotaDeVoz(unit, {
      chatId: a.chatId!,
      recipientId: a.authorId!,
      talkId: a.talkId ? Number(a.talkId) : null,
      contactId: a.contactId ? Number(a.contactId) : null,
      accountId: a.accountId,
      arquivo: { uuid: arquivo.uuid, versionUuid: arquivo.versionUuid, nome },
    });

    const ms = Math.round(performance.now() - t0);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `🔊 Resposta enviada em áudio (${fala.chars} chars, ${Math.round(fala.audio.length / 1024)} KB, ${ms} ms)`,
      payload: { messageId: enviada.messageId, deliveryStatus: enviada.deliveryStatus, chars: fala.chars, bytes: fala.audio.length, uuid: arquivo.uuid, ms },
      latencyMs: ms,
    });

    // Validação depois do fato: o Kommo aceita a mensagem e só depois tenta entregar.
    // Se ELE marcar erro na nossa mensagem, o paciente não ouviu nada — aí vai o texto.
    setTimeout(() => {
      void (async () => {
        try {
          const v = await verificarEntregaDaNota(unit, a.chatId!, enviada.messageId);
          if (v.encontrada && v.erro) {
            await recorder.step({
              kind: 'ERROR',
              title: `🔊 Áudio marcado com erro pelo Kommo (${v.erro}) — reenviando em texto`,
              payload: { messageId: enviada.messageId, erro: v.erro, deliveryStatus: v.deliveryStatus },
            });
            const r = await kommo.sendChatReply({
              leadId,
              chatId: a.chatId,
              talkId: a.talkId,
              contactId: a.contactId,
              text: reply,
              recorder,
            });
            await recorder.step({
              kind: 'KOMMO_ACTION',
              title: `Resposta entregue ao paciente via ${r.via} (texto após falha do áudio)`,
              payload: { via: r.via, detail: r.detail },
            });
          } else {
            await recorder.step({
              kind: 'THINKING',
              title: v.encontrada
                ? `🔊 Áudio conferido no chat: delivery_status ${v.deliveryStatus ?? '?'}`
                : '🔊 Áudio não apareceu na releitura do chat (sem erro reportado)',
              payload: { messageId: enviada.messageId, ...v },
            });
          }
        } catch (err) {
          logger.warn({ err: String(err), unit: unit.slug, leadId }, 'voz: falha ao verificar entrega (sem reenvio)');
        }
      })();
    }, VERIFICAR_APOS_MS);

    return { via: 'voz_amojo', detail: { messageId: enviada.messageId, deliveryStatus: enviada.deliveryStatus, chars: fala.chars } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, unit: unit.slug, leadId }, 'voz: falhou — respondendo em texto');
    await recorder.step({
      kind: 'ERROR',
      title: `🔊 Áudio falhou — respondendo em texto: ${msg.slice(0, 120)}`,
      payload: { erro: msg, ms: Math.round(performance.now() - t0) },
    });
    return null;
  }
}
