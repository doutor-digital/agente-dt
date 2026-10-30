import { test } from 'node:test';
import assert from 'node:assert/strict';

// Janela LONGA de propósito: o que se prova aqui é que o desligamento NÃO espera por ela.
process.env.AGENT_COALESCE_MS = '5000';
const { scheduleAgentRun, drenarCoalescer, _coalescerStats, _sairDoDesligamento } = await import('./agent-coalescer.js');

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Caso real (Timbó, lead 5142896, 30/10/2026): a paciente mandou uma foto 18 s depois do áudio. O turno do áudio
 * segurou a resposta ("atropelada") e a foto ficou na fila do coalescer, esperando a janela. O deploy chegou nesse
 * intervalo: o desligamento só esperava a chamada ao modelo, saiu na hora, e a foto morreu na memória.
 */
test('desligar com mensagem na janela de espera: o turno roda JÁ, sem esperar a janela', async () => {
  _sairDoDesligamento();
  const runs: string[] = [];
  scheduleAgentRun({ unitSlug: 'u', leadId: 1, traceId: 't1', humanMessage: 'foto', audioUrl: null, imageUrl: null, run: async (c) => { runs.push(c); } });
  assert.equal(_coalescerStats().activeBursts, 1);
  const r = await drenarCoalescer(3000);
  assert.deepEqual(runs, ['foto']);
  assert.equal(r.restantes, 0);
  assert.ok(r.esperouMs < 1500, `esperou ${r.esperouMs} ms — não pode esperar a janela de 5 s`);
  assert.equal(_coalescerStats().activeBursts, 0);
});

test('desligar com turno rodando e mensagem encadeada: o segundo turno também roda, sem esperar a janela', async () => {
  _sairDoDesligamento();
  const runs: string[] = [];
  const run = async (c: string) => { runs.push(c); await dormir(60); };
  scheduleAgentRun({ unitSlug: 'u', leadId: 2, traceId: 't1', humanMessage: 'áudio', audioUrl: null, imageUrl: null, run });
  // o primeiro turno dispara agora (desligamento) e, enquanto roda, a foto chega e se junta ao burst em curso
  const p = drenarCoalescer(4000);
  await dormir(20);
  assert.equal(
    scheduleAgentRun({ unitSlug: 'u', leadId: 2, traceId: 't2', humanMessage: 'foto', audioUrl: null, imageUrl: null, run }),
    'joined',
  );
  const r = await p;
  assert.deepEqual(runs, ['áudio', 'foto']);
  assert.equal(r.restantes, 0);
  assert.ok(r.esperouMs < 1500, `esperou ${r.esperouMs} ms`);
});

test('turno que não acaba estoura o teto: o desligamento sai e diz quantos ficaram', async () => {
  _sairDoDesligamento();
  scheduleAgentRun({ unitSlug: 'u', leadId: 3, traceId: 't1', humanMessage: 'oi', audioUrl: null, imageUrl: null, run: async () => { await dormir(600); } });
  const r = await drenarCoalescer(100);
  assert.equal(r.restantes, 1);
  assert.ok(r.esperouMs >= 100 && r.esperouMs < 500);
  await dormir(700); // deixa o turno acabar para não vazar para o próximo teste
});

test('sem nada na fila, drenar volta na hora', async () => {
  _sairDoDesligamento();
  const r = await drenarCoalescer(3000);
  assert.equal(r.restantes, 0);
  assert.ok(r.esperouMs < 100);
});

test('depois de entrar em desligamento, mensagem nova não espera a janela', async () => {
  _sairDoDesligamento();
  await drenarCoalescer(100);
  const runs: string[] = [];
  scheduleAgentRun({ unitSlug: 'u', leadId: 5, traceId: 't1', humanMessage: 'tardia', audioUrl: null, imageUrl: null, run: async (c) => { runs.push(c); } });
  await dormir(200);
  assert.deepEqual(runs, ['tardia']);
  _sairDoDesligamento();
});
