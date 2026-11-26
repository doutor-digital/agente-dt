/**
 * O armazém de produção (`armazemDeEscritaPrisma`) contra um Postgres DE VERDADE, com a migration real aplicada: duas conexões (duas "instâncias" do
 * servidor) disputando o teto do dia pela trava `pg_advisory_xact_lock`, referência repetida (violação de unicidade) e eventos do webhook. Só roda com
 * `TESTE_POSTGRES_URL` apontando para um banco DESCARTÁVEL (ele recria a tabela `infinitepay_links`), por exemplo:
 *   docker run -d --rm -p 55999:5432 -e POSTGRES_PASSWORD=t postgres:16
 *   TESTE_POSTGRES_URL=postgresql://postgres:t@127.0.0.1:55999/postgres pnpm exec tsx --test src/mcp-remoto/infinitepay-postgres.test.ts
 * Sem a variável o teste é pulado (a suíte normal não tem banco).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { criarContextoInfinitepay, infinitepayLinks, type ContaInfinitepay } from './infinitepay.js';
import { armazemDeEscritaPrisma } from './infinitepay-armazem.js';
import { criarEscritaInfinitepay, criarLink } from './infinitepay-escrita.js';

const BANCO = process.env.TESTE_POSTGRES_URL;
const UNI = 'doutor-hernia-acailandia';
const Q = { id: 'u-teste', email: 'j@x.com' };

function instancia(prisma: PrismaClient) {
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: { consultar: async () => ({ sucesso: true, pago: true }), testar: async () => undefined, criarLink: async (p) => ({ url: `https://checkout.infinitepay.io/x/${p.orderNsu}` }) },
  };
  const armazem = armazemDeEscritaPrisma(prisma as never);
  const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), armazem);
  const esc = criarEscritaInfinitepay({ armazem, agora: () => Date.now(), unidades: () => new Set([UNI]), tetoLink: () => 9000, tetoDia: () => 20000, porHora: () => 50, alertar: async () => true });
  return { ctx, esc, armazem };
}

test('Postgres de verdade: a migration aplica; duas instâncias disputando o teto do dia nunca passam de R$ 20.000; referência repetida e eventos do webhook', { skip: !BANCO }, async () => {
  // 16 "instâncias do servidor" (cada uma com o seu cliente de banco e a sua fila em memória), todas disputando ao mesmo tempo
  const clientes = Array.from({ length: 24 }, () => new PrismaClient({ datasourceUrl: BANCO }));
  const A = clientes[0]!;
  const B = clientes[1]!;
  try {
    await A.$executeRawUnsafe('DROP TABLE IF EXISTS "infinitepay_links"');
    const sql = readFileSync(path.resolve(process.cwd(), 'prisma/migrations/20261126120000_infinitepay_links/migration.sql'), 'utf8');
    for (const comando of sql.split(/;\s*\n/).map((c) => c.replace(/^(--.*\n)+/gm, '').trim()).filter(Boolean)) await A.$executeRawUnsafe(comando);

    const a = instancia(A);
    const b = instancia(B);
    // 24 pedidos de R$ 9.000, um por instância, ao mesmo tempo: cabem 2 (18.000); o resto é recusado
    const todas = clientes.map((c) => instancia(c));
    const r = await Promise.allSettled(todas.map((x, i) => criarLink(x.ctx, x.esc, Q, { valor: 9000, descricao: `Pacote ${i}`, referencia: `pg-${i}` })));
    const certos = r.filter((x) => x.status === 'fulfilled').length;
    assert.equal(certos, 2, `passaram ${certos} de 24 (cada um R$ 9.000)`);
    const recusas = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    assert.ok(recusas.every((x) => /teto do dia/.test(String(x.reason?.message))), 'todas as recusas são do teto do dia');
    const soma = await A.infinitepayLink.aggregate({ _sum: { valorCentavos: true }, where: { unitSlug: UNI } });
    assert.ok((soma._sum.valorCentavos ?? 0) <= 2_000_000, 'o banco nunca passa de R$ 20.000');

    // a duplicata vale entre as instâncias; referência repetida cai na unicidade do banco
    const dup = await criarLink(a.ctx, a.esc, Q, { valor: 10, descricao: 'Igual', referencia: 'dup-1' });
    assert.equal(dup.criado, true);
    await assert.rejects(() => criarLink(b.ctx, b.esc, Q, { valor: 10, descricao: 'Igual' }), /feito há menos de 10 minutos/);
    await assert.rejects(() => criarLink(b.ctx, b.esc, Q, { valor: 11, descricao: 'Outro texto', referencia: 'dup-1' }), /já foi usada/);

    // a referência de um link RECUSADO pela InfinitePay (falhou) é reaproveitada na mesma linha; a de um link que existe continua barrada
    await A.infinitepayLink.create({ data: { unitSlug: UNI, orderNsu: 'recusado-1', status: 'falhou', valorCentavos: 100, descricao: 'x', criadoPor: 'j', erro: '422' } });
    const reuso = await criarLink(b.ctx, b.esc, Q, { valor: 20, descricao: 'Corrigido', referencia: 'recusado-1' });
    assert.equal(reuso.criado, true);
    assert.equal(await A.infinitepayLink.count({ where: { unitSlug: UNI, orderNsu: 'recusado-1' } }), 1, 'a mesma linha, sem duplicar');
    assert.equal((await A.infinitepayLink.findFirst({ where: { unitSlug: UNI, orderNsu: 'recusado-1' } }))?.status, 'criado');

    // eventos do webhook: pago uma vez só; liquidação; estorno
    const e1 = await a.armazem.aplicarEvento(UNI, 'dup-1', { evento: 'paid', paraStatus: 'pago', deStatus: ['intencao', 'criado'], pagamento: { invoiceSlug: 's1', transactionNsu: 't1', forma: 'pix', parcelas: 1, valorPagoCentavos: 1000, reciboUrl: 'https://r' } });
    assert.equal(e1.mudou, true);
    assert.equal(e1.atual?.status, 'pago');
    assert.equal(e1.atual?.valorPagoCentavos, 1000);
    const e2 = await b.armazem.aplicarEvento(UNI, 'dup-1', { evento: 'paid', paraStatus: 'pago', deStatus: ['intencao', 'criado'] });
    assert.equal(e2.mudou, false, 'a mesma entrega repetida não muda de novo');
    const e3 = await a.armazem.aplicarEvento(UNI, 'dup-1', { evento: 'settled', liquidado: true });
    assert.equal(e3.mudou, true);
    assert.ok(e3.atual?.liquidadoEm);
    const e4 = await a.armazem.aplicarEvento(UNI, 'dup-1', { evento: 'refunded', paraStatus: 'estornado', deStatus: ['intencao', 'criado', 'pago'] });
    assert.equal(e4.atual?.status, 'estornado');

    // a leitura do conector lê a tabela de verdade
    const lista = await infinitepayLinks(a.ctx, {});
    assert.equal(lista.resumo.porStatus.estornado?.quantidade, 1);
    assert.ok(lista.resumo.links >= 3);
  } finally {
    await A.$executeRawUnsafe('DROP TABLE IF EXISTS "infinitepay_links"').catch(() => undefined);
    await Promise.all(clientes.map((c) => c.$disconnect()));
  }
});
