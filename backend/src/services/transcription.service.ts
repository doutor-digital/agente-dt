import axios from 'axios';
import FormData from 'form-data';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { resolveOpenAIApiKey } from './openai.service.js';

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

const TRANSCRIBE_MODEL = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscriptionResult {
  text: string;
  durationMs: number;
}

export async function transcribeAudio(
  unit: Pick<Unit, 'kommoAccessToken' | 'openaiApiKey'>,
  audioUrl: string,
  language: string = 'pt',
): Promise<TranscriptionResult> {
  const apiKey = env.OPENAI_TRANSCRIPTION_API_KEY || resolveOpenAIApiKey(unit);
  if (!apiKey) {
    throw new Error('Nenhuma chave OpenAI disponível — não dá pra transcrever');
  }

  const t0 = performance.now();

  let audioBuf: Buffer;
  try {
    const r = await axios.get<ArrayBuffer>(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_AUDIO_BYTES,
    });
    audioBuf = Buffer.from(r.data);
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if ((status === 401 || status === 403) && unit.kommoAccessToken) {
      logger.debug({ audioUrl, status }, 'audio download sem auth falhou, tentando com token Kommo');
      const r2 = await axios.get<ArrayBuffer>(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        maxContentLength: MAX_AUDIO_BYTES,
        headers: { Authorization: `Bearer ${unit.kommoAccessToken}` },
      });
      audioBuf = Buffer.from(r2.data);
    } else {
      throw new Error(`Falha ao baixar áudio (${status ?? '?'}): ${(err as Error).message}`);
    }
  }

  if (audioBuf.byteLength === 0) {
    throw new Error('Áudio vazio (0 bytes)');
  }

  const ext = detectAudioExt(audioBuf);

  const form = new FormData();
  form.append('file', audioBuf, { filename: `audio.${ext}`, contentType: `audio/${ext}` });
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', language);
  form.append('response_format', 'json');

  const res = await axios.post<{ text: string }>(TRANSCRIBE_URL, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${apiKey}`,
    },
    timeout: 60_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const text = (res.data?.text ?? '').trim();
  return { text, durationMs: Math.round(performance.now() - t0) };
}

function detectAudioExt(buf: Buffer): string {
  if (buf.length < 4) return 'ogg';
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';
  if ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || buf[0] === 0xff) return 'mp3';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'wav';
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';
  return 'ogg';
}
