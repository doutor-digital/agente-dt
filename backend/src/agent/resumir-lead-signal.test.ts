/**
 * `resumir_lead_para_sdr` e o prazo de quem chamou (taxa de reserva, 4ª rodada, item 8).
 *
 * O prazo do resumo só cancela a CHAMADA AO MODELO se o `signal` atravessar três degraus: `taxa-de-reserva-saida` → o `config` da
 * ferramenta (LangChain) → `invokeChatModel` → `model.invoke`. O teste de `invokeChatModel` sozinho não pega o degrau do meio:
 * tirar o `signal: config?.signal` de tools.ts deixava a suíte inteira verde e o resumo gastando token depois do prazo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { KommoClient } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { invokeChatModel, statusDaFalha } from '../services/openai.service.js';
import { buildTools } from './tools.js';

const gravadas: Array<{ status: string; errorMessage?: string }> = [];
Object.defineProperty(prisma, 'llmCall', {
  value: { create: async ({ data }: { data: { status: string; errorMessage?: string } }) => void gravadas.push(data) },
  configurable: true,
});
Object.defineProperty(prisma, 'conversation', { value: { findFirst: async () => ({ id: 'c1' }) }, configurable: true });
Object.defineProperty(prisma, 'message', {
  value: { findMany: async () => [{ role: 'user', content: 'quero marcar consulta', createdAt: new Date() }] },
  configurable: true,
});

const notas: string[] = [];
const kommo = {
  addLeadNote: async (_id: number, texto: string) => (notas.push(texto), { id: 7 }),
} as unknown as KommoClient;
const recorder = { traceId: 't-sinal', step: async () => undefined } as unknown as TraceRecorder;
const unidade = { id: 'u1', slug: 'teste', openaiApiKey: 'sk-teste', openaiModel: 'gpt-4o-mini', summaryCustomFieldId: null } as unknown as Unit;

interface Ferramenta {
  name: string;
  invoke: (entrada: Record<string, unknown>, config?: { signal?: AbortSignal }) => Promise<unknown>;
}
const resumir = (): Ferramenta => {
  const t = (buildTools({ recorder, kommo, unit: unidade }) as unknown as Ferramenta[]).find((x) => x.name === 'resumir_lead_para_sdr');
  assert.ok(t, 'resumir_lead_para_sdr não existe');
  return t;
};

/** Troca o `invoke` do modelo por um que guarda o sinal que recebeu. */
function espiarOModelo(aoChamar?: (sinal: AbortSignal | undefined) => void) {
  const original = ChatOpenAI.prototype.invoke;
  const visto: { chamado: boolean; sinal?: AbortSignal } = { chamado: false };
  (ChatOpenAI.prototype as unknown as { invoke: unknown }).invoke = async function (_m: unknown, opcoes?: { signal?: AbortSignal }) {
    visto.chamado = true;
    visto.sinal = opcoes?.signal;
    aoChamar?.(opcoes?.signal);
    return new AIMessage({ content: 'PACIENTE\nMaria', additional_kwargs: { stop_reason: 'end_turn' } });
  };
  return { visto, restaurar: () => void ((ChatOpenAI.prototype as unknown as { invoke: unknown }).invoke = original) };
}

test('item 8: o sinal de quem chamou a ferramenta chega ao modelo — o prazo cancela a CHAMADA, não só a gravação', async () => {
  const ac = new AbortController();
  const { visto, restaurar } = espiarOModelo();
  try {
    await resumir().invoke({ leadId: 1 }, { signal: ac.signal });
  } finally {
    restaurar();
  }
  assert.equal(visto.chamado, true);
  assert.ok(visto.sinal, 'o modelo não recebeu sinal nenhum');
  // não precisa ser o mesmo objeto (o LangChain pode compor sinais): abortar o de quem chamou tem de abortar o do modelo
  assert.equal(visto.sinal!.aborted, false);
  ac.abort();
  assert.equal(visto.sinal!.aborted, true);
});

test('item 8: sem sinal, a chamada segue como sempre (o passe-por-sinal chama a ferramenta assim)', async () => {
  const { visto, restaurar } = espiarOModelo();
  try {
    notas.length = 0;
    const r = await resumir().invoke({ leadId: 1 });
    assert.match(String(r), /Nota interna criada|OK|Resumo/i);
  } finally {
    restaurar();
  }
  assert.equal(visto.chamado, true);
  assert.equal(notas.length, 1);
});

test('item 8: prazo estourado DURANTE a chamada — nada é gravado no Kommo e o retorno diz que foi cancelado', async () => {
  const ac = new AbortController();
  notas.length = 0;
  const { restaurar } = espiarOModelo(() => ac.abort());
  let r: unknown;
  try {
    r = await resumir().invoke({ leadId: 1 }, { signal: ac.signal });
  } finally {
    restaurar();
  }
  assert.match(String(r), /^ERRO: resumo cancelado/);
  assert.equal(notas.length, 0);
});

test('item 8: chamada ao modelo abortada pelo prazo grava no llm_calls como `cancelled`, não como `error` (não acende o alarme de taxa de erro)', async () => {
  assert.equal(statusDaFalha(undefined), 'error');
  assert.equal(statusDaFalha(new AbortController().signal), 'error');
  const ac = new AbortController();
  ac.abort();
  assert.equal(statusDaFalha(ac.signal), 'cancelled');

  gravadas.length = 0;
  await assert.rejects(
    invokeChatModel({
      model: {
        invoke: async () => {
          throw new Error('This operation was aborted');
        },
      },
      messages: [],
      unitId: 'u1',
      traceId: 't-abort',
      modelName: 'gpt-4o-mini',
      signal: ac.signal,
    }),
    /aborted/,
  );
  // falha de verdade (sem sinal abortado) continua sendo `error`
  await assert.rejects(
    invokeChatModel({
      model: {
        invoke: async () => {
          throw new Error('503 Service Unavailable');
        },
      },
      messages: [],
      unitId: 'u1',
      traceId: 't-503',
      modelName: 'gpt-4o-mini',
    }),
    /503/,
  );
  await new Promise((r) => setImmediate(r)); // o recordLlmCall é disparado sem esperar
  assert.deepEqual(
    gravadas.map((g) => g.status),
    ['cancelled', 'error'],
  );
});
