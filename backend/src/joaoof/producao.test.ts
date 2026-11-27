import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDoModelo, criarModelo } from './producao.js';
import { classificarErroDeConta } from './erros.js';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

test('a chave do modelo: a PRÓPRIA do Joaoof se existir; senão a ANTHROPIC_API_KEY do servidor (a mesma da rede); nunca vazia por engano', () => {
  assert.equal(chaveDoModelo(env({ JOAOOF_ANTHROPIC_API_KEY: 'sk-ant-propria', ANTHROPIC_API_KEY: 'sk-ant-rede' })), 'sk-ant-propria');
  assert.equal(chaveDoModelo(env({ ANTHROPIC_API_KEY: ' sk-ant-rede ' })), 'sk-ant-rede');
  assert.equal(chaveDoModelo(env({ JOAOOF_ANTHROPIC_API_KEY: '  ', ANTHROPIC_API_KEY: 'sk-ant-rede' })), 'sk-ant-rede');
  assert.equal(chaveDoModelo(env({})), '');
});

test('criarModelo: com a chave do servidor monta o modelo; sem nenhuma, falha com a mensagem que o João entende (e que o vigia de erros classifica como chave)', () => {
  assert.equal(criarModelo('claude-haiku-4-5', env({ ANTHROPIC_API_KEY: 'sk-ant-rede-de-teste' })).nome, 'claude-haiku-4-5');
  assert.throws(() => criarModelo('claude-haiku-4-5', env({})), (e: Error) => {
    assert.match(e.message, /ANTHROPIC_API_KEY/);
    assert.equal(classificarErroDeConta(e.message), 'chave');
    return true;
  });
});
