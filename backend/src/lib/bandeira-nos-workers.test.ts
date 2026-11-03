/**
 * Bandeira vermelha fora da reativação e do follow-up (03/11/2026): os dois workers que escolhem conversas no banco e
 * mandam mensagem de venda NÃO podem pegar um lead que parou por sinal de alerta.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import { candidatasDaReativacao } from './reactivation-worker.js';
import { candidatasDoFollowUp } from './follow-up-worker.js';

let bandeiras: Array<{ leadId: string }> = [];
let livroFalha = false;
let wheres: Array<Record<string, unknown>> = [];
Object.defineProperty(prisma, 'cardAlert', {
  value: {
    findMany: async () => {
      if (livroFalha) throw new Error('banco fora');
      return bandeiras;
    },
  },
  configurable: true,
});
Object.defineProperty(prisma, 'conversation', {
  value: {
    findMany: async (q: { where: Record<string, unknown> }) => {
      wheres.push(q.where);
      return [];
    },
  },
  configurable: true,
});

beforeEach(() => {
  bandeiras = [];
  wheres = [];
  livroFalha = false;
});

test('reativação: os leads com bandeira vermelha ficam fora da busca, no banco (notIn)', async () => {
  bandeiras = [{ leadId: '6111855' }, { leadId: '6153423' }];
  await candidatasDaReativacao({ id: 'u1' });
  assert.deepEqual(wheres[0].leadId, { notIn: ['6111855', '6153423'] });
  assert.equal(wheres[0].unitId, 'u1');
  assert.ok('handoffAt' in wheres[0], 'o resto da regra continua');
});

test('reativação: sem bandeira a busca é a de sempre (sem filtro de lead)', async () => {
  await candidatasDaReativacao({ id: 'u1' });
  assert.equal('leadId' in wheres[0], false);
});

test('follow-up: os leads com bandeira vermelha ficam fora da escada de venda', async () => {
  bandeiras = [{ leadId: '5997017' }];
  await candidatasDoFollowUp({ id: 'u1' });
  assert.deepEqual(wheres[0].leadId, { notIn: ['5997017'] });
  assert.equal(wheres[0].followUpStoppedReason, null, 'o resto da regra continua');
});

test('follow-up: sem bandeira a busca é a de sempre', async () => {
  await candidatasDoFollowUp({ id: 'u1' });
  assert.equal('leadId' in wheres[0], false);
});

test('sem conseguir ler o livro, os dois workers pulam a unidade (não mandam venda sem saber quem tem bandeira)', async () => {
  livroFalha = true;
  assert.deepEqual(await candidatasDaReativacao({ id: 'u1' }), []);
  assert.deepEqual(await candidatasDoFollowUp({ id: 'u1' }), []);
  assert.equal(wheres.length, 0, 'nem consultou as conversas');
});
