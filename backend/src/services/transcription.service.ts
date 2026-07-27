// ============================================================================
// transcription.service.ts — Transcrição de áudio via OpenAI Whisper.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Clientes brasileiros mandam MUITO áudio no WhatsApp. Quando o Kommo
// recebe áudio do WABA, o webhook traz uma URL do arquivo. Esta função:
//   1. Baixa o áudio (tenta sem auth primeiro; se 401/403, tenta com token Kommo)
//   2. Envia pra OpenAI /audio/transcriptions (modelo whisper-1)
//   3. Retorna o transcript em PT-BR (configurável)
//
// CUSTO: ~$0.006 por minuto de áudio. Em uma conversa típica
// (3-5 áudios de 30s cada), é menos de 1 centavo.
// ============================================================================

import axios from 'axios';
import FormData from 'form-data';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { resolveOpenAIApiKey } from './openai.service.js';

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Modelo de transcrição. `gpt-4o-mini-transcribe` substituiu o `whisper-1`:
 * mesma rota, mesmo multipart, menos erro em áudio de celular (ruído, sotaque,
 * fala rápida) e mais barato por minuto.
 *
 * Sobrescrevível por env pra dar rollback sem deploy — se algo sair errado em
 * produção, `TRANSCRIPTION_MODEL=whisper-1` volta o comportamento antigo.
 *
 * ATENÇÃO ao trocar: os modelos gpt-4o-*-transcribe só aceitam
 * `response_format` `json` ou `text`. Se um dia precisar de timestamps
 * (`verbose_json`), o caminho é voltar pro whisper-1 — não existe nos novos.
 */
const TRANSCRIBE_MODEL = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // limite da API

export interface TranscriptionResult {
  text: string;
  durationMs: number;
}

/**
 * Baixa um áudio e transcreve via Whisper. Lança erro se falhar.
 * Idempotente — pode chamar várias vezes pro mesmo URL.
 */
export async function transcribeAudio(
  unit: Pick<Unit, 'kommoAccessToken' | 'openaiApiKey'>,
  audioUrl: string,
  language: string = 'pt',
): Promise<TranscriptionResult> {
  // Ordem de resolução da chave:
  //   1. OPENAI_TRANSCRIPTION_API_KEY — chave dedicada ao áudio, quando existe.
  //      Serve pra separar a fatura da transcrição da fatura do chat.
  //   2. resolveOpenAIApiKey(unit) — chave da unidade, senão a da plataforma.
  //      É a chave EFETIVA: unidades que rodam na key da plataforma têm
  //      `openaiApiKey` nulo no banco e mesmo assim transcrevem.
  const apiKey = env.OPENAI_TRANSCRIPTION_API_KEY || resolveOpenAIApiKey(unit);
  if (!apiKey) {
    throw new Error('Nenhuma chave OpenAI disponível — não dá pra transcrever');
  }

  const t0 = performance.now();

  // 1. Baixa o áudio. Kommo costuma servir public, mas se vier 401 tentamos
  //    com o Bearer da própria conta.
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

  // 2. Detecta extensão pelo magic byte ou cai pra .ogg (WABA padrão).
  const ext = detectAudioExt(audioBuf);

  // 3. Envia pra Whisper como multipart/form-data.
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

/** Heurística simples pra detectar formato do áudio pelos primeiros bytes. */
function detectAudioExt(buf: Buffer): string {
  if (buf.length < 4) return 'ogg';
  // OggS — Ogg/Opus (WABA default)
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';
  // ID3 ou MP3 frame
  if ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || buf[0] === 0xff) return 'mp3';
  // RIFF (WAV)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'wav';
  // ftyp box — M4A/AAC
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';
  return 'ogg';
}
