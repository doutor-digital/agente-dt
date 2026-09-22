import { test } from 'node:test';
import assert from 'node:assert/strict';

import { etapaCalada, notaSofiaCalada, sofiaCaladaLiberada } from './sofia-calada.js';

test('calada em GANHO / ALTA / TRATAMENTO CANCELADO, com as variações de nome que as contas têm', () => {
  for (const nome of ['GANHO / CONCLUÍDO', 'GANHO / CONCLUIDO', 'Ganho', 'CONCLUÍDO', 'ALTA', 'Alta', 'TRATAMENTO CANCELADO', 'Tratamento cancelado']) {
    assert.equal(etapaCalada(nome), true, nome);
  }
});

test('fala nas outras — inclusive PERDIDO e EM ESPERA, que a allowlist governa', () => {
  for (const nome of ['PERDIDO', 'EM ESPERA', 'EM QUALIFICAÇÃO', 'AGENDADO', 'COMPARECEU', 'EM NEGOCIAÇÃO', 'RETORNO PÓS-TRATAMENTO', 'EM TRATAMENTO', 'Incoming leads', '', null, undefined]) {
    assert.equal(etapaCalada(nome), false, String(nome));
  }
});

test('flag por unidade: vazio = ninguém; * = todas', () => {
  assert.equal(sofiaCaladaLiberada('doutor-hernia-serra', undefined), false);
  assert.equal(sofiaCaladaLiberada('doutor-hernia-serra', ''), false);
  assert.equal(sofiaCaladaLiberada('doutor-hernia-serra', 'laboratorio-kommo,doutor-hernia-serra'), true);
  assert.equal(sofiaCaladaLiberada('doutor-hernia-imperatriz', "'doutor-hernia-serra'"), false);
  assert.equal(sofiaCaladaLiberada('qualquer', '*'), true);
});

test('a nota diz a etapa e um trecho curto do que o paciente escreveu', () => {
  const n = notaSofiaCalada('ALTA', 'Oi, ainda sinto uma dorzinha nas costas quando acordo, é normal?');
  assert.match(n, /estando em ALTA/);
  assert.match(n, /Disse: "Oi, ainda sinto/);
  const longa = notaSofiaCalada('TRATAMENTO CANCELADO', 'x'.repeat(300));
  assert.ok(longa.length < 260, 'nota comprida cansa no celular');
  assert.match(longa, /…"$/);
  assert.doesNotMatch(notaSofiaCalada('ALTA', '   '), /Disse/, 'sem texto, sem trecho');
});

test('pela estrutura: 142 cala em qualquer funil mesmo com o nome padrão do Kommo; 143 só cala no funil TRATAMENTO', () => {
  assert.equal(etapaCalada('Fechado - ganho', { statusId: 142, pipeline: 'COMERCIAL' }), true);
  assert.equal(etapaCalada('Closed - won', { statusId: 142, pipeline: 'TRATAMENTO' }), true);
  assert.equal(etapaCalada('Fechado - perdido', { statusId: 143, pipeline: 'TRATAMENTO' }), true, 'CANCELADO sem renomear');
  assert.equal(etapaCalada('Fechado - perdido', { statusId: 143, pipeline: 'COMERCIAL' }), false, 'PERDIDO fala (allowlist decide)');
  assert.equal(etapaCalada('PERDIDO', { statusId: 143, pipeline: 'COMERCIAL' }), false);
  assert.equal(etapaCalada('AGENDADO', { statusId: 110153708, pipeline: 'COMERCIAL' }), false);
});
