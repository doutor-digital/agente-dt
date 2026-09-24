import { test } from 'node:test';
import assert from 'node:assert/strict';

// Janela curtíssima só para o teste — a de produção é AGENT_COALESCE_MS (padrão 8 s).
process.env.AGENT_COALESCE_MS = '40';
const { scheduleAgentRun, _coalescerStats, temPendentes } = await import('./agent-coalescer.js');

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * O coalescer junta mensagens que o paciente manda em rajada ("oi" / "tudo bem?" /
 * "queria marcar") num turno só, para a IA responder uma vez. Sem isto, cada linha
 * vira uma resposta e a conversa fica com três "oi, tudo bem" seguidos.
 */
test('duas mensagens dentro da janela viram UM turno com o texto combinado', async () => {
  const runs: string[] = [];
  const run = async (combined: string) => { runs.push(combined); };
  const a = scheduleAgentRun({ unitSlug: 'u', leadId: 1, traceId: 't1', humanMessage: 'Ok obrigado', audioUrl: null, imageUrl: null, run });
  const b = scheduleAgentRun({ unitSlug: 'u', leadId: 1, traceId: 't2', humanMessage: '🙏', audioUrl: null, imageUrl: null, run });
  assert.equal(a, 'started');
  assert.equal(b, 'joined');
  await dormir(120);
  assert.deepEqual(runs, ['Ok obrigado\n\n🙏']);
  assert.equal(_coalescerStats().activeBursts, 0);
});

test('mensagem que chega DEPOIS da janela vira outro turno', async () => {
  const runs: string[] = [];
  const run = async (combined: string) => { runs.push(combined); };
  scheduleAgentRun({ unitSlug: 'u', leadId: 2, traceId: 't1', humanMessage: 'primeira', audioUrl: null, imageUrl: null, run });
  await dormir(100);
  scheduleAgentRun({ unitSlug: 'u', leadId: 2, traceId: 't2', humanMessage: 'segunda', audioUrl: null, imageUrl: null, run });
  await dormir(100);
  assert.deepEqual(runs, ['primeira', 'segunda']);
});

test('mensagem que chega ENQUANTO a IA responde é encadeada no próximo turno, sem se perder', async () => {
  const runs: string[] = [];
  const run = async (combined: string) => { runs.push(combined); await dormir(80); };
  scheduleAgentRun({ unitSlug: 'u', leadId: 3, traceId: 't1', humanMessage: 'quero marcar', audioUrl: null, imageUrl: null, run });
  await dormir(60); // já disparou e está "respondendo"
  const st = scheduleAgentRun({ unitSlug: 'u', leadId: 3, traceId: 't2', humanMessage: 'de manhã', audioUrl: null, imageUrl: null, run });
  assert.equal(st, 'joined');
  await dormir(250);
  assert.deepEqual(runs, ['quero marcar', 'de manhã']);
});

test('temPendentes só é verdade enquanto a IA responde E chegou mensagem nova', async () => {
  const run = async () => { await dormir(120); };
  assert.equal(temPendentes('u', 6), false, 'sem burst, nada pendente');
  scheduleAgentRun({ unitSlug: 'u', leadId: 6, traceId: 't1', humanMessage: 'quero marcar', audioUrl: null, imageUrl: null, run });
  assert.equal(temPendentes('u', 6), false, 'na janela de espera a mensagem ainda é do turno atual, não pendente');
  await dormir(60); // disparou: está respondendo
  assert.equal(temPendentes('u', 6), false, 'respondendo sem mensagem nova: nada a segurar');
  scheduleAgentRun({ unitSlug: 'u', leadId: 6, traceId: 't2', humanMessage: 'de manhã', audioUrl: null, imageUrl: null, run });
  assert.equal(temPendentes('u', 6), true, 'chegou mensagem durante a resposta: o envio deve segurar');
  assert.equal(temPendentes('u', 7), false, 'outro lead não é afetado');
  await dormir(350);
  assert.equal(temPendentes('u', 6), false, 'depois que o turno encadeado rodou, limpa');
});

test('leads diferentes não se misturam', async () => {
  const runs: string[] = [];
  const run = async (combined: string) => { runs.push(combined); };
  scheduleAgentRun({ unitSlug: 'u', leadId: 4, traceId: 't1', humanMessage: 'A', audioUrl: null, imageUrl: null, run });
  scheduleAgentRun({ unitSlug: 'u', leadId: 5, traceId: 't2', humanMessage: 'B', audioUrl: null, imageUrl: null, run });
  await dormir(120);
  assert.deepEqual(runs.sort(), ['A', 'B']);
});
