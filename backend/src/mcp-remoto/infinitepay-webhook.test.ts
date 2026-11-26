import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { criarContextoInfinitepay, infinitepayLinks, type ContaInfinitepay } from './infinitepay.js';
import { armazemEmMemoria } from './infinitepay-falso.js';
import { assinaturaDoAviso, eventoDoCorpo, montarRotaDoWebhookInfinitepay, processarAviso, urlDoAviso, type DepsDoAviso } from './infinitepay-webhook.js';
import { mascararUrlDoLog } from '../lib/mascara-url-log.js';

const UNI = 'doutor-hernia-acailandia';
const SEGREDO = 'segredo-de-teste';
const REF = 'dd-20261126-aaaaaaaaaa';

function montar(op: { consultar?: ContaInfinitepay['fonte']['consultar']; status?: string } = {}) {
  const avisos: string[] = [];
  const consultas: unknown[] = [];
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: {
      consultar: async (p) => {
        consultas.push(p);
        return op.consultar ? op.consultar(p) : { sucesso: true, pago: true, valorCentavos: 15000, valorPagoCentavos: 15150, parcelas: 3, forma: 'credit_card' };
      },
      testar: async () => undefined,
    },
  };
  const armazem = armazemEmMemoria([{ orderNsu: REF, unidade: UNI, valorCentavos: 15000, status: op.status ?? 'criado' }]);
  const deps: DepsDoAviso = { ctx: criarContextoInfinitepay(new Map([[UNI, conta]]), armazem), armazem, segredo: SEGREDO, alertar: async (t) => (avisos.push(t), true) };
  const p = { unidade: UNI, orderNsu: REF, assinatura: assinaturaDoAviso(SEGREDO, UNI, REF) };
  return { deps, armazem, avisos, consultas, p };
}

const PAGO = { invoice_slug: 'fat-1', amount: 15000, paid_amount: 15150, installments: 3, capture_method: 'credit_card', transaction_nsu: 'tx-uuid-1', order_nsu: REF, receipt_url: 'https://comprovante.exemplo.com/1' };

test('assinatura: endereço de um link não serve a outro, nem a outra unidade; errada = 404 sem tocar em nada', async () => {
  const m = montar();
  assert.notEqual(assinaturaDoAviso(SEGREDO, UNI, REF), assinaturaDoAviso(SEGREDO, UNI, 'outro'));
  assert.notEqual(assinaturaDoAviso(SEGREDO, UNI, REF), assinaturaDoAviso(SEGREDO, 'outra-unidade', REF));
  assert.notEqual(assinaturaDoAviso(SEGREDO, UNI, REF), assinaturaDoAviso('outro-segredo', UNI, REF));
  const r = await processarAviso(m.deps, { ...m.p, assinatura: 'x'.repeat(32) }, PAGO);
  assert.deepEqual(r, { http: 404, resultado: 'assinatura' });
  assert.equal(m.consultas.length, 0, 'sem assinatura nem chama a InfinitePay');
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
  const curta = await processarAviso(m.deps, { ...m.p, assinatura: 'abc' }, PAGO);
  assert.equal(curta.http, 404);
});

test('pago: confirma no /payment_check com os três códigos, confere o valor e SÓ ENTÃO marca pago', async () => {
  const m = montar();
  const r = await processarAviso(m.deps, m.p, PAGO);
  assert.deepEqual(r, { http: 200, resultado: 'pago' });
  assert.deepEqual(m.consultas, [{ orderNsu: REF, transactionNsu: 'tx-uuid-1', slug: 'fat-1' }]);
  const l = m.armazem.linhas[0]!;
  assert.equal(l.status, 'pago');
  assert.equal(l.invoiceSlug, 'fat-1');
  assert.equal(l.transactionNsu, 'tx-uuid-1');
  assert.equal(l.formaPagamento, 'credit_card');
  assert.equal(l.parcelas, 3);
  assert.equal(l.valorPagoCentavos, 15150, 'o valor pago vem da confirmação, não do corpo');
  assert.equal(l.reciboUrl, 'https://comprovante.exemplo.com/1');
  assert.equal(m.avisos.length, 0);
});

