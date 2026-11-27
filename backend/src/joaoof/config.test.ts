import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canalDoJoaoof, chatDoJoao, modelosDoJoaoof, modoDoJoaoof, orcamentoDoJoaoof, valorDoModoReconhecido } from './config.js';

test('JOAOOF_LIGADO: padrão desligado; valor desconhecido NUNCA liga', () => {
  assert.equal(modoDoJoaoof(undefined), 'desligado');
  assert.equal(modoDoJoaoof(''), 'desligado');
  assert.equal(modoDoJoaoof('talvez'), 'desligado');
  assert.equal(modoDoJoaoof('seco'), 'seco');
  assert.equal(modoDoJoaoof(' SECO '), 'seco');
  assert.equal(modoDoJoaoof('ligado'), 'ligado');
  assert.equal(modoDoJoaoof('1'), 'ligado');
  assert.equal(valorDoModoReconhecido('talvez'), false);
  assert.equal(valorDoModoReconhecido('seco'), true);
});

test('orçamento: teto 300 e câmbio 5,8 por padrão; valor ruim cai no padrão', () => {
  assert.deepEqual(orcamentoDoJoaoof({}), { tetoBrl: 300, usdBrl: 5.8, avisoEm: 0.8 });
  assert.equal(orcamentoDoJoaoof({ JOAOOF_TETO_BRL: '150,5' }).tetoBrl, 150.5);
  assert.equal(orcamentoDoJoaoof({ JOAOOF_TETO_BRL: '-3' }).tetoBrl, 300);
  assert.equal(orcamentoDoJoaoof({ JOAOOF_TETO_BRL: '0' }).tetoBrl, 0); // 0 = «não gaste nada», não «volte ao padrão»
  assert.equal(orcamentoDoJoaoof({ JOAOOF_TETO_BRL: '' }).tetoBrl, 300);
  assert.equal(orcamentoDoJoaoof({ JOAOOF_USD_BRL: 'abc' }).usdBrl, 5.8);
});

test('modelos, canal e chat com padrões', () => {
  assert.deepEqual(modelosDoJoaoof({}), { barato: 'claude-haiku-4-5', forte: 'claude-sonnet-5' });
  assert.equal(modelosDoJoaoof({ JOAOOF_MODELO_BARATO: 'claude-haiku-5-5' }).barato, 'claude-haiku-5-5');
  assert.equal(canalDoJoaoof(), 'joaoof');
  assert.equal(chatDoJoao({}), '7822226023');
  // o chat próprio só vale junto do token próprio (o id de um chat não serve para outro bot)
  assert.equal(chatDoJoao({ JOAOOF_TELEGRAM_CHAT: '555' } as NodeJS.ProcessEnv), '7822226023');
  assert.equal(chatDoJoao({ JOAOOF_TELEGRAM_CHAT: '555', JOAOOF_TELEGRAM_TOKEN: '123:abc' } as NodeJS.ProcessEnv), '555');
});
