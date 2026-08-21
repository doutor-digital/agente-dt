import type { BaseMessage } from '@langchain/core/messages';

export const HISTORY_MAX_MESSAGES = Number(process.env.AGENT_HISTORY_MAX_MESSAGES) || 40;
export const HISTORY_ANCHOR_STRIDE = Number(process.env.AGENT_HISTORY_STRIDE) || 20;

export function podarHistorico(
  messages: BaseMessage[],
  max = HISTORY_MAX_MESSAGES,
  stride = HISTORY_ANCHOR_STRIDE,
): BaseMessage[] {
  if (!Number.isFinite(max) || max <= 0) return messages;
  if (messages.length <= max) return messages;

  const passo = Number.isFinite(stride) && stride > 0 ? stride : 1;
  let inicio = Math.floor((messages.length - max) / passo) * passo;
  if (inicio <= 0) return messages;

  while (inicio < messages.length && messages[inicio].getType() !== 'human') {
    inicio++;
  }
  if (inicio >= messages.length) return messages;
  return messages.slice(inicio);
}
