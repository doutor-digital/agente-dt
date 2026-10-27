import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';

// O prisma é criado no import e respeita globalThis.__prisma__: um falso no lugar dele evita banco no teste.
const llmCallGravadas: Array<Record<string, unknown>> = [];
(globalThis as { __prisma__?: unknown }).__prisma__ = {
  llmCall: {
    create: async (a: { data: Record<string, unknown> }) => {
      llmCallGravadas.push(a.data);
      return {};
    },
  },
};

const { calculateCost, configurarRaciocinioAnthropic, createChatModel, detectarRecusa, invokeChatModel, LlmRecusaError } =
  await import('./openai.service.js');
const { ehFalhaDeInfra } = await import('../agent/circuito.js');
const { ehFalhaDeChave } = await import('../agent/chave-reserva.js');
const { gastoDaConversa } = await import('../agent/teto-conversa.js');
const { logger } = await import('../lib/logger.js');

// ---------------------------------------------------------------- raciocínio

test('modelos de hoje seguem EXATAMENTE como estavam: thinking disabled, sem invocationKwargs', () => {
  for (const m of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-5']) {
    assert.deepEqual(configurarRaciocinioAnthropic(m, null), { thinking: { type: 'disabled' } }, m);
    assert.deepEqual(
      configurarRaciocinioAnthropic(m, 'medium'),
      { thinking: { type: 'disabled' }, outputConfig: { effort: 'medium' } },
      m,
    );
  }
});

test('sonnet 5.5: between_tools por invocationKwargs; effort só se a unidade tem', () => {
  assert.deepEqual(configurarRaciocinioAnthropic('claude-sonnet-5-5', null), {
    thinking: { type: 'adaptive' },
    invocationKwargs: { thinking: { type: 'between_tools' } },
  });
  assert.deepEqual(configurarRaciocinioAnthropic('claude-sonnet-5-5', 'high').outputConfig, { effort: 'high' });
});

test('opus 5.5: nunca disabled; sem effort na unidade manda low (padrão da API seria medium)', () => {
  const r = configurarRaciocinioAnthropic('claude-opus-5-5', null);
  assert.deepEqual(r.thinking, { type: 'adaptive' });
  assert.equal(r.invocationKwargs, undefined);
  assert.deepEqual(r.outputConfig, { effort: 'low' });
  assert.deepEqual(configurarRaciocinioAnthropic('claude-opus-5-5', 'high').outputConfig, { effort: 'high' });
});

test('haiku 5.5: disabled (vale com effort <= high), effort só se a unidade tem', () => {
  assert.deepEqual(configurarRaciocinioAnthropic('claude-haiku-5-5', null), { thinking: { type: 'disabled' } });
  assert.deepEqual(configurarRaciocinioAnthropic('claude-haiku-5-5', 'low').outputConfig, { effort: 'low' });
});

function unidadeAnthropic(modelo: string, effort: string | null) {
  return { llmProvider: 'anthropic', anthropicApiKey: 'sk-teste', anthropicModel: modelo, anthropicEffort: effort } as never;
}

test('payload final por família (invocationParams do LangChain)', () => {
  const casos: Array<[string, string | null, unknown, unknown]> = [
    ['claude-opus-4-8', null, { type: 'disabled' }, undefined],
    ['claude-sonnet-5', 'low', { type: 'disabled' }, { effort: 'low' }],
    ['claude-sonnet-5-5', null, { type: 'between_tools' }, undefined],
    ['claude-sonnet-5-5', 'medium', { type: 'between_tools' }, { effort: 'medium' }],
    ['claude-opus-5-5', null, { type: 'adaptive' }, { effort: 'low' }],
    ['claude-haiku-5-5', null, { type: 'disabled' }, undefined],
  ];
  for (const [modelo, effort, thinking, output] of casos) {
    const m = createChatModel(unidadeAnthropic(modelo, effort)) as ChatAnthropic;
    const p = m.invocationParams({}) as Record<string, unknown>;
    assert.deepEqual(p.thinking, thinking, `${modelo} thinking`);
    assert.deepEqual(p.output_config, output, `${modelo} output_config`);
    // sem temperature/top_p/top_k no payload (a 5.5 recusa sampling manual)
    for (const k of ['temperature', 'top_p', 'top_k']) {
      assert.ok(p[k] === undefined || p[k] === null, `${modelo} não leva ${k}`);
    }
  }
});

// ---------------------------------------------------------------- preço

test('família 5.5 está na tabela: sonnet 2/10, opus 4/20, haiku 0,10/0,50', () => {
  assert.equal(calculateCost('claude-sonnet-5-5', 1_000_000, 1_000_000), 12);
  assert.equal(calculateCost('claude-opus-5-5', 1_000_000, 1_000_000), 24);
  assert.equal(calculateCost('claude-haiku-5-5', 100_000, 100_000), 0.06);
});

