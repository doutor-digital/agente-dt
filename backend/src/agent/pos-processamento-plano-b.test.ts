import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alvoDoReescritor, podeRefazerNoPrincipal } from './pos-processamento-plano-b.js';
import { readFileSync } from 'node:fs';
import { withTimeout } from './llm-policy.js';

const unit = { id: 'u1', slug: 'x', llmProvider: 'anthropic', anthropicApiKey: 'sk-ant-x' };

// Modelo "principal fora do ar": qualquer chamada fica pendurada até o tempo limite.
function fabricaDeModelos(principalFora = true) {
  const criados: Array<{ provider: string; model: string }> = [];
  const chamadasAoPrincipal: string[] = [];
  const criarModelo = (u: typeof unit, o: { model: string; temperature: number; maxTokens: number }) => {
    criados.push({ provider: u.llmProvider, model: o.model });
    const ehPrincipal = u.llmProvider === 'anthropic';
    return {
      provider: u.llmProvider,
      invoke: async () => {
        if (ehPrincipal) {
          chamadasAoPrincipal.push(o.model);
          if (principalFora) await new Promise((r) => setTimeout(r, 5_000)); // o "timeout" do Claude fora do ar
        }
        return { content: `ok:${u.llmProvider}` };
      },
    };
  };
  return { criados, chamadasAoPrincipal, criarModelo };
}

test('plano B respondeu: o reescritor usa o plano B, não cria nem chama o principal e não espera o timeout', async () => {
  const f = fabricaDeModelos();
  const t0 = Date.now();
  const alvo = alvoDoReescritor({
    unit,
    modelName: 'claude-opus-4-8',
    provedorAtivo: 'anthropic',
    planoBEmUso: { provider: 'openai', modelName: 'gpt-4o-mini' },
    criarModelo: f.criarModelo,
    maxTokens: 400,
  });
  const r = await alvo.model.invoke();
  assert.equal(r.content, 'ok:openai');
  assert.deepEqual(f.criados, [{ provider: 'openai', model: 'gpt-4o-mini' }]);
  assert.deepEqual(f.chamadasAoPrincipal, []);
  assert.equal(alvo.provider, 'openai');
  assert.equal(alvo.modelName, 'gpt-4o-mini');
  assert.ok(Date.now() - t0 < 1_000, 'não pode esperar o timeout do principal');
});

test('caminho normal (Claude respondeu): o reescritor é o mesmo de sempre', async () => {
  const f = fabricaDeModelos(false);
  const alvo = alvoDoReescritor({
    unit,
    modelName: 'claude-opus-4-8',
    provedorAtivo: 'anthropic',
    planoBEmUso: null,
    criarModelo: f.criarModelo,
    maxTokens: 400,
  });
  assert.deepEqual(f.criados, [{ provider: 'anthropic', model: 'claude-opus-4-8' }]);
  assert.equal(alvo.provider, 'anthropic');
  assert.equal(alvo.modelName, 'claude-opus-4-8');
  const r = await withTimeout(alvo.model.invoke(), 1_000);
  assert.equal(r.content, 'ok:anthropic');
  assert.equal(f.chamadasAoPrincipal.length, 1);
});

test('chave reserva assumiu (provedor ativo diferente, sem plano B): segue como hoje', () => {
  const f = fabricaDeModelos();
  const alvo = alvoDoReescritor({
    unit,
    modelName: 'claude-opus-4-8',
    provedorAtivo: 'anthropic-reserva',
    planoBEmUso: null,
    criarModelo: f.criarModelo,
    maxTokens: 400,
  });
  assert.equal(alvo.provider, 'anthropic-reserva');
});

test('plano B não muda a unidade original (cópia, sem mutar)', () => {
  const f = fabricaDeModelos();
  alvoDoReescritor({
    unit,
    modelName: 'm',
    provedorAtivo: 'anthropic',
    planoBEmUso: { provider: 'google', modelName: 'gemini-2.5-flash' },
    criarModelo: f.criarModelo,
    maxTokens: 400,
  });
  assert.equal(unit.llmProvider, 'anthropic');
});

test('refazer o fechamento no principal: só quando o principal respondeu', () => {
  assert.equal(podeRefazerNoPrincipal(false), true);
  assert.equal(podeRefazerNoPrincipal(true), false);
});

// Contrato do grafo (mesmo estilo de oferta-x-sinal-de-alerta.test.ts): as duas chamadas auxiliares passam pela regra.
test('graph.ts: o reescritor de bastidor não nasce mais direto do principal e o fechamento sem pergunta respeita o plano B', () => {
  const src = readFileSync(new URL('./graph.ts', import.meta.url), 'utf8').replace(/\s+/g, '');
  assert.ok(src.includes('alvoDoReescritor({unit,modelName,provedorAtivo,planoBEmUso,criarModelo:createChatModel,maxTokens:400})'));
  assert.ok(!src.includes('createChatModel(unit,{model:modelName,temperature:0,maxTokens:400})'), 'o reescritor voltou a criar o principal direto');
  assert.ok(src.includes('planoBEmUso={provider:planoB.provider,modelName:planoB.modelName};'), 'o plano B em uso não é registrado');
  assert.ok(src.includes('if(cta.precisaRefazer&&!passouPorSinal&&!respostaFixa&&podeRefazerNoPrincipal(respondeuPlanoB)&&'));
});
