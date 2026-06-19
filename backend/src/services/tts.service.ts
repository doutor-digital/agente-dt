// ============================================================================
// tts.service.ts — Texto → fala via OpenAI (/v1/audio/speech).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Espelho do transcription.service (que faz áudio→texto via Whisper). Aqui é o
// caminho de VOLTA: a resposta da IA vira voz quando o cliente mandou áudio.
//
// FORMATO: pedimos `opus` à OpenAI → retorna Ogg/Opus, que é EXATAMENTE o
// formato de nota de voz (PTT) do WhatsApp. Isso dá a melhor chance do Kommo
// entregar como notinha tocável (e não anexo pra baixar).
//
// CUSTO: tts-1 / gpt-4o-mini-tts custam ~$15/1M chars de entrada. Uma resposta
// típica (~300 chars) sai por fração de centavo — desprezível.
// ============================================================================

import axios from 'axios';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const TTS_URL = 'https://api.openai.com/v1/audio/speech';

export interface SpeechResult {
  buffer: Buffer;
  contentType: string;
  ext: string;
  durationMs: number;
}

/**
 * Sintetiza `text` em áudio Ogg/Opus. Lança erro se faltar chave ou a API
 * falhar — o chamador deve cair de volta pra texto nesse caso.
 */
export async function synthesizeSpeech(
  unit: Pick<Unit, 'openaiApiKey'>,
  text: string,
): Promise<SpeechResult> {
  const apiKey = unit.openaiApiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Sem openaiApiKey — não dá pra gerar áudio');
  }
  const input = text.trim();
  if (!input) {
    throw new Error('Texto vazio — nada pra sintetizar');
  }

  const t0 = performance.now();
  const res = await axios.post<ArrayBuffer>(
    TTS_URL,
    {
      model: env.OPENAI_TTS_MODEL,
      voice: env.OPENAI_TTS_VOICE,
      input,
      response_format: 'opus',
    },
    {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  );

  const buffer = Buffer.from(res.data);
  if (buffer.byteLength === 0) {
    throw new Error('TTS retornou áudio vazio (0 bytes)');
  }
  const durationMs = Math.round(performance.now() - t0);
  logger.debug({ bytes: buffer.byteLength, durationMs }, 'tts: áudio gerado');
  // Ogg/Opus — extensão .ogg, content-type audio/ogg (formato de PTT do WhatsApp).
  return { buffer, contentType: 'audio/ogg', ext: 'ogg', durationMs };
}
