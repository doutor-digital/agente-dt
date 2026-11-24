/**
 * Pausar/religar CONDICIONAL (usado pelo painel Agente): a gravação só acontece se a unidade estava livre (pausar) ou pausada (religar),
 * no próprio UPDATE — duas pessoas pausando ao mesmo tempo não se sobrescrevem, e religar sem pausa não grava nem avisa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { aplicarPausa, retomar } = await import('./pausa.controller.js');
const { prisma } = await import('../lib/prisma.js');

const unidade = (o: Partial<Unit> = {}): Unit => ({ id: 'u1', slug: 'timbo', name: 'Timbó', pausaAte: null, pausaDesde: null, pausaMotivo: null, pausaPor: null, spineTimezone: 'America/Sao_Paulo', ...o }) as unknown as Unit;
const ate = new Date(Date.now() + 2 * 3_600_000).toISOString();

async function comUnit<T>(falso: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const p = prisma as unknown as { unit: unknown };
  const antes = p.unit;
  p.unit = falso;
  try {
    return await fn();
  } finally {
    p.unit = antes;
  }
}

test('pausar soSeLivre: o UPDATE só pega unidade sem pausa (ou com pausa que já acabou); count 0 = conflito com o estado de quem pausou', async () => {
  const wheres: unknown[] = [];
  const outra = unidade({ pausaAte: new Date(Date.now() + 3_600_000), pausaPor: 'Outra pessoa' });
  const r = await comUnit({ updateMany: async (a: { where: unknown }) => (wheres.push(a.where), { count: 0 }), findUniqueOrThrow: async () => outra, update: async () => { throw new Error('não pode usar o update solto'); } }, () =>
    aplicarPausa(unidade(), { ate, motivo: 'x' }, 'Cleia', { soSeLivre: true }),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.conflito?.pausaPor === 'Outra pessoa');
  const w = wheres[0] as { id: string; OR: Array<Record<string, unknown>> };
  assert.equal(w.id, 'u1');
  assert.deepEqual(w.OR[0], { pausaAte: null });
  assert.ok('lte' in (w.OR[1]!.pausaAte as object), 'pausa que já acabou conta como livre');
});

test('pausar soSeLivre: unidade livre grava (count 1) e devolve a unidade atualizada', async () => {
  const gravada = unidade({ pausaAte: new Date(ate), pausaMotivo: 'x', pausaPor: 'Cleia' });
  const r = await comUnit({ updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => gravada }, () => aplicarPausa(unidade(), { ate, motivo: 'x' }, 'Cleia', { soSeLivre: true }));
  assert.ok(r.ok && r.unit.pausaPor === 'Cleia');
});

test('religar soSeHouver: sem pausa (count 0) não grava de novo e não avisa; com pausa limpa', async () => {
  const chamadas: unknown[] = [];
  const livre = unidade();
  const a = await comUnit({ updateMany: async (x: { where: unknown }) => (chamadas.push(x.where), { count: 0 }), findUniqueOrThrow: async () => livre, update: async () => { throw new Error('sem update solto'); } }, () => retomar(livre, 'Cleia', { soSeHouver: true }));
  assert.equal(a.pausaAte, null);
  assert.equal((chamadas[0] as { id: string }).id, 'u1');
  assert.ok('gt' in ((chamadas[0] as { pausaAte: object }).pausaAte), 'só conta pausa que ainda vale (pausa_ate no futuro): pausa vencida não gera aviso falso');
  const limpa = unidade();
  const b = await comUnit({ updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => limpa }, () => retomar(unidade({ pausaAte: new Date(ate) }), 'Cleia', { soSeHouver: true }));
  assert.equal(b.pausaAte, null);
});