test('opus 5.5: leitura de cache a 0,05x da entrada (US$ 0,20/MTok); os demais seguem 0,1x', () => {
  assert.equal(calculateCost('claude-opus-5-5', 1_000_000, 0, 1_000_000), 0.2);
  assert.equal(calculateCost('claude-sonnet-5-5', 1_000_000, 0, 1_000_000), 0.2); // 2 x 0,1
  assert.equal(calculateCost('claude-opus-4-8', 1_000_000, 0, 1_000_000), 0.5); // 5 x 0,1
});

test('haiku 5.5: prompt acima de 100 mil tokens é cobrado inteiro a 0,50/2,50', () => {
  assert.equal(calculateCost('claude-haiku-5-5', 100_000, 1_000_000), 0.01 + 0.5);
  assert.equal(calculateCost('claude-haiku-5-5', 100_001, 1_000_000), Math.round((100_001 / 1e6) * 0.5 * 1e6) / 1e6 + 2.5);
});

test('claude-* desconhecido: avisa UMA vez e estima pelo Anthropic mais caro (não devolve 0)', (t) => {
  const aviso = t.mock.method(logger, 'warn', () => undefined);
  const custo = calculateCost('claude-modelo-do-futuro', 1_000_000, 1_000_000);
  assert.equal(custo, 30); // opus 4.x: 5 + 25
  calculateCost('claude-modelo-do-futuro', 10, 10);
  assert.equal(aviso.mock.callCount(), 1);
  calculateCost('claude-outro-do-futuro', 10, 10);
  assert.equal(aviso.mock.callCount(), 2);
});

test('id com sufixo (data, -latest) usa o preço da entrada que o prefixa, sem aviso nem estimativa cara', (t) => {
  const aviso = t.mock.method(logger, 'warn', () => undefined);
  assert.equal(calculateCost('claude-haiku-5-5-latest', 100_000, 100_000), 0.06);
  assert.equal(calculateCost('claude-sonnet-5-5-20261001', 1_000_000, 0), 2);
  assert.equal(aviso.mock.callCount(), 0);
});

test('modelo não-Anthropic desconhecido segue custando zero', () => {
  assert.equal(calculateCost('modelo-inexistente', 1000, 1000), 0);
});

// ---------------------------------------------------------------- recusa

test('detectarRecusa lê stop_reason e a categoria onde o LangChain colocar', () => {
  assert.equal(detectarRecusa({ additional_kwargs: { stop_reason: 'end_turn' } }), null);
  assert.equal(detectarRecusa(null), null);
  assert.deepEqual(detectarRecusa({ additional_kwargs: { stop_reason: 'refusal' } }), { categoria: null });
  assert.deepEqual(
    detectarRecusa({ additional_kwargs: { stop_reason: 'refusal', stop_details: { category: 'cyber' } } }),
    { categoria: 'cyber' },
  );
  assert.deepEqual(
    detectarRecusa({ response_metadata: { stop_reason: 'refusal', stop_details: { category: 'bio' } } }),
    { categoria: 'bio' },
  );
});

test('LlmRecusaError não é falha de infra nem de chave (não abre circuito nem aciona chave reserva)', () => {
  const e = new LlmRecusaError('cyber');
  assert.equal(e.name, 'LlmRecusaError');
  assert.equal(ehFalhaDeInfra(e), false);
  assert.equal(ehFalhaDeChave(e), null);
});

test('invokeChatModel: refusal vira LlmRecusaError, grava o gasto UMA vez (como erro, para aparecer no painel) e nunca devolve a resposta', async (t) => {
  llmCallGravadas.length = 0;
  t.mock.method(logger, 'warn', () => undefined);
  const resposta = new AIMessage({
    content: '',
    additional_kwargs: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } },
    usage_metadata: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 },
  });
  const conversaId = 'conv-recusa-teste';
  await assert.rejects(
    invokeChatModel({
      model: { invoke: async () => resposta },
      messages: [],
      unitId: null,
      traceId: 't1',
      modelName: 'claude-sonnet-5-5',
      provider: 'anthropic',
      conversaId,
    }),
    (err: unknown) => err instanceof LlmRecusaError && err.categoria === 'cyber',
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(llmCallGravadas.length, 1);
  assert.equal(llmCallGravadas[0]!.status, 'error');
  assert.match(String(llmCallGravadas[0]!.errorMessage), /refusal.*cyber/);
  assert.equal(Number(llmCallGravadas[0]!.promptTokens), 1_000_000);
  assert.equal(gastoDaConversa(conversaId).usd, 2); // a recusa consumiu token e entra no teto
});

test('invokeChatModel: resposta normal passa direto', async () => {
  const resposta = new AIMessage({ content: 'oi', additional_kwargs: { stop_reason: 'end_turn' } });
  const r = await invokeChatModel({
    model: { invoke: async () => resposta },
    messages: [],
    unitId: null,
    traceId: 't2',
    modelName: 'claude-sonnet-5-5',
    provider: 'anthropic',
  });
  assert.equal(r, resposta);
});
