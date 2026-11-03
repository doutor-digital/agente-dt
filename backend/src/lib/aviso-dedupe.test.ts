import { test } from 'node:test';
import assert from 'node:assert/strict';

import { marcadoEmNaConta } from './aviso-dedupe.js';

test('marcadoEmNaConta: a marca MAIS RECENTE entre as unidades da conta; nenhuma = null', async () => {
  const marcas: Record<string, Date | null> = {
    u1: new Date('2026-11-03T11:00:00Z'),
    u2: new Date('2026-11-03T11:30:00Z'),
    u3: null,
  };
  const lidas: string[] = [];
  const ler = async (unitId: string, leadId: number | string, regra: string) => {
    lidas.push(`${unitId}:${leadId}:${regra}`);
    return marcas[unitId] ?? null;
  };
  assert.equal((await marcadoEmNaConta(['u1', 'u2', 'u3'], 7165547, 'sem_resposta_tarefa', ler))?.toISOString(), '2026-11-03T11:30:00.000Z');
  assert.deepEqual(lidas, ['u1:7165547:sem_resposta_tarefa', 'u2:7165547:sem_resposta_tarefa', 'u3:7165547:sem_resposta_tarefa']);
  assert.equal((await marcadoEmNaConta(['u2', 'u1'], 1, 'x', ler))?.toISOString(), '2026-11-03T11:30:00.000Z', 'a ordem não importa');
  assert.equal(await marcadoEmNaConta(['u3'], 1, 'x', ler), null);
  assert.equal(await marcadoEmNaConta([], 1, 'x', ler), null);
});
