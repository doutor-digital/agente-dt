import { test } from 'node:test';
import assert from 'node:assert/strict';

// Janela LONGA de propósito: o que se prova aqui é que o desligamento NÃO espera por ela.
process.env.AGENT_COALESCE_MS = '5000';
const { scheduleAgentRun, drenarCoalescer, comTurnoAvulso, idsEmVoo, _coalescerStats, _sairDoDesligamento } = await import('./agent-coalescer.js');

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

// ── "em voo": o que este processo tem na fila ou rodando ─────────────────────────────────────────────────────────

test('idsEmVoo: o trace entra ao agendar (fila e anexado ao burst) e SAI quando o turno termina', async () => {
  _sairDoDesligamento();
  assert.deepEqual(idsEmVoo().filter((i) => i.startsWith('ev-')), []);
  let liberar!: () => void;
  const trava = new Promise<void>((r) => { liberar = r; });
  const run = async () => { await trava; };
  scheduleAgentRun({ unitSlug: 'u', leadId: 10, traceId: 'ev-1', humanMessage: 'a', audioUrl: null, imageUrl: null, run });
  assert.deepEqual(idsEmVoo().filter((i) => i.startsWith('ev-')), ['ev-1'], 'na fila, esperando a janela, já é "em voo"');
  scheduleAgentRun({ unitSlug: 'u', leadId: 10, traceId: 'ev-2', humanMessage: 'b', audioUrl: null, imageUrl: null, run });
  assert.deepEqual(idsEmVoo().filter((i) => i.startsWith('ev-')).sort(), ['ev-1', 'ev-2'], 'mensagem anexada ao burst também');
  const p = drenarCoalescer(3000); // dispara o turno (que fica preso em `trava`)
  await dormir(60);
  assert.deepEqual(idsEmVoo().filter((i) => i.startsWith('ev-')).sort(), ['ev-1', 'ev-2'], 'rodando continua em voo');
  liberar();
  await p;
  assert.deepEqual(idsEmVoo().filter((i) => i.startsWith('ev-')), [], 'terminou: sai do conjunto');
  _sairDoDesligamento();
});

test('idsEmVoo: turno que lança erro também sai do conjunto', async () => {
  _sairDoDesligamento();
  scheduleAgentRun({ unitSlug: 'u', leadId: 11, traceId: 'ev-erro', humanMessage: 'a', audioUrl: null, imageUrl: null, run: async () => { throw new Error('boom'); } });
  await drenarCoalescer(2000);
  assert.deepEqual(idsEmVoo().filter((i) => i === 'ev-erro'), []);
  _sairDoDesligamento();
});

// ── turno avulso (burst cheio) ────────────────────────────────────────────────────────────────────────────────────

test('comTurnoAvulso: conta como em voo enquanto roda, devolve o resultado e sai (inclusive no erro)', async () => {
  let dentro: string[] = [];
  const v = await comTurnoAvulso('av-1', async () => { dentro = idsEmVoo(); return 42; });
  assert.equal(v, 42);
  assert.ok(dentro.includes('av-1'));
  assert.ok(!idsEmVoo().includes('av-1'));
  await assert.rejects(comTurnoAvulso('av-2', async () => { throw new Error('x'); }), /x/);
  assert.ok(!idsEmVoo().includes('av-2'));
  const r = await drenarCoalescer(200);
  assert.equal(r.restantes, 0, 'o contador de avulsos também volta a zero no erro');
  _sairDoDesligamento();
});

test('desligar espera o turno avulso (burst cheio) terminar; o que passa do teto é contado em restantes', async () => {
  _sairDoDesligamento();
  let terminou = false;
  const p = comTurnoAvulso('av-3', async () => { await dormir(150); terminou = true; });
  const r = await drenarCoalescer(3000);
  assert.equal(terminou, true, 'a drenagem esperou o turno avulso');
  assert.equal(r.restantes, 0);
  await p;

  let acabou = false;
  const p2 = comTurnoAvulso('av-4', async () => { await dormir(500); acabou = true; });
  const r2 = await drenarCoalescer(100);
  assert.equal(r2.restantes, 1, 'estourou o teto: diz que ficou 1');
  assert.equal(acabou, false);
  await p2;
  _sairDoDesligamento();
});

test('burst cheio (20 mensagens): a 21ª é recusada e NÃO entra em voo pelo coalescer', async () => {
  _sairDoDesligamento();
  const run = async () => { await dormir(10); };
  for (let i = 0; i < 20; i++) scheduleAgentRun({ unitSlug: 'u', leadId: 12, traceId: `cheio-${i}`, humanMessage: 'm', audioUrl: null, imageUrl: null, run });
  assert.equal(scheduleAgentRun({ unitSlug: 'u', leadId: 12, traceId: 'cheio-21', humanMessage: 'm', audioUrl: null, imageUrl: null, run }), 'rejected');
  assert.ok(!idsEmVoo().includes('cheio-21'), 'quem trata o rejeitado é o comTurnoAvulso do chamador');
  await drenarCoalescer(2000);
  _sairDoDesligamento();
});

test('desligando: mensagem que se junta a um burst parado também não espera a janela', async () => {
  _sairDoDesligamento();
  const runs: string[] = [];
  let fimDoPrimeiro!: () => void;
  const primeiroAcabou = new Promise<void>((r) => { fimDoPrimeiro = r; });
  scheduleAgentRun({ unitSlug: 'u', leadId: 13, traceId: 'j-a', humanMessage: 'A', audioUrl: null, imageUrl: null, run: async (c) => { runs.push(c); await dormir(30); fimDoPrimeiro(); } });
  const p = drenarCoalescer(3000);
  await dormir(10);
  scheduleAgentRun({ unitSlug: 'u', leadId: 13, traceId: 'j-b', humanMessage: 'B', audioUrl: null, imageUrl: null, run: async (c) => { runs.push(c); } });
  await primeiroAcabou;
  await new Promise((r) => setImmediate(r)); // o turno de A acabou; o de B está agendado, ainda não disparou
  scheduleAgentRun({ unitSlug: 'u', leadId: 13, traceId: 'j-c', humanMessage: 'C', audioUrl: null, imageUrl: null, run: async (c) => { runs.push(c); } });
  const r = await p;
  assert.equal(r.restantes, 0);
  assert.ok(r.esperouMs < 1500, `esperou ${r.esperouMs} ms — a mensagem que se juntou esperou a janela de 5 s`);
  assert.equal(runs[0], 'A');
  assert.ok(runs.join('|').includes('C'));
  _sairDoDesligamento();
});
