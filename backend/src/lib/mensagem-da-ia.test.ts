import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mensagemDaIA, mensagemDaSofiaConversando } from './mensagem-da-ia.js';
import { CASOS_DE_META } from './mensagem-da-ia.casos.js';

test('mensagemDaIA e mensagemDaSofiaConversando seguem a tabela de casos', () => {
  for (const [meta, daIA, sofia] of CASOS_DE_META) {
    assert.equal(mensagemDaIA(meta), daIA, `mensagemDaIA ${JSON.stringify(meta)}`);
    assert.equal(mensagemDaSofiaConversando(meta), sofia, `mensagemDaSofiaConversando ${JSON.stringify(meta)}`);
  }
});

test('o alerta "prometeu sem marcar" usa a mesma função (uma lista só)', async () => {
  const dele = await import('./prometeu-sem-marcar.js');
  assert.equal(dele.mensagemDaIA, mensagemDaIA);
});
