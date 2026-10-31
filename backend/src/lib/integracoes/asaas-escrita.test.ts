import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asaasPost, limparTexto } from './asaas-escrita.js';
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

test('asaasPost: 2xx com corpo ilegível ou cortado é "pode ter gravado" (status nulo), nunca erro cru', async () => {
  const ilegivel = (async () => new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch;
  const erro = await asaasPost('c2', CHAVE, '/payments', {}, ilegivel).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.ok(erro);
  assert.equal(erro.status, null);
  assert.match(erro.message, /pode ter acontecido/);
  const cortado = (async () => ({ status: 200, ok: true, text: async () => { throw new Error('socket'); } })) as unknown as typeof fetch;
  const erro2 = await asaasPost('c2', CHAVE, '/payments', {}, cortado).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.equal(erro2!.status, null);
  assert.match(erro2!.message, /cortada no meio/);
});

test('asaasPost: 429 repete (o Asaas não processou) e, esgotadas as tentativas, diz que nada foi gravado', async () => {
  const a = falso([{ status: 429 }, { status: 200, corpo: { id: 'ok' } }]);
  assert.deepEqual(await asaasPost('c3', CHAVE, '/payments', {}, a.fetcher), { id: 'ok' });
  assert.equal(a.chamadas.length, 2);
  const b = falso([{ status: 429 }]);
  const erro = await asaasPost('c4', CHAVE, '/payments', {}, b.fetcher).then(() => null, (e: Error & { status?: number | null }) => e);
  assert.equal(erro!.status, 429);
  assert.match(erro!.message, /nada foi gravado/);
  assert.equal(b.chamadas.length, 3);
});

test('6) asaasPost não segue redirecionamento (redirect: "error"): a chave não vai parar em outro endereço', async () => {
  const { fetcher, chamadas } = falso([{ status: 200, corpo: { id: 'x' } }]);
  await asaasPost('c5', CHAVE, '/payments', {}, fetcher);
  assert.equal(chamadas[0]!.init.redirect, 'error');
  // se o fetch recusar o redirecionamento, vira "pode ter gravado" (o POST pode ter sido processado), sem a chave na mensagem
  const redireciona = (async () => { throw new TypeError(`redirect mode is set to error: https://evil.example/?k=${CHAVE}`); }) as unknown as typeof fetch;
  const erro = await asaasPost('c5', CHAVE, '/payments', {}, redireciona).then(() => null, (e: Error & { status?: number | null }) => e);
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
