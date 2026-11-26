import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contaInfinitepayDaConfig,
  criarContextoInfinitepay,
  infinitepayContas,
  infinitepayLinks,
  infinitepayStatusPagamento,
  registrarFerramentasInfinitepay,
  type ArmazemDeLinks,
  type ContaInfinitepay,
  type LinkGuardado,
} from './infinitepay.js';
import { armazemDeLinksPrisma, type LinhaDoLink } from './infinitepay-armazem.js';
import { listarIntegracoes } from './integracoes.js';

const CHAVE = 'inchk_FIXTURE0123456789abcdefghijklmnopqrstu';

function link(o: Partial<LinkGuardado> = {}): LinkGuardado {
  return {
    orderNsu: 'dd-1', unidade: 'doutor-hernia-acailandia', status: 'criado', url: 'https://checkout.infinitepay.io/x/dd-1', valorCentavos: 15000, descricao: 'Consulta',
    validoAte: null, criadoPor: 'u1', criadoEm: '2026-11-26T12:00:00.000Z', invoiceSlug: null, transactionNsu: null, formaPagamento: null, parcelas: null,
    valorPagoCentavos: null, reciboUrl: null, pagoEm: null, liquidadoEm: null, ultimoEvento: null, erro: null, ...o,
  };
}

function armazem(itens: LinkGuardado[]): ArmazemDeLinks & { filtros: unknown[] } {
  const filtros: unknown[] = [];
  return {
    filtros,
    async listar(f) {
      filtros.push(f);
      return itens.filter((l) => (!f.status || l.status === f.status) && (!f.orderNsu || l.orderNsu === f.orderNsu));
    },
    async porOrderNsu(_u, o) {
      return itens.find((l) => l.orderNsu === o) ?? null;
    },
  };
}

function conta(slug = 'doutor-hernia-acailandia', consultar?: ContaInfinitepay['fonte']['consultar']): ContaInfinitepay {
  return {
    slug, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: {
      consultar: consultar ?? (async () => ({ sucesso: true, pago: true, valorCentavos: 15000, valorPagoCentavos: 15000, parcelas: 1, forma: 'pix' })),
      testar: async () => undefined,
    },
  };
}

const ctxCom = (itens: LinkGuardado[] = [], c: ContaInfinitepay = conta()) => criarContextoInfinitepay(new Map([[c.slug, c]]), armazem(itens));

test('status_pagamento: devolve em reais, com o registro do link do conector quando existe', async () => {
  const r = await infinitepayStatusPagamento(ctxCom([link()]), { orderNsu: 'dd-1', transactionNsu: 't', slug: 's' });
  assert.equal(r.pago, true);
  assert.equal(r.valor, 150);
  assert.equal(r.forma, 'pix');
  assert.equal(r.linkDoConector?.orderNsu, 'dd-1');
  assert.equal(r.linkDoConector?.valor, 150);
});

test('status_pagamento: link que não é do conector volta sem registro; success:false vira aviso, não erro', async () => {
  const c = conta('doutor-hernia-acailandia', async () => ({ sucesso: false, pago: false }));
  const r = await infinitepayStatusPagamento(ctxCom([], c), { orderNsu: 'avulso', transactionNsu: 't', slug: 's' });
  assert.equal(r.pago, false);
  assert.equal(r.reconhecido, false);
  assert.match(String(r.aviso), /não reconheceu/);
  assert.equal(r.linkDoConector, null);
});

test('status_pagamento: sem os três códigos, recusa antes de chamar a InfinitePay', async () => {
  let chamou = false;
  const c = conta('doutor-hernia-acailandia', async () => ((chamou = true), { sucesso: true, pago: true }));
  await assert.rejects(() => infinitepayStatusPagamento(ctxCom([], c), { orderNsu: 'o', transactionNsu: ' ', slug: 's' }), /preciso dos três/);
  assert.equal(chamou, false);
});

test('status_pagamento: valor pago diferente do valor traz a nota das taxas repassadas', async () => {
  const c = conta('doutor-hernia-acailandia', async () => ({ sucesso: true, pago: true, valorCentavos: 10000, valorPagoCentavos: 10150 }));
  const r = await infinitepayStatusPagamento(ctxCom([], c), { orderNsu: 'o', transactionNsu: 't', slug: 's' });
  assert.match(String(r.nota), /taxas repassadas/);
});

