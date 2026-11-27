/** O evento «link pago» (lib/link-pago.ts): quem escuta recebe uma vez, na ordem, e um ouvinte que quebra não derruba os outros nem quem avisa. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aoLinkPago, emitirLinkPago, type LinkPago } from './link-pago.js';

const EV: LinkPago = { unidade: 'doutor-hernia-acailandia', orderNsu: 'dd-1', valorCentavos: 5000, descricao: 'Sinal', pagoEm: new Date('2026-11-26T19:21:00Z') };

test('cada ouvinte recebe o evento, na ordem em que se registrou; quem para de escutar não recebe mais', async () => {
  const vistos: string[] = [];
  const para1 = aoLinkPago(async (e) => void vistos.push(`a:${e.orderNsu}`));
  const para2 = aoLinkPago((e) => void vistos.push(`b:${e.orderNsu}`));
  await emitirLinkPago(EV);
  para1();
  await emitirLinkPago({ ...EV, orderNsu: 'dd-2' });
  para2();
  await emitirLinkPago({ ...EV, orderNsu: 'dd-3' });
  assert.deepEqual(vistos, ['a:dd-1', 'b:dd-1', 'b:dd-2']);
});

test('ouvinte que lança (ou rejeita) não derruba os outros nem quem emite', async () => {
  const vistos: string[] = [];
  const p1 = aoLinkPago(() => { throw new Error('quebrou'); });
  const p2 = aoLinkPago(async () => { throw new Error('rejeitou'); });
  const p3 = aoLinkPago((e) => void vistos.push(e.orderNsu));
  await assert.doesNotReject(() => emitirLinkPago(EV));
  assert.deepEqual(vistos, ['dd-1']);
  p1(); p2(); p3();
});

test('o evento não carrega dado pessoal: só o que a InfinitePay confirmou do link', () => {
  const campos = Object.keys({ ...EV, invoiceSlug: 'x', transactionNsu: 'y', forma: 'pix', parcelas: 1, valorPagoCentavos: 5000 } satisfies LinkPago).sort();
  assert.deepEqual(campos, ['descricao', 'forma', 'invoiceSlug', 'orderNsu', 'pagoEm', 'parcelas', 'transactionNsu', 'unidade', 'valorCentavos', 'valorPagoCentavos']);
  for (const c of campos) assert.doesNotMatch(c, /nome|telefone|cpf|email|documento/i);
});
