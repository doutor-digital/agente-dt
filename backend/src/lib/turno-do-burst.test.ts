import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rodarTurnoDoBurst, type FecharSatelites } from './turno-do-burst.js';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fechadorFalso() {
  const chamadas: Array<{ ownerTraceId: string; satelliteTraceIds: string[]; falhou: boolean; quando: number }> = [];
  let passo = 0;
  const fechar: FecharSatelites = async (p) => { chamadas.push({ ...p, quando: ++passo }); };
  return { chamadas, fechar, proximoPasso: () => ++passo };
}

test('o dono roda o turno; os satélites só fecham DEPOIS dele (SUCCESS)', async () => {
  const f = fechadorFalso();
  const ordem: string[] = [];
  await rodarTurnoDoBurst(['dono', 's1', 's2'], async (owner) => {
    assert.equal(owner, 'dono');
    await dormir(20);
    assert.equal(f.chamadas.length, 0, 'durante o turno os satélites ainda estão abertos (RUNNING)');
    ordem.push('turno');
  }, async (p) => { ordem.push('fechou'); await f.fechar(p); });
  assert.deepEqual(ordem, ['turno', 'fechou']);
  assert.deepEqual(f.chamadas.map((c) => [c.ownerTraceId, c.satelliteTraceIds, c.falhou]), [['dono', ['s1', 's2'], false]]);
});

test('se o processo morre no meio do turno, nada fecha os satélites (a função nunca chega ao finally)', async () => {
  const f = fechadorFalso();
  // simula a morte: o turno nunca termina
  void rodarTurnoDoBurst(['dono', 's1'], () => new Promise<void>(() => undefined), f.fechar);
  await dormir(30);
  assert.equal(f.chamadas.length, 0);
});

test('turno que lança erro: relança e fecha os satélites como FALHA (não esconde atrás de SUCCESS)', async () => {
  const f = fechadorFalso();
  await assert.rejects(rodarTurnoDoBurst(['dono', 's1'], async () => { throw new Error('modelo caiu'); }, f.fechar), /modelo caiu/);
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0]!.falhou, true);
});

test('mensagem única (sem satélites): não toca no banco', async () => {
  const f = fechadorFalso();
  await rodarTurnoDoBurst(['dono'], async () => undefined, f.fechar);
  assert.equal(f.chamadas.length, 0);
});

test('falha ao fechar os satélites não derruba o turno nem vira erro', async () => {
  await rodarTurnoDoBurst(['dono', 's1'], async () => undefined, async () => { throw new Error('banco fora'); });
});
