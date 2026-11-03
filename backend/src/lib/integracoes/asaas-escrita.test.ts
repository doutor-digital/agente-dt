import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asaasEscrever, limparTexto, rotaPermitida } from './asaas-escrita.js';
import { asaasGet } from './asaas.js';

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

test('asaasEscrever: só as rotas da lista saem da máquina; o resto (item 6: banco da clínica, chaves, webhooks, usuários, antecipação, empréstimo, conta) é recusado', async () => {
  const { fetcher, chamadas } = falso([{ status: 200, corpo: { id: 'x' } }]);
  const proibidas: Array<['POST' | 'PUT' | 'DELETE', string]> = [
    ['POST', '/myAccount/bankAccount'], ['PUT', '/myAccount/commercialInfo'], ['POST', '/accessTokens'], ['DELETE', '/accessTokens/abc123'],
    ['POST', '/webhooks'], ['PUT', '/webhooks/abc123'], ['DELETE', '/webhooks/abc123'], ['POST', '/accounts'], ['POST', '/users'],
    ['POST', '/anticipations'], ['POST', '/payments/pay_1/anticipate'], ['POST', '/loans'], ['POST', '/bill'], ['POST', '/bill/simulate'],
    ['POST', '/subscriptions'], ['DELETE', '/customers/cus_1'], ['POST', '/payments/pay_1/remind'], ['POST', '/pix/qrCodes/pay'], ['POST', '/pix/addressKeys'],
    // método errado para uma rota da lista, caminho com lixo, query e barra dupla
    ['DELETE', '/transfers'], ['PUT', '/payments'], ['DELETE', '/payments/pay_1/refund'], ['PUT', '/transfers/tra_1'], ['POST', '/payments/pay_1'],
    ['POST', '/customers/'], ['POST', '//payments'], ['POST', '/payments?x=1'], ['DELETE', '/payments/pay_1/../../webhooks'], ['DELETE', '/payments/pay 1'],
  ];
  for (const [metodo, caminho] of proibidas) {
    await assert.rejects(() => asaasEscrever('c1', CHAVE, metodo, caminho, {}, fetcher), /escrita recusada/, `${metodo} ${caminho}`);
    assert.equal(rotaPermitida(metodo, caminho), false, `${metodo} ${caminho}`);
  }
  assert.equal(chamadas.length, 0, 'nada pode ter saído');
  const liberadas: Array<['POST' | 'PUT' | 'DELETE', string]> = [
    ['POST', '/customers'], ['PUT', '/customers/cus_000005401844'], ['POST', '/payments'], ['PUT', '/payments/pay_1234567890'],
    ['DELETE', '/payments/pay_1234567890'], ['POST', '/payments/pay_1234567890/refund'], ['POST', '/transfers'],
  ];
  for (const [metodo, caminho] of liberadas) await asaasEscrever('c1', CHAVE, metodo, caminho, metodo === 'DELETE' ? undefined : { x: 1 }, fetcher);
  assert.equal(chamadas.length, liberadas.length);
  assert.deepEqual(chamadas.map((c) => c.init.method), liberadas.map(([m]) => m));
  assert.match(chamadas[0]!.url, /\/customers$/);
  assert.equal((chamadas[0]!.init.headers as Record<string, string>).access_token, CHAVE);
  // DELETE vai sem corpo e sem Content-Type
  const del = chamadas[4]!;
  assert.equal(del.init.body, undefined);
  assert.equal((del.init.headers as Record<string, string>)['Content-Type'], undefined);
  assert.equal(chamadas[0]!.init.redirect, 'error');
});

test('asaasEscrever: 403 vira mensagem clara de chave só de leitura, sem a chave nem o corpo do Asaas', async () => {
  const { fetcher } = falso([{ status: 403, corpo: { errors: [{ description: `chave ${CHAVE} sem permissão, cpf 52998224725` }] } }]);
  const erro = await asaasEscrever('c1', CHAVE, 'POST', '/payments', {}, fetcher).then(() => null, (e: Error & { status?: number }) => e);
  assert.ok(erro);
  assert.equal(erro.status, 403);
  assert.match(erro.message, /só de leitura/);
  assert.ok(!erro.message.includes('aact') && !erro.message.includes('52998224725'));
});

test('asaasEscrever: erro 400 do Asaas sai limpo (chave, CPF e e-mail trocados por marcadores)', async () => {
  const { fetcher } = falso([{ status: 400, corpo: { errors: [{ description: `CPF 529.982.247-25 de maria@exemplo.com, chave ${CHAVE}` }] } }]);
  const erro = await asaasEscrever('c1', CHAVE, 'POST', '/customers', {}, fetcher).then(() => null, (e: Error) => e);
  assert.ok(erro);
  for (const p of ['529.982.247-25', 'maria@exemplo.com', CHAVE, 'aact_prod']) assert.ok(!erro.message.includes(p), p);
  assert.match(erro.message, /\[documento\]/);
});