test('o corpo mentindo não paga nada: a InfinitePay ainda não confirma → continua "criado", responde 503 (ela tenta de novo) e avisa o João UMA vez', async () => {
  const m = montar({ consultar: async () => ({ sucesso: true, pago: false }) });
  const r = await processarAviso(m.deps, m.p, { ...PAGO, paid_amount: 15000 });
  assert.equal(r.resultado, 'não confirmado');
  assert.equal(r.http, 503, 'a confirmação pode só estar atrasada: a InfinitePay precisa tentar de novo');
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
  assert.equal(m.armazem.linhas[0]!.ultimoEvento, 'paid:nao_confirmado');
  assert.match(m.avisos[0]!, /ainda NÃO confirma/);
  // a tentativa seguinte NÃO avisa de novo (sem enxurrada no Telegram)
  const m2 = montar({ consultar: async () => ({ sucesso: true, pago: false }) });
  m2.armazem.linhas[0]!.ultimoEvento = 'paid:nao_confirmado';
  await processarAviso(m2.deps, m2.p, PAGO);
  assert.equal(m2.avisos.length, 0);
});

test('a confirmação chega na segunda tentativa: o aviso repetido marca pago', async () => {
  let pago = false;
  const m = montar({ consultar: async () => (pago ? { sucesso: true, pago: true, valorCentavos: 15000 } : { sucesso: true, pago: false }) });
  assert.equal((await processarAviso(m.deps, m.p, PAGO)).http, 503);
  pago = true;
  assert.deepEqual(await processarAviso(m.deps, m.p, PAGO), { http: 200, resultado: 'pago' });
  assert.equal(m.armazem.linhas[0]!.status, 'pago');
});

test('a confirmação SEM o valor não vale: não marca pago e avisa (a conferência do valor não falha aberta)', async () => {
  const m = montar({ consultar: async () => ({ sucesso: true, pago: true }) });
  const r = await processarAviso(m.deps, m.p, PAGO);
  assert.equal(r.resultado, 'valor diferente');
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
  assert.match(m.avisos[0]!, /SEM o valor/);
});

test('valor confirmado diferente do link: não marca pago e avisa', async () => {
  const m = montar({ consultar: async () => ({ sucesso: true, pago: true, valorCentavos: 100 }) });
  const r = await processarAviso(m.deps, m.p, PAGO);
  assert.equal(r.resultado, 'valor diferente');
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
  assert.match(m.avisos[0]!, /R\$ 1,00 num link de R\$ 150,00/);
});

test('/payment_check fora do ar: responde 503 (a InfinitePay tenta de novo) e não marca nada', async () => {
  const m = montar({ consultar: async () => { throw new Error('a InfinitePay respondeu 502'); } });
  const r = await processarAviso(m.deps, m.p, PAGO);
  assert.equal(r.http, 503);
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
});

test('o mesmo aviso entregue duas vezes: marca uma vez só (idempotente)', async () => {
  const m = montar();
  assert.equal((await processarAviso(m.deps, m.p, PAGO)).resultado, 'pago');
  assert.equal((await processarAviso(m.deps, m.p, PAGO)).resultado, 'já estava pago');
  assert.equal(m.armazem.linhas[0]!.status, 'pago');
});

test('aviso sem invoice_slug/transaction_nsu não dá para confirmar: registra, avisa e não paga', async () => {
  const m = montar();
  const r = await processarAviso(m.deps, m.p, { order_nsu: REF, amount: 15000 });
  assert.equal(r.resultado, 'sem códigos para confirmar');
  assert.equal(m.consultas.length, 0);
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
  assert.match(m.avisos[0]!, /sem invoice_slug/);
});

test('order_nsu do corpo diferente do endereço: recusa; link desconhecido ou que falhou: 404', async () => {
  const m = montar();
  assert.equal((await processarAviso(m.deps, m.p, { ...PAGO, order_nsu: 'outro' })).http, 404);
  const falhou = montar({ status: 'falhou' });
  assert.equal((await processarAviso(falhou.deps, falhou.p, PAGO)).http, 404);
  const desconhecido = { unidade: UNI, orderNsu: 'nao-existe', assinatura: assinaturaDoAviso(SEGREDO, UNI, 'nao-existe') };
  assert.equal((await processarAviso(m.deps, desconhecido, PAGO)).http, 404);
  const outraUnidade = { unidade: 'timbo', orderNsu: REF, assinatura: assinaturaDoAviso(SEGREDO, 'timbo', REF) };
  // unidade que NÃO está carregada mas com assinatura nossa: 503 (a InfinitePay repete), nunca 404
  assert.equal((await processarAviso(m.deps, outraUnidade, PAGO)).http, 503);
});

