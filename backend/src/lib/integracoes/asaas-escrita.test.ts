import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asaasPost, limparTexto } from './asaas-escrita.js';

const CHAVE = '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjAwMDAwXXYZ';

function falso(respostas: Array<{ status: number; corpo?: unknown } | Error>) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    const r = respostas[Math.min(i++, respostas.length - 1)]!;
    if (r instanceof Error) throw r;
    return new Response(r.corpo === undefined ? '' : JSON.stringify(r.corpo), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetcher, chamadas };
}

test('asaasPost: só escreve em /customers e /payments — cancelar, estornar, transferir e afins nem saem da máquina', async () => {
  const { fetcher, chamadas } = falso([{ status: 200, corpo: { id: 'x' } }]);
  for (const caminho of ['/payments/pay_1/refund', '/payments/pay_1', '/transfers', '/pix/qrCodes/pay', '/anticipations', '/customers/cus_1', '/finance/balance', '/customers/', '//payments', '/payments?x=1']) {
    await assert.rejects(() => asaasPost('c1', CHAVE, caminho, {}, fetcher), /escrita recusada/, caminho);
  }
  assert.equal(chamadas.length, 0);
  await asaasPost('c1', CHAVE, '/customers', { name: 'A' }, fetcher);
  await asaasPost('c1', CHAVE, '/payments', { value: 1 }, fetcher);
  assert.equal(chamadas.length, 2);
  assert.equal(chamadas[0]!.init.method, 'POST');
  assert.match(chamadas[0]!.url, /\/customers$/);
  assert.equal((chamadas[0]!.init.headers as Record<string, string>).access_token, CHAVE);
});

test('asaasPost: 403 vira mensagem clara de chave só de leitura, sem a chave nem o corpo do Asaas', async () => {
  const { fetcher } = falso([{ status: 403, corpo: { errors: [{ description: `chave ${CHAVE} sem permissão, cpf 52998224725` }] } }]);
  const erro = await asaasPost('c1', CHAVE, '/payments', {}, fetcher).then(() => null, (e: Error & { status?: number }) => e);
  assert.ok(erro);
  assert.equal(erro.status, 403);
  assert.match(erro.message, /só de leitura/);
  assert.ok(!erro.message.includes('aact') && !erro.message.includes('52998224725'));
});

test('asaasPost: erro 400 do Asaas sai limpo (chave, CPF e e-mail trocados por marcadores)', async () => {
  const { fetcher } = falso([{ status: 400, corpo: { errors: [{ description: `CPF 529.982.247-25 de maria@exemplo.com, chave ${CHAVE}` }] } }]);
  const erro = await asaasPost('c1', CHAVE, '/customers', {}, fetcher).then(() => null, (e: Error) => e);
  assert.ok(erro);
  for (const p of ['529.982.247-25', 'maria@exemplo.com', CHAVE, 'aact_prod']) assert.ok(!erro.message.includes(p), p);
  assert.match(erro.message, /\[documento\]/);
});

test('asaasPost: 5xx e queda de rede NÃO repetem (pode ter criado); 401 diz que a chave não vale', async () => {
  const a = falso([{ status: 500, corpo: {} }, { status: 200, corpo: { id: 'x' } }]);
  await assert.rejects(() => asaasPost('c1', CHAVE, '/payments', {}, a.fetcher), /Asaas 500/);
  assert.equal(a.chamadas.length, 1);
  const b = falso([new Error(`ECONNRESET ${CHAVE}`), { status: 200, corpo: { id: 'x' } }]);
  const erro = await asaasPost('c1', CHAVE, '/payments', {}, b.fetcher).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.ok(erro);
  assert.equal(erro.status, null);
  assert.match(erro.message, /pode ter acontecido/);
  assert.ok(!erro.message.includes('aact'));
  assert.equal(b.chamadas.length, 1);
  const c = falso([{ status: 401, corpo: {} }]);
  await assert.rejects(() => asaasPost('c1', CHAVE, '/payments', {}, c.fetcher), /recusou a chave \(401\)/);
});

test('limparTexto: tira chave, CPF/CNPJ e e-mail, mas deixa ids do Asaas (cus_/pay_) em paz', () => {
  assert.equal(limparTexto(`x ${CHAVE} y`), 'x [chave] y');
  assert.equal(limparTexto('cpf 52998224725 e 529.982.247-25 e cnpj 11222333000181 e 11.222.333/0001-81'), 'cpf [documento] e [documento] e cnpj [documento] e [documento]');
  assert.equal(limparTexto('cliente cus_000005401844 cobrança pay_12345678901 criada'), 'cliente cus_000005401844 cobrança pay_12345678901 criada');
  assert.equal(limparTexto('mande para maria.silva@exemplo.com já'), 'mande para [e-mail] já');
  assert.equal(limparTexto('a chave inteira', 'chave inteira'), 'a [chave]');
});
