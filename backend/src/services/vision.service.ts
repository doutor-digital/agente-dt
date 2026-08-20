// ============================================================================
// vision.service.ts — Leitura de imagem via OpenAI (visão).
//
// LÓGICA
// ------
// Paciente manda foto no WhatsApp (exame, receita, foto da região que dói,
// comprovante, print, figurinha). O Kommo entrega uma URL do arquivo. Esta
// função:
//   1. Baixa a imagem (sem auth; se 401/403, tenta com o token Kommo)
//   2. Converte pra data URI base64 (a API da OpenAI busca a URL sozinha, mas
//      URLs do Kommo podem exigir auth — mandar os bytes é mais robusto)
//   3. Pede pro gpt-4o (visão) DESCREVER objetivamente, sem diagnosticar
//   4. Devolve a descrição, que o webhook injeta no texto da mensagem
//
// Espelha transcription.service (mesma resolução de chave e download).
// CUSTO: alguns centavos por imagem no gpt-4o-mini.
// ============================================================================

import axios from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { resolveOpenAIApiKey } from './openai.service.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/** Modelo de visão. gpt-4o-mini enxerga imagem e é barato. Sobrescrevível por env. */
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o-mini';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // limite prático da API de visão

const PROMPT = [
  'Você recebe uma imagem que um paciente enviou no WhatsApp de uma clínica de coluna/hérnia.',
  'Descreva OBJETIVAMENTE, em português, o que há nela — de forma útil pro atendimento:',
  '- Exame/laudo/documento: resuma o achado principal e transcreva textos/valores relevantes.',
  '- Foto do corpo ou da região que dói: descreva o que dá pra ver, SEM diagnosticar.',
  '- Print de conversa ou comprovante: resuma o conteúdo.',
  '- Figurinha/meme/foto sem relação: diga isso em uma frase.',
  'No máximo 4 frases. NÃO faça diagnóstico nem dê conselho médico.',
].join('\n');

export interface VisionResult {
  text: string;
  durationMs: number;
}

/**
 * Baixa uma imagem e devolve uma descrição objetiva via visão. Lança erro se
 * falhar (o webhook trata e segue sem derrubar o turno).
 */
export async function describeImage(
  unit: Pick<Unit, 'kommoAccessToken' | 'openaiApiKey'>,
  imageUrl: string,
): Promise<VisionResult> {
  const apiKey = resolveOpenAIApiKey(unit) || env.OPENAI_TRANSCRIPTION_API_KEY;
  if (!apiKey) {
    throw new Error('Nenhuma chave OpenAI disponível — não dá pra ler imagem');
  }

  const t0 = performance.now();

  // 1. Baixa a imagem. Kommo costuma servir público; se vier 401/403, tenta
  //    com o Bearer da própria conta.
  let buf: Buffer;
  try {
    const r = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_IMAGE_BYTES,
    });
    buf = Buffer.from(r.data);
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if ((status === 401 || status === 403) && unit.kommoAccessToken) {
      logger.debug({ imageUrl, status }, 'image download sem auth falhou, tentando com token Kommo');
      const r2 = await axios.get<ArrayBuffer>(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        maxContentLength: MAX_IMAGE_BYTES,
        headers: { Authorization: `Bearer ${unit.kommoAccessToken}` },
      });
      buf = Buffer.from(r2.data);
    } else {
      throw new Error(`Falha ao baixar imagem (${status ?? '?'}): ${(err as Error).message}`);
    }
  }

  if (buf.byteLength === 0) {
    throw new Error('Imagem vazia (0 bytes)');
  }

  const mime = detectImageMime(buf);
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;

  // 2. Chama a visão.
  const res = await axios.post<{ choices?: Array<{ message?: { content?: string } }> }>(
    CHAT_URL,
    {
      model: VISION_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60_000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  );

  const text = (res.data?.choices?.[0]?.message?.content ?? '').trim();
  return { text, durationMs: Math.round(performance.now() - t0) };
}

/** Detecta o mime pelos primeiros bytes (magic numbers). Cai pra jpeg. */
function detectImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return 'image/png';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  )
    return 'image/webp';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return 'image/jpeg';
}