test('settled: liquida o que já está pago; sem paid antes, confirma e marca pago também', async () => {
  const a = montar();
  await processarAviso(a.deps, a.p, PAGO);
  assert.equal((await processarAviso(a.deps, a.p, { ...PAGO, event: 'settled' })).resultado, 'liquidado');
  assert.ok(a.armazem.linhas[0]!.liquidadoEm);
  const b = montar();
  const r = await processarAviso(b.deps, b.p, { ...PAGO, event: 'settled' });
  assert.equal(r.resultado, 'pago');
  assert.equal(b.armazem.linhas[0]!.status, 'pago');
  assert.ok(b.armazem.linhas[0]!.liquidadoEm);
});

test('refunded sobre um link PAGO não sobrescreve `pago`: marca para revisão ("não confirmado pela API") e SEMPRE avisa o João', async () => {
  const pago = montar({ status: 'pago' });
  const r = await processarAviso(pago.deps, pago.p, { order_nsu: REF, event: 'refunded' });
  assert.equal(r.resultado, 'estorno marcado para revisão');
  const l = pago.armazem.linhas[0]!;
  assert.equal(l.status, 'pago', 'o estorno avisado NUNCA desfaz um pagamento confirmado');
  assert.match(l.revisao ?? '', /NÃO confirmado pela API/);
  assert.equal(l.ultimoEvento, 'refunded');
  assert.match(pago.avisos[0]!, /ESTORNO.*NÃO confirmado pela API.*não mudei o status \(pago\)/);
  // a repetição do aviso não muda nada além da marca
  await processarAviso(pago.deps, pago.p, { order_nsu: REF, event: 'refunded' });
  assert.equal(pago.armazem.linhas[0]!.status, 'pago');
});

test('refunded sobre link ainda não pago também só marca (estorno não muda status algum)', async () => {
  const m = montar({ status: 'criado' });
  await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'refunded' });
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
  assert.ok(m.armazem.linhas[0]!.revisao);
});

test('canceled: antes do pagamento vale como cancelado (e marcado como não confirmado); sobre um `pago` só marca para revisão e avisa', async () => {
  const cancelado = montar({ status: 'criado' });
  assert.equal((await processarAviso(cancelado.deps, cancelado.p, { order_nsu: REF, event: 'canceled' })).resultado, 'cancelado');
  assert.equal(cancelado.armazem.linhas[0]!.status, 'cancelado');
  assert.equal(cancelado.armazem.linhas[0]!.revisao, null, 'link que nunca foi pago não precisa de revisão de dinheiro');
  assert.match(cancelado.avisos[0]!, /NÃO confirmado pela API.*Marquei como cancelado/);
  // o status vindo de aviso diz que não é confirmado
  const lista = await infinitepayLinks(cancelado.deps.ctx, {});
  assert.match(String(lista.itens[0]!.avisoDoStatus), /não confirmado pela API/);
  const jaPago = montar({ status: 'pago' });
  const r = await processarAviso(jaPago.deps, jaPago.p, { order_nsu: REF, event: 'canceled' });
  assert.equal(r.resultado, 'cancelamento marcado para revisão');
  assert.equal(jaPago.armazem.linhas[0]!.status, 'pago', 'cancelamento não desfaz pagamento');
  assert.match(jaPago.armazem.linhas[0]!.revisao ?? '', /cancelamento avisado/);
  assert.match(jaPago.avisos[0]!, /NÃO sobrescrevi o status \(pago\)/);
});

test('o estorno avisado aparece em infinitepay_links como NÃO confirmado pela API, e o link segue pago', async () => {
  const m = montar({ status: 'pago' });
  await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'refunded' });
  const r = await infinitepayLinks(m.deps.ctx, {});
  assert.equal(r.resumo.emRevisao, 1);
  assert.equal(r.itens[0]!.status, 'pago');
  assert.equal(r.itens[0]!.confirmadoPelaApi, false);
  assert.match(String(r.itens[0]!.revisao), /NÃO confirmado pela API/);
  assert.match(String(r.revisaoPendente), /NÃO confirmados? pela API/);
});

