import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escolherNome } from './spine-sync.service.js';

test('nome: o título do card manda quando serve', () => {
  const r = escolherNome('Maria Helena de Oliveira Ramos', 'Mari ❤️');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.nome, 'Maria Helena de Oliveira Ramos');
    assert.equal(r.origem, 'titulo');
  }
});

test('nome: card ainda automático cai no nome do WhatsApp', () => {
  // é o caso de 3.083 cartões da rede em 22/09/2026: "Lead 22261987"
  for (const [contato, esperado] of [
    ['Marinete', 'Marinete'],
    ['Elizete Muniz', 'Elizete Muniz'],
    ['Carina Souza', 'Carina Souza'],
    ['Rosa❤️', 'Rosa'],
    ['Irleide♥️♥️♥️♥️', 'Irleide'],
    ['  Lúcia   Correa ', 'Lúcia Correa'],
    // a recepção salva o contato com a data da consulta colada; a pessoa continua sendo Marlucia
    ['Marlucia 20/04/26', 'Marlucia'],
  ] as const) {
    const r = escolherNome('Lead 22261987', contato);
    assert.equal(r.ok, true, `${contato} devia servir`);
    if (r.ok) {
      assert.equal(r.nome, esperado);
      assert.equal(r.origem, 'contato');
    }
  }
});

test('nome: lixo do perfil continua barrado — nome errado na franquia é pior que cadastro faltando', () => {
  for (const contato of ['😃', '🥰', 'Ocupado', 'Cliente', 'Loja', 'Fly link', 'Trabalhando', '27999883699', '', null, undefined]) {
    const r = escolherNome('Lead 22261987', contato);
    assert.equal(r.ok, false, `"${contato}" não podia passar`);
  }
});

test('nome: quando nenhum dos dois serve, o motivo cita os dois', () => {
  const r = escolherNome('Lead 22261987', 'Ocupado');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.motivo, /Lead/, 'diz o que havia no card');
    assert.match(r.motivo, /WhatsApp/, 'diz que o do WhatsApp também não serviu');
  }
});

test('nome: card sem título nenhum ainda aproveita o WhatsApp', () => {
  const r = escolherNome('', 'Gustavo Pereira');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.nome, 'Gustavo Pereira');
});
