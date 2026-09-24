import test from 'node:test';
import assert from 'node:assert/strict';
import { extrairBotoes, validarBotoes } from './botoes.js';
import { legendaDoCartao } from './cartao-de-chegada.js';

test('extrairBotoes: tira a linha do marcador e devolve as opções', () => {
  const r = extrairBotoes('Tenho quinta às 10h ou sexta às 14h. Qual fica melhor? 😊\n[[botoes: Quinta 10h | Sexta 14h]]');
  assert.equal(r.texto, 'Tenho quinta às 10h ou sexta às 14h. Qual fica melhor? 😊');
  assert.deepEqual(r.botoes, ['Quinta 10h', 'Sexta 14h']);
});

test('extrairBotoes: aceita "botões" com acento, espaços e até 3 opções', () => {
  const r = extrairBotoes('Prefere garantir com Pix antecipado ou pagar na clínica?\n\n[[ botões : Pix antecipado | Na clínica ]]  ');
  assert.deepEqual(r.botoes, ['Pix antecipado', 'Na clínica']);
  assert.equal(r.texto.endsWith('?'), true);
  assert.deepEqual(extrairBotoes('x [[botoes: Manhã | Tarde | Noite]]').botoes, ['Manhã', 'Tarde', 'Noite']);
});

test('validarBotoes: 1 opção, 4 opções, opção longa ou com link invalidam o conjunto inteiro', () => {
  assert.deepEqual(validarBotoes(['Só uma']), []);
  assert.deepEqual(validarBotoes(['A', 'B', 'C', 'D']), []);
  assert.deepEqual(validarBotoes(['Confirmo', 'Preciso remarcar a consulta de amanhã']), []);
  assert.deepEqual(validarBotoes(['Abrir mapa https://maps.app.goo.gl/x', 'Não']), []);
  assert.deepEqual(validarBotoes(['Confirmo', 'Confirmo', 'Remarcar']), ['Confirmo', 'Remarcar']);
});

test('extrairBotoes: sem marcador, texto intacto e sem botões; marcador inválido some do texto', () => {
  assert.deepEqual(extrairBotoes('Oi! Como posso te chamar?'), { texto: 'Oi! Como posso te chamar?', botoes: [] });
  const r = extrairBotoes('Qual? [[botoes: A | B | C | D]]');
  assert.equal(r.texto, 'Qual?');
  assert.deepEqual(r.botoes, []);
});

test('legendaDoCartao: endereço + mapa + recado; sem nada, null', () => {
  const l = legendaDoCartao({ clinicAddress: 'Rua X, 10 — Centro', clinicMapUrl: 'https://maps.app.goo.gl/abc' });
  assert.match(l!, /📍 Rua X, 10 — Centro/);
  assert.match(l!, /🗺️ Como chegar: https:\/\/maps\.app\.goo\.gl\/abc/);
  assert.match(l!, /15 minutos/);
  assert.equal(legendaDoCartao({ clinicAddress: null, clinicMapUrl: null }), null);
});
