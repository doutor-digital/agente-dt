import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, instanteNoFuso, localParaUtcIso } from './spine.service.js';

/**
 * Os números abaixo foram conferidos contra a API da franquia em 31/08/2026,
 * varrendo 800 agendamentos reais de três meses da Imperatriz:
 *
 *     37 AGENDADO          3
 *     38 CONFIRMADO        7
 *     40 NÃO COMPARECEU    5
 *     41 REMARCADO        21
 *     42 ATENDIDO        548
 *     57 DESMARCADO      216
 *
 * Existe porque um relatório escreveu 39 para "remarcado" em vez de usar a
 * constante, e o número simplesmente não existe na API: a coluna de remarcadas
 * mostrou zero para todo mundo, sem erro nenhum aparecer.
 */
test('os ids são os que a franquia devolve de verdade', () => {
  assert.equal(SPINE_STATUS.AGENDADO, 37);
  assert.equal(SPINE_STATUS.CONFIRMADO, 38);
  assert.equal(SPINE_STATUS.NAO_COMPARECEU, 40);
  assert.equal(SPINE_STATUS.REMARCADO, 41);
  assert.equal(SPINE_STATUS.ATENDIDO, 42);
  assert.equal(SPINE_STATUS.DESMARCADO, 57);
});

test('39 não é status nenhum — foi o número inventado que quebrou o relatório', () => {
  assert.ok(
    !Object.values(SPINE_STATUS).includes(39 as never),
    '39 não existe na API da franquia; nenhuma constante deve valer 39',
  );
});

test('nenhum id se repete — dois nomes no mesmo número somariam errado', () => {
  const ids = Object.values(SPINE_STATUS);
  assert.equal(new Set(ids).size, ids.length);
});

test('atendido e não compareceu são distintos — é o placar do dia', () => {
  assert.notEqual(SPINE_STATUS.ATENDIDO, SPINE_STATUS.NAO_COMPARECEU);
});

test('desmarcado e não compareceu são coisas diferentes', () => {
  // desmarcou antes é aviso; não compareceu é horário perdido. Somar junto
  // esconde o no-show, que é o número que a clínica precisa ver.
  assert.notEqual(SPINE_STATUS.DESMARCADO, SPINE_STATUS.NAO_COMPARECEU);
});

test('a hora local vai sem fuso — converter pra UTC atrasa a consulta em 3h', () => {
  const iso = instanteNoFuso(new Date('2026-08-31T13:00:00Z'), 'America/Sao_Paulo');
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.ok(!/Z$/.test(iso), 'não pode terminar em Z: a franquia espera hora local');
  assert.match(iso, /T10:/, '13:00 UTC são 10:00 em Brasília');
});

test('cada fuso devolve a sua hora, não a do servidor', () => {
  const t = new Date('2026-08-31T13:00:00Z');
  assert.match(instanteNoFuso(t, 'America/Sao_Paulo'), /T10:/);
  assert.match(instanteNoFuso(t, 'America/Boa_Vista'), /T09:/);
});

test('local para UTC volta certo no fuso de Brasília', () => {
  const utc = localParaUtcIso('2026-08-31T10:00:00', 'America/Sao_Paulo');
  assert.equal(utc?.slice(0, 13), '2026-08-31T13');
});

test('local para UTC respeita Roraima, que é UTC-4', () => {
  const utc = localParaUtcIso('2026-08-31T09:00:00', 'America/Boa_Vista');
  assert.equal(utc?.slice(0, 13), '2026-08-31T13');
});

test('data inválida não vira hora errada, vira nulo', () => {
  assert.equal(localParaUtcIso('nao é data', 'America/Sao_Paulo'), null);
});