test('unidade que não está carregada (carga inicial, banco fora, chave renomeada): 503 para a InfinitePay repetir e UM alerta por 15 min', async () => {
  let agora = Date.parse('2026-11-26T15:00:00Z');
  const m = montar();
  const deps: DepsDoAviso = { ...m.deps, ctx: criarContextoInfinitepay(new Map(), m.armazem), agora: () => agora };
  const r1 = await processarAviso(deps, m.p, PAGO);
  assert.equal(r1.http, 503, 'nunca 404: com 404 a InfinitePay desiste e o pagamento fica criado para sempre');
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /não tem essa unidade carregada/);
  assert.match(m.avisos[0]!, /dd-20261126-aaaaaaaaaa/);
  // a InfinitePay repete: continua 503 e NÃO repete o alerta dentro da janela
  assert.equal((await processarAviso(deps, m.p, PAGO)).http, 503);
  assert.equal((await processarAviso(deps, m.p, PAGO)).http, 503);
  assert.equal(m.avisos.length, 1);
  agora += 16 * 60_000;
  await processarAviso(deps, m.p, PAGO);
  assert.equal(m.avisos.length, 2, 'passada a janela, avisa de novo');
  assert.equal(m.armazem.linhas[0]!.status, 'criado', 'nada foi marcado');
});

test('unidade ausente com assinatura ERRADA continua 404 e sem alerta (não é aviso nosso)', async () => {
  const m = montar();
  const deps: DepsDoAviso = { ...m.deps, ctx: criarContextoInfinitepay(new Map(), m.armazem) };
  const r = await processarAviso(deps, { ...m.p, assinatura: 'x'.repeat(32) }, PAGO);
  assert.equal(r.http, 404);
  assert.equal(m.avisos.length, 0);
});

