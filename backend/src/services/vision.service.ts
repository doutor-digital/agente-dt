import axios from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { resolveOpenAIApiKey } from './openai.service.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o-mini';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PROMPT = [
  'Você recebe uma imagem que um paciente enviou no WhatsApp de uma clínica de coluna/hérnia.',
  'Descreva OBJETIVAMENTE, em português, o que há nela — de forma útil pro atendimento:',
  '- Exame/laudo/documento: resuma o achado principal e transcreva textos/valores relevantes.',
  '- Foto do corpo ou da região que dói: descreva o que dá pra ver, SEM diagnosticar.',
  '- COMPROVANTE de pagamento (PIX, transferência, recibo): comece a resposta com',
  '  "COMPROVANTE:" e transcreva o VALOR, a DATA e hora, o NOME de quem pagou e o',
  '  NOME/CNPJ de quem recebeu. Se algum desses não aparecer na imagem, diga qual',
  '  falta — nunca preencha por dedução: esse dado libera o horário do paciente.',
  '- Print de conversa: resuma o conteúdo.',
  '- Figurinha/meme/foto sem relação: diga isso em uma frase.',
  'No máximo 4 frases. NÃO faça diagnóstico nem dê conselho médico.',
].join('\n');

export interface VisionResult {
  text: string;
  durationMs: number;
}

export async function describeImage(
  unit: Pick<Unit, 'kommoAccessToken' | 'openaiApiKey'>,
  imageUrl: string,
): Promise<VisionResult> {
  const apiKey = resolveOpenAIApiKey(unit) || env.OPENAI_TRANSCRIPTION_API_KEY;
  if (!apiKey) {
    throw new Error('Nenhuma chave OpenAI disponível — não dá pra ler imagem');
  }

  const t0 = performance.now();

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
