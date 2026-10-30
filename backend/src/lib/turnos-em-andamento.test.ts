import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aguardarTurnos, comTurnoEmAndamento, esperarTurnosDoDesligamento, turnosEmAndamento } from './turnos-em-andamento.js';

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

// Timbó, lead 5142896, 30/10/2026: a foto estava na fila do coalescer (janela de 8 s), nenhum turno "em andamento",
// o desligamento saiu na hora e a mensagem morreu na memória.
test('o desligamento também espera a mensagem que ainda está na fila do coalescer', async () => {
  const { scheduleAgentRun } = await import('./agent-coalescer.js');
  const rodou: string[] = [];
  scheduleAgentRun({
    unitSlug: 'u', leadId: 77, traceId: 't1', humanMessage: 'foto', audioUrl: null, imageUrl: null,
    run: async (c) => { await dorme(30); rodou.push(c); },
  });
  assert.equal(turnosEmAndamento(), 0, 'a fila não conta como turno em andamento — é justamente o buraco');
  const r = await esperarTurnosDoDesligamento(5000);
  assert.deepEqual(rodou, ['foto']);
  assert.equal(r.filaRestante, 0);
  assert.equal(r.restantes, 0);
  assert.ok(r.esperouMs < 2000, `esperou ${r.esperouMs} ms`);
});

test('o desligamento espera também o turno fora do coalescer (Salesbot/Meta) com o que sobrou do teto', async () => {
  let acabou = false;
  const p = comTurnoEmAndamento(async () => { await dorme(120); acabou = true; });
  const r = await esperarTurnosDoDesligamento(3000);
  assert.equal(acabou, true);
  assert.equal(r.restantes, 0);
  assert.equal(r.filaRestante, 0);
  await p;
});

test('estourou o teto com a fila ainda rodando: filaRestante diz quantos ficaram', async () => {
  const { scheduleAgentRun } = await import('./agent-coalescer.js');
  scheduleAgentRun({ unitSlug: 'u', leadId: 78, traceId: 't1', humanMessage: 'lento', audioUrl: null, imageUrl: null, run: async () => { await dorme(500); } });
  const r = await esperarTurnosDoDesligamento(100);
  assert.equal(r.filaRestante, 1);
  await dorme(600);
});
