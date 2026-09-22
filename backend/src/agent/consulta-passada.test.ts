import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agoraLocalISO, consultaNoPassado } from './prompt-composer.js';

test('consulta no passado: compara ISO local como texto, sem conversão de fuso', () => {
  const agora = '2026-09-21T11:52';
  // o caso real: consulta de sexta 18/09 às 16h, conversa retomada na segunda 21/09
  assert.equal(consultaNoPassado('2026-09-18T16:00', agora), true);
  assert.equal(consultaNoPassado('2026-09-22T17:00', agora), false);
  assert.equal(consultaNoPassado('2026-09-21T11:51', agora), true, 'um minuto atrás já passou');
  assert.equal(consultaNoPassado('2026-09-21T11:53', agora), false, 'daqui a um minuto ainda vale');
});

test('consulta no passado: sem data dos dois lados, nunca afirma que passou', () => {
  assert.equal(consultaNoPassado(null, '2026-09-21T11:52'), false);
  assert.equal(consultaNoPassado(undefined, '2026-09-21T11:52'), false);
  assert.equal(consultaNoPassado('2026-09-18T16:00', ''), false);
});

test('agora local: sai no fuso da unidade, no formato que a agenda usa', () => {
  const instante = new Date('2026-09-22T13:25:00Z');
  assert.equal(agoraLocalISO('America/Sao_Paulo', instante), '2026-09-22T10:25');
  assert.equal(agoraLocalISO('America/Boa_Vista', instante), '2026-09-22T09:25');
  // meia-noite não vira "24"
  assert.equal(agoraLocalISO('America/Sao_Paulo', new Date('2026-09-23T03:00:00Z')), '2026-09-23T00:00');
});

test('agora local e consulta se combinam: a virada do dia não engana', () => {
  const agora = agoraLocalISO('America/Sao_Paulo', new Date('2026-09-23T02:00:00Z')); // 22/09 23:00
  assert.equal(agora, '2026-09-22T23:00');
  assert.equal(consultaNoPassado('2026-09-22T17:00', agora), true, 'consulta de hoje à tarde já passou');
  assert.equal(consultaNoPassado('2026-09-23T08:00', agora), false, 'consulta de amanhã cedo não passou');
});