test('unidade: sem ligação recusa dizendo onde fica a chave; várias contas exigem a unidade; nome curto resolve', async () => {
  const vazio = criarContextoInfinitepay(new Map(), armazem([]));
  await assert.rejects(() => infinitepayLinks(vazio, {}), /INFINITEPAY_CHAVE_/);
  const duas = criarContextoInfinitepay(new Map([[conta().slug, conta()], ['doutor-hernia-serra', conta('doutor-hernia-serra')]]), armazem([]));
  await assert.rejects(() => infinitepayLinks(duas, {}), /diga a unidade/);
  const r = await infinitepayLinks(duas, { unidade: 'acailandia' });
  assert.equal(r.unidade, 'doutor-hernia-acailandia');
  await assert.rejects(() => infinitepayLinks(duas, { unidade: 'timbo' }), /sem InfinitePay/);
});

test('links: totais por status em reais, falhou e intencao não entram no valor criado, e diz que é só o recorte', async () => {
  const itens = [
    link({ orderNsu: 'a', status: 'pago', valorCentavos: 10000, valorPagoCentavos: 10150 }),
    link({ orderNsu: 'b', status: 'criado', valorCentavos: 5000 }),
    link({ orderNsu: 'c', status: 'falhou', valorCentavos: 99900, erro: 'recusado' }),
    link({ orderNsu: 'd', status: 'intencao', valorCentavos: 7000 }),
  ];
  const r = await infinitepayLinks(ctxCom(itens), {});
  assert.equal(r.resumo.links, 4);
  assert.equal(r.resumo.valorEmLinksCriados, 150);
  assert.equal(r.resumo.valorPago, 101.5);
  assert.deepEqual(r.resumo.porStatus.pago, { quantidade: 1, valor: 100 });
  assert.match(r.escopo, /SÓ os links criados por este conector/);
  assert.match(r.limitesDaApi, /não lista vendas/);
  assert.match(String(r.atencao), /intencao/);
});

test('links: período em dia de Brasília, status inválido recusa, maxItens corta e conta o omitido', async () => {
  const arm = armazem([link({ orderNsu: 'a' }), link({ orderNsu: 'b' }), link({ orderNsu: 'c' })]);
  const ctx = criarContextoInfinitepay(new Map([[conta().slug, conta()]]), arm);
  const r = await infinitepayLinks(ctx, { inicio: '2026-11-01', fim: '2026-11-30', maxItens: 1 });
  assert.equal(r.itens.length, 1);
  assert.equal(r.itensOmitidos, 2);
  const f = arm.filtros[0] as { de: Date; ate: Date };
  assert.equal(f.de.toISOString(), '2026-11-01T03:00:00.000Z');
  assert.equal(f.ate.toISOString(), '2026-12-01T02:59:59.999Z');
  await assert.rejects(() => infinitepayLinks(ctx, { status: 'inventado' }), /status desconhecido/);
  await assert.rejects(() => infinitepayLinks(ctx, { inicio: '2026-11-30', fim: '2026-11-01' }), /início vem depois/);
  await assert.rejects(() => infinitepayLinks(ctx, { inicio: '30/11/2026' }), /data inválida/);
});

test('contas: lista a unidade com o final da chave; testar=true prova a chave e mostra a recusa sem a chave', async () => {
  const boa = await infinitepayContas(ctxCom(), { testar: true });
  assert.equal(boa.contas[0]!.chaveAtiva?.ok, true);
  const ruim: ContaInfinitepay = { ...conta(), fonte: { ...conta().fonte, testar: async () => { throw new Error('a InfinitePay recusou a chave (403)'); } } };
  const r = await infinitepayContas(ctxCom([], ruim), { testar: true });
  assert.equal(r.contas[0]!.chaveAtiva?.ok, false);
  const sem = await infinitepayContas(ctxCom(), {});
  assert.equal('chaveAtiva' in sem.contas[0]!, false, 'sem testar não chama a InfinitePay');
  assert.match(sem.limitesDaApi, /saldo, extrato nem recebíveis/);
});

test('a conta construída do ambiente não mostra a chave nem serializada, só o final; consulta com a chave no cabeçalho', async () => {
  const vistas: Array<{ init: RequestInit }> = [];
  const f = (async (_u: string, init: RequestInit) => (vistas.push({ init }), new Response(JSON.stringify({ success: true, paid: true, amount: 100, paid_amount: 100, installments: 1, capture_method: 'pix' })))) as unknown as typeof fetch;
  const c = contaInfinitepayDaConfig({ slug: 'doutor-hernia-acailandia', nome: 'Açailândia', chave: CHAVE, handle: 'tag' }, { fetcher: f });
  assert.equal(JSON.stringify(c).includes('FIXTURE'), false);
  assert.equal(c.chaveFinal, '…rstu');
  assert.equal(c.temHandle, true);
  const r = await c.fonte.consultar({ orderNsu: 'o', transactionNsu: 't', slug: 's' });
  assert.equal(r.pago, true);
  assert.equal((vistas[0]!.init.headers as Record<string, string>)['X-Api-Key'], CHAVE);
  assert.equal(JSON.parse(String(vistas[0]!.init.body)).handle, 'tag');
});

