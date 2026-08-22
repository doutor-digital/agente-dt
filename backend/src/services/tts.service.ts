import axios from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { resolveOpenAIApiKey } from './openai.service.js';

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'nova';

/**
 * O WhatsApp só trata como MENSAGEM DE VOZ (aquela com onda e play) quando o
 * arquivo é Ogg/Opus. Em mp3 ele vira anexo pra baixar, que é bem pior.
 */
const RESPONSE_FORMAT = 'opus';

/** Acima disso o áudio fica longo demais pra um retorno de WhatsApp. */
const MAX_CHARS = 900;

export interface SpeechResult {
  audio: Buffer;
  durationMs: number;
  chars: number;
}

export async function sintetizarFala(
  unit: Pick<Unit, 'openaiApiKey'>,
  text: string,
): Promise<SpeechResult> {
  const apiKey = resolveOpenAIApiKey(unit);
  if (!apiKey) {
    throw new Error('Nenhuma chave OpenAI disponível — não dá pra gerar áudio');
  }

  const clean = text.trim().slice(0, MAX_CHARS);
  if (!clean) throw new Error('texto vazio — nada pra sintetizar');

  const t0 = performance.now();
  try {
    const r = await axios.post<ArrayBuffer>(
      SPEECH_URL,
      { model: TTS_MODEL, voice: TTS_VOICE, input: clean, response_format: RESPONSE_FORMAT },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 45_000,
      },
    );
    const audio = Buffer.from(r.data);
    const durationMs = Math.round(performance.now() - t0);
    logger.info({ chars: clean.length, bytes: audio.length, durationMs }, 'tts: áudio gerado');
    return { audio, durationMs, chars: clean.length };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    logger.warn({ err, status, chars: clean.length }, 'tts: falha ao gerar áudio');
    throw err;
  }
}
