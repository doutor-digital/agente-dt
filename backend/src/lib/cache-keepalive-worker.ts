import { HumanMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { fusoDaUnidade } from './fuso.js';
import { montarPrefixoAnthropic } from '../agent/graph.js';
import { emPausa } from './pausa-unidade.js';
import { cortarSeEstourou } from '../agent/teto-mensal.js';
import { invokeChatModel } from '../services/openai.service.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';

const SWEEP_MS = Number(process.env.CACHE_KEEPALIVE_SWEEP_MS) || 5 * 60_000;
export const OCIOSO_MIN = Number(process.env.CACHE_KEEPALIVE_OCIOSO_MIN) || 48;
export const OCIOSO_MAX = Number(process.env.CACHE_KEEPALIVE_OCIOSO_MAX) || 58;
export const HORA_INICIO = Number(process.env.CACHE_KEEPALIVE_HORA_INICIO ?? 6);
export const HORA_FIM = Number(process.env.CACHE_KEEPALIVE_HORA_FIM ?? 23);

export function horaLocal(ms: number, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date(ms));
  return Number(h) % 24;
}

export function deveAquecer(ociosoMin: number, hora: number): boolean {
  if (ociosoMin < OCIOSO_MIN || ociosoMin > OCIOSO_MAX) return false;
  return hora >= HORA_INICIO && hora < HORA_FIM;
}

const recorderMudo = { step: async () => undefined } as unknown as TraceRecorder;

async function aquecer(unit: Unit): Promise<void> {
  // Unidade em pausa (recepção ou teto mensal) não vai receber chamada nenhuma: manter o cache
  // quente é jogar dinheiro.
  if (emPausa(unit)) return;
  const rows = await prisma.$queryRaw<{ ultima: Date | null }[]>`
    select max(created_at) as ultima from llm_calls
    where unit_id = ${unit.id} and provider = 'anthropic' and status = 'success'
      and jsonb_array_length(coalesce(request_body->'toolNames', '[]'::jsonb)) > 0`;
  const ultima = rows[0]?.ultima;
  if (!ultima) return;
  const ociosoMin = (Date.now() - new Date(ultima).getTime()) / 60_000;
  if (!deveAquecer(ociosoMin, horaLocal(Date.now(), fusoDaUnidade(unit)))) return;
  // Só na hora de gastar: conta que estourou o teto (modo pausar) é pausada aqui e não aquece.
  if (await cortarSeEstourou(unit)) return;

  const prefixo = await montarPrefixoAnthropic(unit, recorderMudo);
  if (!prefixo) return;
  const resposta = (await invokeChatModel({
    model: prefixo.model,
    messages: [prefixo.systemMessage, new HumanMessage('ok')],
    unitId: unit.id,
    traceId: null,
    modelName: prefixo.modelName,
    provider: 'anthropic',
    tools: prefixo.tools,
  })) as { usage_metadata?: { input_token_details?: { cache_read?: number; cache_creation?: number } } };
  const lidos = resposta?.usage_metadata?.input_token_details?.cache_read ?? 0;
  const gravados = resposta?.usage_metadata?.input_token_details?.cache_creation ?? 0;
  logger.info(
    { unit: unit.slug, ociosoMin: Math.round(ociosoMin), cacheLido: lidos, cacheGravado: gravados },
    gravados > lidos
      ? 'cache keepalive: prefixo regravado — o cache já tinha expirado ou o prefixo divergiu do agente'
      : 'cache keepalive: prefixo mantido quente',
  );
}

async function varrer(): Promise<void> {
  const units = await prisma.unit.findMany({ where: { isActive: true, llmProvider: 'anthropic' } });
  for (const unit of units) {
    if (!unit.anthropicApiKey) continue;
    try {
      await aquecer(unit);
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug }, 'cache keepalive: falhou nesta unidade');
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startCacheKeepaliveWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info({ sweepMs: SWEEP_MS, ociosoMin: OCIOSO_MIN, ociosoMax: OCIOSO_MAX, horas: `${HORA_INICIO}-${HORA_FIM}` }, 'cache keepalive worker iniciado');
}

export function stopCacheKeepaliveWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
