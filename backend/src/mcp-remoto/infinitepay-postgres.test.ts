/**
 * O armazém de produção (`armazemDeEscritaPrisma`) contra um Postgres DE VERDADE, com a migration real aplicada: duas conexões (duas "instâncias" do
 * servidor) disputando o teto do dia pela trava `pg_advisory_xact_lock`, referência repetida (violação de unicidade) e eventos do webhook. Só roda com
 * `TESTE_POSTGRES_URL` apontando para um banco DESCARTÁVEL (ele recria a tabela `infinitepay_links`), por exemplo:
 *   docker run -d --rm -p 55999:5432 -e POSTGRES_PASSWORD=t -e POSTGRES_DB=teste postgres:16
 *   TESTE_POSTGRES_URL=postgresql://postgres:t@127.0.0.1:55999/teste pnpm exec tsx --test src/mcp-remoto/infinitepay-postgres.test.ts
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
// o teste APAGA a tabela infinitepay_links: só roda contra um banco local DESCARTÁVEL (127.0.0.1/localhost e «teste» no nome do banco), igual ao outro teste que usa a mesma variável
if (BANCO && !(/^postgres(ql)?:\/\/[^/]*@(127\.0\.0\.1|localhost)(:\d+)?\/[^/?]*teste/i.test(BANCO))) {
  throw new Error('TESTE_POSTGRES_URL recusada: só 127.0.0.1/localhost e banco com "teste" no nome (o teste apaga a tabela infinitepay_links).');
}
const UNI = 'doutor-hernia-acailandia';
const Q = { id: 'u-teste', email: 'j@x.com' };

function instancia(prisma: PrismaClient) {
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: { consultar: async () => ({ sucesso: true, pago: true }), testar: async () => undefined, criarLink: async (p) => ({ url: `https://checkout.infinitepay.io/x/${p.orderNsu}` }) },
  };
  const armazem = armazemDeEscritaPrisma(prisma as never);
  const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), armazem);
  const esc = criarEscritaInfinitepay({ armazem, agora: () => Date.now(), unidades: () => new Set([UNI]), tetoLink: () => 9000, tetoDia: (o) => (o === 'sofia' ? 1000 : 20000), porHora: () => 50, alertar: async () => true });
  return { ctx, esc, armazem };
}

test('Postgres de verdade: a migration aplica; duas instâncias disputando o teto do dia nunca passam de R$ 20.000; referência repetida e eventos do webhook', { skip: !BANCO }, async () => {
  // 16 "instâncias do servidor" (cada uma com o seu cliente de banco e a sua fila em memória), todas disputando ao mesmo tempo
  const clientes = Array.from({ length: 24 }, () => new PrismaClient({ datasourceUrl: BANCO }));
  const A = clientes[0]!;
  const B = clientes[1]!;
  try {
    await A.$executeRawUnsafe('DROP TABLE IF EXISTS "infinitepay_links"');
    // TODAS as migrations que mexem na tabela, na ordem (o Prisma Client lê todas as colunas do schema: faltando uma, nada funciona)
    for (const m of ['20261126120000_infinitepay_links', '20261126125000_infinitepay_links_revisao', '20261126200000_infinitepay_origem_ref']) {
      const sql = readFileSync(path.resolve(process.cwd(), `prisma/migrations/${m}/migration.sql`), 'utf8');
      for (const comando of sql.split(/;\s*\n/).map((c) => c.replace(/^(--.*\n)+/gm, '').trim()).filter(Boolean)) await A.$executeRawUnsafe(comando);
    }

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
    assert.equal(await A.infinitepayLink.count({ where: { unitSlug: UNI, orderNsu: 'recusado-1' } }), 1, 'a referência volta a ter UMA linha ativa');
    assert.equal((await A.infinitepayLink.findFirst({ where: { unitSlug: UNI, orderNsu: 'recusado-1' } }))?.status, 'criado');
    // a tentativa recusada FICA como histórico (referência trocada) e continua contando no limite por hora
    const historico = await A.infinitepayLink.findMany({ where: { unitSlug: UNI, orderNsu: { startsWith: 'recusado-1~f' } } });
    assert.equal(historico.length, 1);
    assert.equal(historico[0]!.status, 'falhou');

    // referência de ORIGEM: 24 instâncias pedindo o MESMO link ao mesmo tempo criam UM só (a trava da unidade + o índice único); o resto recebe o mesmo link
    const pedidosOrigem: string[] = [];
    const comContador = (prisma: PrismaClient) => {
      const x = instancia(prisma);
      const conta = x.ctx.contas.get(UNI)!;
      const original = conta.fonte.criarLink!;
      conta.fonte.criarLink = async (p) => (pedidosOrigem.push(p.orderNsu), original(p));
      return x;
    };
    const ro = await Promise.allSettled(clientes.map((c) => { const x = comContador(c); return criarLink(x.ctx, x.esc, Q, { valor: 5, descricao: 'Origem igual', origemRef: 'cx-corrida' }); }));
    // quem perde a corrida pela regra dos 10 minutos (mesma descrição) também é aceitável: o que importa é UM link no banco e na InfinitePay
    assert.equal(pedidosOrigem.length, 1, 'a InfinitePay foi chamada uma vez só');
    assert.equal(await A.infinitepayLink.count({ where: { unitSlug: UNI, origemRef: 'cx-corrida' } }), 1);
    const ok = ro.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof criarLink>>> => x.status === 'fulfilled');
    assert.ok(ok.length >= 1);
    assert.equal(new Set(ok.map((x) => x.value.orderNsu)).size, 1, 'todos que voltaram com sucesso têm o mesmo link');
    // cancelado NÃO libera a referência de origem (o webhook ainda aceita pago): pedir de novo devolve o mesmo link
    const o1 = (await A.infinitepayLink.findFirst({ where: { unitSlug: UNI, origemRef: 'cx-corrida' } }))!;
    await a.armazem.aplicarEvento(UNI, o1.orderNsu, { evento: 'canceled', paraStatus: 'cancelado', deStatus: ['criado', 'intencao'] });
    const de_novo = await criarLink(a.ctx, a.esc, Q, { valor: 5, descricao: 'Origem igual', origemRef: 'cx-corrida' });
    assert.equal(de_novo.criado, false);
    assert.equal(de_novo.orderNsu, o1.orderNsu);
    assert.equal(await A.infinitepayLink.count({ where: { unitSlug: UNI, origemRef: 'cx-corrida' } }), 1);
    // recusado (falhou) libera: a linha velha ganha a referência trocada e a nova fica com a original
    await A.infinitepayLink.create({ data: { unitSlug: UNI, orderNsu: 'orig-falhou', status: 'falhou', valorCentavos: 700, descricao: 'x', criadoPor: 'j', erro: '422', origemRef: 'cx-falhou' } });
    const nova = await criarLink(b.ctx, b.esc, Q, { valor: 7, descricao: 'Origem corrigida', origemRef: 'cx-falhou' });
    assert.equal(nova.criado, true);
    assert.equal(await A.infinitepayLink.count({ where: { unitSlug: UNI, origemRef: 'cx-falhou' } }), 1);
    assert.equal(await A.infinitepayLink.count({ where: { unitSlug: UNI, origemRef: { startsWith: 'cx-falhou~f' } } }), 1);
    // o índice único é a última defesa: duas linhas vivas com a mesma origem não existem
    await assert.rejects(() => A.infinitepayLink.create({ data: { unitSlug: UNI, orderNsu: 'dup-origem', status: 'criado', valorCentavos: 100, descricao: 'x', criadoPor: 'j', origemRef: 'cx-falhou' } }));

    // a ORIGEM fica gravada e o livro é por origem: a Sofia emite um sinal mesmo com o teto do dia do conector já estourado nesta unidade
    const sofia = await criarLink(a.ctx, a.esc, Q, { valor: 50, descricao: 'Sinal Sofia', origem: 'sofia' });
    assert.equal(sofia.criado, true);
    assert.equal((await A.infinitepayLink.findFirst({ where: { unitSlug: UNI, orderNsu: sofia.orderNsu } }))?.origem, 'sofia');
    assert.equal((await A.infinitepayLink.findFirst({ where: { unitSlug: UNI, orderNsu: 'dup-1' } }))?.origem, 'conector', 'o padrão é conector');

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
    // estorno avisado NÃO desfaz o pago: marca revisão (coluna nova) e o status segue
    const e4 = await a.armazem.aplicarEvento(UNI, 'dup-1', { evento: 'refunded', revisao: '[estorno avisado] estorno avisado, NÃO confirmado pela API' });
    assert.equal(e4.atual?.status, 'pago');
    assert.equal(e4.atual?.revisao, '[estorno avisado] estorno avisado, NÃO confirmado pela API');
    assert.equal(e4.marcou, true);
    assert.equal(e4.atual?.ultimoEvento, 'refunded');
    // as marcas ACUMULAM no banco (compara e troca): cancelamento depois do estorno não apaga o estorno, e a mesma marca de novo não duplica
    const e5 = await b.armazem.aplicarEvento(UNI, 'dup-1', { evento: 'canceled', revisao: '[cancelamento avisado] cancelamento avisado em x, NÃO confirmado pela API' });
    assert.match(e5.atual?.revisao ?? '', /^\[estorno avisado\].* \| \[cancelamento avisado\]/);
    const e6 = await a.armazem.aplicarEvento(UNI, 'dup-1', { evento: 'canceled', revisao: '[cancelamento avisado] cancelamento avisado em y, NÃO confirmado pela API' });
    assert.equal(e6.atual?.revisao, e5.atual?.revisao, 'a mesma marca não duplica');
    assert.equal(e6.marcou, false, 'e quem não acrescentou nada não é quem avisa');

    // a leitura do conector lê a tabela de verdade
    const lista = await infinitepayLinks(a.ctx, {});
    assert.equal(lista.resumo.emRevisao, 1);
    assert.ok(lista.resumo.links >= 3);
  } finally {
    await A.$executeRawUnsafe('DROP TABLE IF EXISTS "infinitepay_links"').catch(() => undefined);
    await Promise.all(clientes.map((c) => c.$disconnect()));
  }
});
