/** A fila de entrada contra Postgres de verdade. Só roda com `JOAOOF_TESTE_PG=1` e DATABASE_URL local (ver `repo-prisma.pg.test.ts`). */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const ligado = process.env.JOAOOF_TESTE_PG === '1' && /127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL ?? '');

test('entradaPrisma contra Postgres real', { skip: !ligado && 'defina JOAOOF_TESTE_PG=1 e um DATABASE_URL local' }, async (t) => {
  const { prisma } = await import('../lib/prisma.js');
  const { entradaPrisma } = await import('./entrada.js');
  await prisma.$executeRawUnsafe('TRUNCATE joaoof_entrada');
  const base = { fonte: 'grupo' as const, unidadeSlug: 'doutor-hernia-parauapebas', autorNome: 'Heloisa', autorChave: null, severidade: '', texto: 'preciso de uma arte' };

  await t.test('o par (fonte, ref) é único: ler o mesmo grupo duas vezes não duplica', async () => {
    assert.equal(await entradaPrisma.inserir([{ ...base, ref: 'p:1', escritaEm: new Date('2026-11-27T10:00:00Z') }, { ...base, ref: 'p:2', escritaEm: new Date('2026-11-27T09:00:00Z') }]), 2);
    assert.equal(await entradaPrisma.inserir([{ ...base, ref: 'p:1', escritaEm: new Date('2026-11-27T10:00:00Z') }, { ...base, ref: 'p:3', escritaEm: new Date('2026-11-27T11:00:00Z') }]), 1);
    assert.equal(await entradaPrisma.inserir([]), 0);
  });

  await t.test('pendentes vêm da mais antiga para a mais nova; processadas saem da fila; purga só apaga processadas velhas', async () => {
    const p = await entradaPrisma.pendentes(10);
    assert.deepEqual(p.map((e) => e.ref), ['p:2', 'p:1', 'p:3']);
    await entradaPrisma.marcarProcessadas([p[0]!.id, p[1]!.id], new Date('2026-11-20T00:00:00Z'));
    assert.deepEqual((await entradaPrisma.pendentes(10)).map((e) => e.ref), ['p:3']);
    assert.equal(await entradaPrisma.purgarProcessadas(new Date('2026-11-25T00:00:00Z')), 2);
    assert.equal((await entradaPrisma.pendentes(10)).length, 1);
  });

  await t.test('porRefs devolve as mensagens de origem de uma demanda (para a revisão de urgente)', async () => {
    const l = await entradaPrisma.porRefs(['p:3', 'nao-existe']);
    assert.deepEqual(l.map((e) => e.ref), ['p:3']);
    assert.deepEqual(await entradaPrisma.porRefs([]), []);
  });

  await t.test('evento do vigia entra na mesma fila', async () => {
    assert.equal(await entradaPrisma.inserir([{ ...base, fonte: 'vigia', ref: 'vigia:x', severidade: 'critico', texto: '[sofia_parada] sem resposta', escritaEm: new Date() }]), 1);
    assert.ok((await entradaPrisma.pendentes(10)).some((e) => e.fonte === 'vigia' && e.severidade === 'critico'));
  });
});

after(async () => {
  if (ligado) await (await import('../lib/prisma.js')).prisma.$disconnect();
});