test('nenhuma resposta das ferramentas carrega a chave', async () => {
  const c = contaInfinitepayDaConfig({ slug: 'doutor-hernia-acailandia', nome: 'A', chave: CHAVE }, { fetcher: (async () => new Response(JSON.stringify({ success: false, message: `Forbidden ${CHAVE}` }), { status: 403 })) as unknown as typeof fetch });
  const ctx = ctxCom([link()], c);
  const saidas: string[] = [JSON.stringify(await infinitepayLinks(ctx, {})), JSON.stringify(await infinitepayContas(ctx, { testar: true }))];
  await infinitepayStatusPagamento(ctx, { orderNsu: 'o', transactionNsu: 't', slug: 's' }).catch((e: Error) => saidas.push(e.message));
  for (const s of saidas) assert.equal(s.includes('inchk_FIXTURE'), false);
  assert.equal(saidas.length, 3);
});

test('registra as 3 ferramentas, todas só de leitura', () => {
  const nomes: Array<{ nome: string; ro: unknown }> = [];
  const falso = { registerTool: (nome: string, cfg: { annotations?: { readOnlyHint?: boolean } }) => nomes.push({ nome, ro: cfg.annotations?.readOnlyHint }) };
  registrarFerramentasInfinitepay(falso as never, ctxCom());
  assert.deepEqual(nomes, [
    { nome: 'infinitepay_contas', ro: true },
    { nome: 'infinitepay_status_pagamento', ro: true },
    { nome: 'infinitepay_links', ro: true },
  ]);
});

test('listar_integracoes mostra a InfinitePay e as ferramentas; quem não tem continua igual', () => {
  const r = listarIntegracoes({ franquia: new Map(), kommo: new Map(), bling: new Map(), infinitepay: new Map([['doutor-hernia-acailandia', { nome: 'Açailândia' }]]) });
  assert.equal(r.comInfinitepay, 1);
  assert.equal(r.unidades[0]!.infinitepay, true);
  assert.match(r.unidades[0]!.ferramentas.join(' | '), /infinitepay_\*.*NÃO lista vendas/);
  const antes = listarIntegracoes({ franquia: new Map([['serra', { nome: 'Serra' }]]), kommo: new Map(), bling: new Map() });
  assert.equal(antes.comInfinitepay, 0);
  assert.equal(antes.unidades[0]!.infinitepay, false);
});

test('armazém do Prisma: lê por unidade e período, na ordem do banco, e devolve datas em ISO', async () => {
  const linha: LinhaDoLink = {
    unitSlug: 'u', orderNsu: 'o1', status: 'pago', url: 'https://x', valorCentavos: 100, descricao: 'd', validoAte: null, criadoPor: 'u1', createdAt: new Date('2026-11-26T12:00:00Z'),
    invoiceSlug: 'sl', transactionNsu: 'tn', formaPagamento: 'pix', parcelas: 1, valorPagoCentavos: 100, reciboUrl: null, pagoEm: new Date('2026-11-26T12:05:00Z'), liquidadoEm: null, ultimoEvento: 'paid', erro: null,
  };
  const pedidos: unknown[] = [];
  const db = {
    infinitepayLink: {
      findMany: async (a: unknown) => (pedidos.push(a), [linha]),
      findUnique: async (a: { where: { unitSlug_orderNsu: { orderNsu: string } } }) => (a.where.unitSlug_orderNsu.orderNsu === 'o1' ? linha : null),
    },
  };
  const arm = armazemDeLinksPrisma(db);
  const lista = await arm.listar({ unidade: 'u', de: new Date('2026-11-01T03:00:00Z'), status: 'pago', limite: 10 });
  assert.equal(lista[0]!.pagoEm, '2026-11-26T12:05:00.000Z');
  assert.deepEqual(pedidos[0], { where: { unitSlug: 'u', status: 'pago', createdAt: { gte: new Date('2026-11-01T03:00:00Z') } }, orderBy: { createdAt: 'desc' }, take: 10 });
  assert.equal((await arm.porOrderNsu('u', 'o1'))?.transactionNsu, 'tn');
  assert.equal(await arm.porOrderNsu('u', 'nao'), null);
});
