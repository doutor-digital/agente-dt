import axios from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { resolveOpenAIApiKey } from './openai.service.js';

/**
 * Voz da Sofia (texto → nota de voz).
 *
 * Dois provedores, escolhidos por env:
 *  - **ElevenLabs** (padrão quando `ELEVENLABS_API_KEY` existe): decisão do João em
 *    05/09/2026 depois de ouvir as vozes da OpenAI ("ainda muito robótica"). Voz em
 *    português do Brasil escolhida por ele (`ELEVENLABS_VOICE_ID`). Sai direto em
 *    Ogg/Opus (`opus_48000_64`), que é o único formato que o WhatsApp trata como
 *    MENSAGEM DE VOZ (onda + play); mp3 vira anexo para baixar.
 *  - **OpenAI** (`gpt-4o-mini-tts`): reserva. Se o ElevenLabs falhar (cota, 5xx) e
 *    houver chave OpenAI, a resposta ainda sai em voz por aqui — com direção de fala
 *    em português para não soar lida.
 *
 * Quem chama (`resposta-em-voz`) trata QUALQUER exceção como "responda em texto".
 */

export type ProvedorTts = 'elevenlabs' | 'openai';

const ELEVEN_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY?.trim() || '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID?.trim() || '';
/**
 * `eleven_v3` = o mais expressivo (foi o que o João achou menos "IA" em 05/09/2026) ·
 * `eleven_multilingual_v2` = estável · `eleven_flash_v2_5` = ~1 s e metade do custo.
 */
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL_ID || 'eleven_v3';
const ELEVEN_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'opus_48000_64';
/** Menos estabilidade = mais variação e emoção. No v3, 0.35/0.55 soou natural nas amostras. */
const ELEVEN_STABILITY = Number(process.env.ELEVENLABS_STABILITY ?? 0.35);
const ELEVEN_STYLE = Number(process.env.ELEVENLABS_STYLE ?? 0.55);

const OPENAI_URL = 'https://api.openai.com/v1/audio/speech';
const OPENAI_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_VOICE = process.env.TTS_VOICE || 'marin';
const OPENAI_INSTRUCTIONS =
  process.env.TTS_INSTRUCTIONS ||
  'Você é a Sofia, uma atendente brasileira de uma clínica de coluna, falando pelo WhatsApp. ' +
    'Português do Brasil, sotaque neutro. Tom caloroso, simpático e natural de conversa: ritmo tranquilo, ' +
    'entonação viva, pequenas pausas naturais entre as frases, sorriso na voz. Nunca soe robótica, apressada ' +
    'ou como quem lê um texto.';
const OPENAI_FORMAT = 'opus';

/** Acima disso o áudio fica longo demais pra um retorno de WhatsApp. */
const MAX_CHARS = 900;

export interface SpeechResult {
  audio: Buffer;
  durationMs: number;
  chars: number;
  provedor: ProvedorTts;
  voz: string;
}

export function provedorTts(): ProvedorTts {
  const pedido = (process.env.TTS_PROVIDER || '').toLowerCase();
  if (pedido === 'openai') return 'openai';
  if (pedido === 'elevenlabs') return 'elevenlabs';
  return ELEVEN_KEY && ELEVEN_VOICE ? 'elevenlabs' : 'openai';
}

export interface OpcoesEleven {
  /** Troca a voz só nesta chamada (usado para gerar amostras de escolha). */
  voiceId?: string;
  modelId?: string;
  apiKey?: string;
}