test('asaasEscrever: 5xx e queda de rede NÃO repetem (pode ter criado); 401 diz que a chave não vale', async () => {
  const a = falso([{ status: 500, corpo: {} }, { status: 200, corpo: { id: 'x' } }]);
  await assert.rejects(() => asaasEscrever('c1', CHAVE, 'POST', '/payments', {}, a.fetcher), /Asaas 500/);
  assert.equal(a.chamadas.length, 1);
  const b = falso([new Error(`ECONNRESET ${CHAVE}`), { status: 200, corpo: { id: 'x' } }]);
  const erro = await asaasEscrever('c1', CHAVE, 'POST', '/payments', {}, b.fetcher).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.ok(erro);
  assert.equal(erro.status, null);
  assert.match(erro.message, /pode ter acontecido/);
  assert.ok(!erro.message.includes('aact'));
  assert.equal(b.chamadas.length, 1);
  const c = falso([{ status: 401, corpo: {} }]);
  await assert.rejects(() => asaasEscrever('c1', CHAVE, 'POST', '/payments', {}, c.fetcher), /recusou a chave \(401\)/);
});

test('limparTexto: tira chave, CPF/CNPJ e e-mail, mas deixa ids do Asaas (cus_/pay_) em paz', () => {
  assert.equal(limparTexto(`x ${CHAVE} y`), 'x [chave] y');
  assert.equal(limparTexto('cpf 52998224725 e 529.982.247-25 e cnpj 11222333000181 e 11.222.333/0001-81'), 'cpf [documento] e [documento] e cnpj [documento] e [documento]');
  assert.equal(limparTexto('cliente cus_000005401844 cobrança pay_12345678901 criada'), 'cliente cus_000005401844 cobrança pay_12345678901 criada');
  assert.equal(limparTexto('mande para maria.silva@exemplo.com já'), 'mande para [e-mail] já');
  assert.equal(limparTexto('a chave inteira', 'chave inteira'), 'a [chave]');
});

test('asaasEscrever: 2xx com corpo ilegível ou cortado é "pode ter gravado" (status nulo), nunca erro cru', async () => {
  const ilegivel = (async () => new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch;
  const erro = await asaasEscrever('c2', CHAVE, 'POST', '/payments', {}, ilegivel).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.ok(erro);
  assert.equal(erro.status, null);
  assert.match(erro.message, /pode ter acontecido/);
  const cortado = (async () => ({ status: 200, ok: true, text: async () => { throw new Error('socket'); } })) as unknown as typeof fetch;
  const erro2 = await asaasEscrever('c2', CHAVE, 'POST', '/payments', {}, cortado).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.equal(erro2!.status, null);
  assert.match(erro2!.message, /cortada no meio/);
});

test('asaasEscrever: 429 repete (o Asaas não processou) e, esgotadas as tentativas, diz que nada foi gravado', async () => {
  const a = falso([{ status: 429 }, { status: 200, corpo: { id: 'ok' } }]);
  assert.deepEqual(await asaasEscrever('c3', CHAVE, 'POST', '/payments', {}, a.fetcher), { id: 'ok' });
  assert.equal(a.chamadas.length, 2);
  const b = falso([{ status: 429 }]);
  const erro = await asaasEscrever('c4', CHAVE, 'POST', '/payments', {}, b.fetcher).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.equal(erro!.status, 429);
  assert.match(erro!.message, /nada foi gravado/);
  assert.equal(b.chamadas.length, 3);
});

test('6) asaasEscrever não segue redirecionamento (redirect: "error"): a chave não vai parar em outro endereço', async () => {
  const { fetcher, chamadas } = falso([{ status: 200, corpo: { id: 'x' } }]);
  await asaasEscrever('c5', CHAVE, 'POST', '/payments', {}, fetcher);
  assert.equal(chamadas[0]!.init.redirect, 'error');
  // se o fetch recusar o redirecionamento, vira "pode ter gravado" (o POST pode ter sido processado), sem a chave na mensagem
  const redireciona = (async () => { throw new TypeError(`redirect mode is set to error: https://evil.example/?k=${CHAVE}`); }) as unknown as typeof fetch;
  const erro = await asaasEscrever('c5', CHAVE, 'POST', '/payments', {}, redireciona).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.equal(erro!.status, null);
  assert.match(erro!.message, /pode ter acontecido/);
  assert.ok(!erro!.message.includes('evil') && !erro!.message.includes('aact'));
});

test('7) limparTexto: telefone de 10, 12 e 13 dígitos (lib/pii) sai; ids do Asaas, datas e valores ficam', () => {
  const t = limparTexto('tel (63) 3321-4455, 63 98141-1248, +55 63 98141-1248, 5563981411248 e 556333214455; cus_000005401844 pay_6501234567890123 venceu 2026-11-10 valor R$ 250,00');
  for (const p of ['3321-4455', '98141-1248', '5563981411248', '556333214455']) assert.ok(!t.includes(p), p);
  assert.match(t, /cus_000005401844 pay_6501234567890123 venceu 2026-11-10 valor R\$ 250,00/);
});

test('8) asaasGet também não segue redirecionamento: a mesma chave vai no cabeçalho da leitura', async () => {
  const { fetcher, chamadas } = falso([{ status: 200, corpo: { data: [] } }]);
  await asaasGet('c8', CHAVE, '/customers', { limit: 1 }, fetcher);
  assert.equal(chamadas[0]!.init.redirect, 'error');
});
