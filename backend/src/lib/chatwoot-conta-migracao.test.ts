/**
 * Passo 1 do «uma conta do Chatwoot por clínica»: o banco. A chave do registro da régua passa a incluir a CAIXA (o id da conversa é por conta),
 * e as escritas de «desfazer» e «marcar» passam a levar a caixa. Para Parauapebas (uma conta só) nada muda: a caixa já era gravada em toda linha.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { prisma } = await import('./prisma.js');
const { armazemDoBanco } = await import('./chatwoot-regua-worker.js');
const { armazemDoBanco: armazemDoCapi } = await import('./chatwoot-capi.js');

/** Troca o delegate `chatwootReguaDisparo` do prisma por um falso que anota as chamadas; devolve como desfazer. */
function falsoDoDisparo(metodos: Record<string, (args: unknown) => unknown>) {
  const chamadas: Array<{ metodo: string; args: unknown }> = [];
  const falso = Object.fromEntries(Object.entries(metodos).map(([m, f]) => [m, async (args: unknown) => (chamadas.push({ metodo: m, args }), f(args))]));
  const original = Object.getOwnPropertyDescriptor(prisma, 'chatwootReguaDisparo');
  Object.defineProperty(prisma, 'chatwootReguaDisparo', { value: falso, configurable: true, writable: true });
  return {
    chamadas,
    restaurar: () => {
      if (original) Object.defineProperty(prisma, 'chatwootReguaDisparo', original);
      else delete (prisma as unknown as Record<string, unknown>).chatwootReguaDisparo;
    },
  };
}

const lerAqui = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('migration: o índice NOVO nasce antes de o antigo cair, a coluna conta_id é nula e sem valor padrão, e nada é apagado', () => {
  const sql = lerAqui('../../prisma/migrations/20261115120000_chatwoot_conta_por_unidade/migration.sql');
  const sem = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const novo = sem.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "chatwoot_regua_disparo_caixa_conversation_id_regra_chave_key"');
  const antigo = sem.indexOf('DROP INDEX IF EXISTS "chatwoot_regua_disparo_conversation_id_regra_chave_key"');
  assert.ok(novo >= 0 && antigo > novo, 'cria o novo e só depois derruba o antigo (nunca fica sem proteção)');
  assert.match(sem, /ALTER TABLE "unit_chatwoot" ADD COLUMN IF NOT EXISTS "conta_id" INTEGER;/);
  assert.doesNotMatch(sem, /DEFAULT|NOT NULL|DROP TABLE|DROP COLUMN|DELETE|TRUNCATE|UPDATE/i, 'só aditivo: sem valor padrão, sem apagar nem reescrever dado');
  assert.match(sem, /"caixa", "conversation_id", "regra", "chave"/);
});

test('schema: a chave única inclui a caixa e unit_chatwoot tem conta_id opcional', () => {
  const s = lerAqui('../../prisma/schema.prisma');
  assert.match(s, /@@unique\(\[caixa, conversationId, regra, chave\]\)\n\s+@@index\(\[caixa, criadoEm\]\)\n\s+@@map\("chatwoot_regua_disparo"\)/);
  assert.doesNotMatch(s, /@@unique\(\[conversationId, regra, chave\]\)/);
  assert.match(s, /contaId Int\? @map\("conta_id"\)/);
});

test('régua: desfazer só apaga a linha DA CAIXA (a conversa de mesmo id em outra conta fica)', async () => {
  const f = falsoDoDisparo({ deleteMany: () => ({ count: 1 }) });
  try {
    await armazemDoBanco().desfazer(5, 'consulta-vespera', '2026-11-17T14:30', 3);
    assert.deepEqual(f.chamadas, [{ metodo: 'deleteMany', args: { where: { caixa: 3, conversationId: 5, regra: 'consulta-vespera', chave: '2026-11-17T14:30' } } }]);
  } finally {
    f.restaurar();
  }
});

test('CAPI: desfazer e marcar também levam a caixa', async () => {
  const f = falsoDoDisparo({ deleteMany: () => ({ count: 1 }), updateMany: () => ({ count: 1 }) });
  try {
    const a = armazemDoCapi();
    await a.desfazer(5, 'capi:AddToCart', 'v1', 3);
    await a.marcar(5, 'capi:AddToCart', 'v1', 'incerto', 3);
    assert.deepEqual(f.chamadas, [
      { metodo: 'deleteMany', args: { where: { caixa: 3, conversationId: 5, regra: 'capi:AddToCart', chave: 'v1' } } },
      { metodo: 'updateMany', args: { where: { caixa: 3, conversationId: 5, regra: 'capi:AddToCart', chave: 'v1' }, data: { modo: 'incerto' } } },
    ]);
  } finally {
    f.restaurar();
  }
});

test('referrais do Kapso: com a caixa filtra por ela; sem a caixa (chamador antigo) a consulta é a de sempre', async () => {
  const { referraisGuardados } = await import('./kapso-referral.js');
  const f = falsoDoDisparo({ findMany: () => [] });
  try {
    await referraisGuardados(7);
    await referraisGuardados(7, 3);
    assert.deepEqual((f.chamadas[0]!.args as { where: unknown }).where, { conversationId: 7, regra: 'kapso-referral' });
    assert.deepEqual((f.chamadas[1]!.args as { where: unknown }).where, { caixa: 3, conversationId: 7, regra: 'kapso-referral' });
  } finally {
    f.restaurar();
  }
});
