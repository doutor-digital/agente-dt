import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aguardarTurnos, comTurnoEmAndamento, turnosEmAndamento } from './turnos-em-andamento.js';

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('sem turno rodando, aguardar volta na hora', async () => {
  const r = await aguardarTurnos(1000);
  assert.equal(r.restantes, 0);
  assert.ok(r.esperouMs < 50);
});

test('o desligamento espera o turno terminar (e devolve o resultado dele)', async () => {
  let acabou = false;
  const turno = comTurnoEmAndamento(async () => {
    await dorme(150);
    acabou = true;
    return 42;
  });
  assert.equal(turnosEmAndamento(), 1);
  const r = await aguardarTurnos(2000, 10);
  assert.equal(acabou, true);
  assert.equal(r.restantes, 0);
  assert.equal(await turno, 42);
});

test('turno que estoura o teto não segura o desligamento além do prazo', async () => {
  const turno = comTurnoEmAndamento(() => dorme(400));
  const r = await aguardarTurnos(80, 10);
  assert.equal(r.restantes, 1);
  assert.ok(r.esperouMs < 300);
  await turno;
});

test('turno que falha também sai da conta', async () => {
  await assert.rejects(comTurnoEmAndamento(async () => { throw new Error('x'); }));
  assert.equal(turnosEmAndamento(), 0);
});