/** ElevenLabs → Ogg/Opus. Lança em qualquer falha (quem chama decide o fallback). */
export async function sintetizarComElevenLabs(text: string, opts: OpcoesEleven = {}): Promise<SpeechResult> {
  const apiKey = opts.apiKey ?? ELEVEN_KEY;
  const voiceId = opts.voiceId ?? ELEVEN_VOICE;
  const modelId = opts.modelId ?? ELEVEN_MODEL;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY ausente');
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID ausente — escolha a voz da Sofia');
  const clean = text.trim().slice(0, MAX_CHARS);
  if (!clean) throw new Error('texto vazio — nada pra sintetizar');

  const t0 = performance.now();
  const corpo: Record<string, unknown> = {
    text: clean,
    model_id: modelId,
    voice_settings: { stability: ELEVEN_STABILITY, similarity_boost: 0.8, style: ELEVEN_STYLE, use_speaker_boost: true },
  };
  // `language_code` só existe nos modelos v2.5 (flash/turbo); o multilingual_v2 recusa.
  if (/v2_5|turbo|flash/i.test(modelId)) corpo.language_code = 'pt';

  try {
    const r = await axios.post<ArrayBuffer>(`${ELEVEN_URL}/${voiceId}`, corpo, {
      params: { output_format: ELEVEN_FORMAT },
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/ogg' },
      responseType: 'arraybuffer',
      timeout: 45_000,
    });
    const audio = Buffer.from(r.data);
    const durationMs = Math.round(performance.now() - t0);
    logger.info({ provedor: 'elevenlabs', voz: voiceId, modelo: modelId, chars: clean.length, bytes: audio.length, durationMs }, 'tts: áudio gerado');
    return { audio, durationMs, chars: clean.length, provedor: 'elevenlabs', voz: voiceId };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const detalhe = axios.isAxiosError(err) && err.response?.data ? Buffer.from(err.response.data as ArrayBuffer).toString().slice(0, 200) : '';
    logger.warn({ status, detalhe, voz: voiceId, chars: clean.length }, 'tts: ElevenLabs falhou');
    throw new Error(`ElevenLabs HTTP ${status ?? '?'} ${detalhe}`.trim());
  }
}

/** OpenAI gpt-4o-mini-tts → Ogg/Opus, com direção de fala em português. */
export async function sintetizarComOpenAI(unit: Pick<Unit, 'openaiApiKey'>, text: string): Promise<SpeechResult> {
  const apiKey = resolveOpenAIApiKey(unit);
  if (!apiKey) throw new Error('Nenhuma chave OpenAI disponível — não dá pra gerar áudio');
  const clean = text.trim().slice(0, MAX_CHARS);
  if (!clean) throw new Error('texto vazio — nada pra sintetizar');

  const t0 = performance.now();
  try {
    const r = await axios.post<ArrayBuffer>(
      OPENAI_URL,
      { model: OPENAI_MODEL, voice: OPENAI_VOICE, input: clean, instructions: OPENAI_INSTRUCTIONS, response_format: OPENAI_FORMAT },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 45_000 },
    );
    const audio = Buffer.from(r.data);
    const durationMs = Math.round(performance.now() - t0);
    logger.info({ provedor: 'openai', voz: OPENAI_VOICE, chars: clean.length, bytes: audio.length, durationMs }, 'tts: áudio gerado');
    return { audio, durationMs, chars: clean.length, provedor: 'openai', voz: OPENAI_VOICE };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    logger.warn({ err: String(err), status, chars: clean.length }, 'tts: OpenAI falhou');
    throw err;
  }
}

/**
 * Voz da Sofia com o provedor configurado. ElevenLabs primeiro; se ele falhar e a
 * unidade tiver chave OpenAI, cai para a OpenAI (melhor voz sintética que silêncio).
 */
export async function sintetizarFala(unit: Pick<Unit, 'openaiApiKey'>, text: string): Promise<SpeechResult> {
  if (provedorTts() === 'elevenlabs') {
    try {
      return await sintetizarComElevenLabs(text);
    } catch (err) {
      if (!resolveOpenAIApiKey(unit)) throw err;
      logger.warn({ err: String(err) }, 'tts: ElevenLabs falhou — usando OpenAI como reserva');
    }
  }
  return sintetizarComOpenAI(unit, text);
}
