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
  // Viés de contexto: sem isso o modelo alucina em áudio curto ou com ruído —
  // já devolveu "Pull atəş, улыштәш." pra um áudio em português.
  form.append(
    'prompt',
    'Paciente brasileiro falando com uma clínica de fisioterapia e reabilitação ortopédica. ' +
      'Assuntos comuns: dor na coluna, lombar, ombro, joelho, quadril, hérnia de disco, ' +
      'fisioterapia, pilates, consulta, agendamento, valor.',
  );
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
  if (text && !pareceportugues(text)) {
    logger.warn(
      { text: text.slice(0, 120), bytes: audioBuf.byteLength, ext },
      'transcrição saiu em alfabeto estranho — tratando como áudio inaudível',
    );
    throw new Error('Transcrição ininteligível (alfabeto não-latino)');
  }
  logger.info(
    { chars: text.length, bytes: audioBuf.byteLength, ext, ms: Math.round(performance.now() - t0) },
    'áudio transcrito',
  );
  return { text, durationMs: Math.round(performance.now() - t0) };
}

/**
 * Modelo do tipo Whisper alucina quando o áudio é curto, mudo ou ruidoso — e a
 * alucinação costuma sair em outro alfabeto (cirílico, árabe, CJK). Texto de
 * paciente brasileiro é esmagadoramente latino; se não for, não dá pra confiar.
 */
function pareceportugues(text: string): boolean {
  const letras = text.replace(/[^\p{L}]/gu, '');
  if (letras.length === 0) return false;
  const latinas = letras.replace(/[^\p{Script=Latin}]/gu, '').length;
  return latinas / letras.length >= 0.8;
}

function detectAudioExt(buf: Buffer): string {
  if (buf.length < 4) return 'ogg';
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';
  if ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || buf[0] === 0xff) return 'mp3';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'wav';
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';
  return 'ogg';
}
