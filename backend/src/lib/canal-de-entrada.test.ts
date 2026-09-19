import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entraPelaMeta } from './canal-de-entrada.js';

test('lista vazia: todo mundo entra pelo Kommo', () => {
  // Este é o caso que importa. Com a dedução antiga, gravar credencial da Meta
  // numa unidade desligava o caminho do Kommo dela — Mossoró ficou um dia muda.
  assert.equal(entraPelaMeta('doutor-hernia-mossoro', ''), false);
  assert.equal(entraPelaMeta('doutor-hernia-mossoro', undefined), false);
  assert.equal(entraPelaMeta('doutor-hernia-mossoro', '   '), false);
});

test('só quem está escrito na lista entra pela Meta', () => {
  assert.equal(entraPelaMeta('doutor-hernia-mossoro', 'doutor-hernia-mossoro'), true);
  assert.equal(entraPelaMeta('doutor-hernia-serra', 'doutor-hernia-mossoro'), false);
  assert.equal(entraPelaMeta('doutor-hernia-serra', 'doutor-hernia-mossoro, doutor-hernia-serra'), true);
});

test('asterisco liga na rede toda', () => {
  assert.equal(entraPelaMeta('qualquer-unidade', '*'), true);
});

test('slug parecido não conta', () => {
  assert.equal(entraPelaMeta('doutor-hernia-mossoro', 'doutor-hernia-mossoro-2'), false);
});