test('unidade ausente pela rota: 503 de verdade na resposta HTTP', async () => {
  const m = montar();
  const deps: DepsDoAviso = { ...m.deps, ctx: criarContextoInfinitepay(new Map(), m.armazem) };
  await comServidor(deps, async (base) => {
    const r = await fetch(`${base}/infinitepay/webhook/${UNI}/${REF}/${m.p.assinatura}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(PAGO) });
    assert.equal(r.status, 503);
  });
});

test('payment_failed e created só ficam registrados; evento que não se conhece também, mas AVISA o João', async () => {
  const m = montar();
  for (const evento of ['payment_failed', 'created']) {
    const r = await processarAviso(m.deps, m.p, { order_nsu: REF, event: evento });
    assert.equal(r.resultado, `registrado:${evento}`);
  }
  assert.equal(m.avisos.length, 0);
  const r = await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'novidade' });
  assert.equal(r.resultado, 'registrado:desconhecido:novidade');
  assert.match(m.avisos[0]!, /evento que o conector não conhece \(novidade\)/);
  assert.equal(m.armazem.linhas[0]!.status, 'criado');
  assert.equal(m.consultas.length, 0);
});

test('o nome do evento é lido pelo sentido: payment.paid, INVOICE.REFUNDED e order.canceled valem como paid, refunded e canceled', () => {
  assert.equal(eventoDoCorpo({ event: 'payment.paid' }), 'paid');
  assert.equal(eventoDoCorpo({ type: 'INVOICE.REFUNDED' }), 'refunded');
  assert.equal(eventoDoCorpo({ event_type: 'order.canceled' }), 'canceled');
  assert.equal(eventoDoCorpo({ event: 'payment.settled' }), 'settled');
  assert.equal(eventoDoCorpo({ event: 'payment_failed' }), 'payment_failed');
  assert.equal(eventoDoCorpo({ event: 'invoice.created' }), 'created');
  assert.equal(eventoDoCorpo({}), undefined, 'sem evento no corpo é o corpo do paid da documentação');
  assert.equal(eventoDoCorpo({ event: 'algo estranho!' }), 'desconhecido:algoestranho');
});

test('estorno que FALHOU ou está pendente não é estorno: não muda o link e avisa o João; `type` genérico (forma de pagamento) não é evento', async () => {
  for (const nome of ['refund_failed', 'refund.pending', 'cancellation_rejected', 'partial_refund']) {
    const m = montar({ status: 'pago' });
    const r = await processarAviso(m.deps, m.p, { order_nsu: REF, event: nome });
    assert.match(r.resultado, /^registrado:desconhecido:/, nome);
    assert.equal(m.armazem.linhas[0]!.status, 'pago', `${nome} não pode estornar o link`);
    assert.equal(m.avisos.length, 1, nome);
  }
  assert.equal(eventoDoCorpo({ type: 'pix' }), undefined);
  assert.equal(eventoDoCorpo({ event_type: 'credit_card' }), undefined);
  assert.equal(eventoDoCorpo({ type: 'payment.paid' }), 'paid');
  const m = montar();
  const r = await processarAviso(m.deps, m.p, { ...PAGO, type: 'pix' });
  assert.equal(r.resultado, 'pago', 'o corpo do pago com type=pix continua sendo o pagamento');
});

test('pagamento confirmado pela API depois de um cancelamento NÃO confirmado: o link vira pago e o João é avisado', async () => {
  const m = montar({ status: 'cancelado' });
  const r = await processarAviso(m.deps, m.p, PAGO);
  assert.equal(r.resultado, 'pago');
  assert.equal(m.armazem.linhas[0]!.status, 'pago');
  assert.equal(m.armazem.linhas[0]!.valorPagoCentavos, 15150);
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /CONFIRMOU o pagamento.*depois de um cancelamento avisado e NÃO confirmado.*Marquei o link como pago/);
  assert.match(m.armazem.linhas[0]!.revisao ?? '', /depois de cancelamento/);
});

test('o mesmo cancelamento reentregue avisa UMA vez só (link nunca pago e link pago)', async () => {
  const m = montar({ status: 'criado' });
  for (let i = 0; i < 3; i++) await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'canceled' });
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /Marquei como cancelado/);
  assert.equal(m.armazem.linhas[0]!.status, 'cancelado');
  const pago = montar({ status: 'pago' });
  for (let i = 0; i < 3; i++) await processarAviso(pago.deps, pago.p, { order_nsu: REF, event: 'canceled' });
  assert.equal(pago.avisos.length, 1);
  assert.equal(pago.armazem.linhas[0]!.status, 'pago');
  const estorno = montar({ status: 'pago' });
  for (let i = 0; i < 3; i++) await processarAviso(estorno.deps, estorno.p, { order_nsu: REF, event: 'refunded' });
  assert.equal(estorno.avisos.length, 1, 'o estorno reentregue também');
});

test('as marcas de revisão ACUMULAM: estorno e depois cancelamento no mesmo pago ficam os dois, e o estorno segue descontado do valorPago', async () => {
  const m = montar({ status: 'pago' });
  await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'refunded' });
  await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'canceled' });
  const rev = m.armazem.linhas[0]!.revisao ?? '';
  assert.match(rev, /estorno avisado/);
  assert.match(rev, /cancelamento avisado/);
  assert.equal(m.armazem.linhas[0]!.status, 'pago');
  const r = await infinitepayLinks(m.deps.ctx, {});
  assert.equal(r.resumo.valorPago, 0, 'o cancelamento NÃO devolve o estorno ao pago');
  assert.equal(r.resumo.valorEstornado, 150);
  assert.equal(r.resumo.valorEstornadoNaoConfirmado, 150);
  assert.equal(r.resumo.porStatus.pago?.valor, r.resumo.valorPago, 'porStatus.pago bate com valorPago');
  // a ordem inversa (cancelamento, depois estorno) dá o mesmo
  const n = montar({ status: 'pago' });
  await processarAviso(n.deps, n.p, { order_nsu: REF, event: 'canceled' });
  await processarAviso(n.deps, n.p, { order_nsu: REF, event: 'refunded' });
  assert.match(n.armazem.linhas[0]!.revisao ?? '', /cancelamento avisado.*estorno avisado/);
  assert.equal((await infinitepayLinks(n.deps.ctx, {})).resumo.valorPago, 0);
});

test('pagamento confirmado depois de um cancelamento avisado: vira pago, avisa E fica com marca de revisão', async () => {
  const m = montar({ status: 'cancelado' });
  await processarAviso(m.deps, m.p, PAGO);
  const l = m.armazem.linhas[0]!;
  assert.equal(l.status, 'pago');
  assert.match(l.revisao ?? '', /pagamento confirmado depois de cancelamento avisado/);
  const r = await infinitepayLinks(m.deps.ctx, {});
  assert.equal(r.resumo.emRevisao, 1);
  assert.equal(r.resumo.valorPago, 151.5, 'a marca de pagamento-depois-de-cancelamento não desconta o dinheiro');
  // reentregue: nada de novo
  await processarAviso(m.deps, m.p, PAGO);
  assert.equal(m.avisos.length, 1);
});

test('valorPago não soma o link com estorno em revisão; valorEstornado reflete a revisão (separada em valorEstornadoNaoConfirmado)', async () => {
  const m = montar({ status: 'pago' });
  m.armazem.linhas.push({ ...m.armazem.linhas[0]!, orderNsu: 'outro', valorCentavos: 5000, valorPagoCentavos: 5000, revisao: null });
  await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'refunded' });
  const r = await infinitepayLinks(m.deps.ctx, {});
  assert.equal(r.resumo.valorPago, 50, 'só o link sem estorno em revisão');
  assert.equal(r.resumo.valorEstornado, 150);
  assert.equal(r.resumo.valorEstornadoNaoConfirmado, 150);
  assert.equal(r.resumo.emRevisao, 1);
  // cancelamento em revisão num pago NÃO tira dinheiro do pago
  const c = montar({ status: 'pago' });
  await processarAviso(c.deps, c.p, { order_nsu: REF, event: 'canceled' });
  const rc = await infinitepayLinks(c.deps.ctx, {});
  assert.equal(rc.resumo.valorPago, 150);
  assert.equal(rc.resumo.valorEstornadoNaoConfirmado, 0);
});

test('pagamento confirmado com o link já ESTORNADO (legado): não muda o status e avisa o João', async () => {
  for (const status of ['estornado']) {
    const m = montar({ status });
    const r = await processarAviso(m.deps, m.p, PAGO);
    assert.equal(r.resultado, `pagamento confirmado com o link em ${status}`);
    assert.equal(m.armazem.linhas[0]!.status, status);
    assert.match(m.avisos[0]!, /CONFIRMOU o pagamento/);
  }
  const jaPago = montar({ status: 'pago' });
  assert.equal((await processarAviso(jaPago.deps, jaPago.p, PAGO)).resultado, 'já estava pago');
  assert.equal(jaPago.avisos.length, 0);
});

test('estorno com o evento em outra grafia também marca para revisão e avisa', async () => {
  const m = montar({ status: 'pago' });
  const r = await processarAviso(m.deps, m.p, { order_nsu: REF, event: 'invoice.REFUNDED' });
  assert.equal(r.resultado, 'estorno marcado para revisão');
  assert.equal(m.armazem.linhas[0]!.status, 'pago');
  assert.match(m.avisos[0]!, /ESTORNO/);
});

test('o endereço do aviso leva a assinatura e o log de debug a esconde', () => {
  const u = urlDoAviso('https://conector.exemplo.com/', SEGREDO, UNI, REF);
  assert.equal(u, `https://conector.exemplo.com/infinitepay/webhook/${UNI}/${REF}/${assinaturaDoAviso(SEGREDO, UNI, REF)}`);
  const caminho = new URL(u).pathname;
  assert.equal(mascararUrlDoLog(caminho), `/infinitepay/webhook/${UNI}/${REF}/[assinatura]`);
});

// ----------------------------------------------------------------- a rota de verdade

async function comServidor<T>(deps: DepsDoAviso, fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  montarRotaDoWebhookInfinitepay(app, deps);
  const srv: Server = createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

test('rota: POST com assinatura certa marca pago (200); errada dá 404; depois de 30 erros do mesmo IP, 429', async () => {
  const m = montar();
  await comServidor(m.deps, async (base) => {
    const boa = await fetch(`${base}/infinitepay/webhook/${UNI}/${REF}/${m.p.assinatura}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(PAGO) });
    assert.equal(boa.status, 200);
    assert.deepEqual(await boa.json(), { ok: true });
    assert.equal(m.armazem.linhas[0]!.status, 'pago');
    for (let i = 0; i < 30; i++) {
      const ruim = await fetch(`${base}/infinitepay/webhook/${UNI}/${REF}/${'0'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(ruim.status, 404);
    }
    const barrado = await fetch(`${base}/infinitepay/webhook/${UNI}/${REF}/${'0'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(barrado.status, 429);
    assert.equal(barrado.headers.get('retry-after'), '600');
  });
});

test('rota: GET não existe (só POST) e a confirmação indisponível vira 503', async () => {
  const m = montar({ consultar: async () => { throw new Error('fora do ar'); } });
  await comServidor(m.deps, async (base) => {
    const get = await fetch(`${base}/infinitepay/webhook/${UNI}/${REF}/${m.p.assinatura}`);
    assert.equal(get.status, 404);
    const post = await fetch(`${base}/infinitepay/webhook/${UNI}/${REF}/${m.p.assinatura}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(PAGO) });
    assert.equal(post.status, 503);
  });
});
