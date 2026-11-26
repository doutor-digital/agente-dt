import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroInfinitepay, consultarPagamento, lerContasDoAmbiente, testarChave, tirarChave } from './infinitepay.js';

const CHAVE = 'inchk_FIXTURE0123456789abcdefghijklmnopqrstu';
const UNIDADES = [
  { slug: 'doutor-hernia-acailandia', nome: 'Açailândia' },
  { slug: 'doutor-hernia-serra', nome: 'Serra' },
  { slug: 'doutor-hernia-serra-talhada', nome: 'Serra Talhada' },
  { slug: 'hm-tecnologia', nome: 'HM' },
];

function falso(status: number, corpo: unknown) {
  const vistas: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    vistas.push({ url, init });
    return new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status });
  }) as unknown as typeof fetch;
  return { f, vistas };
}

test('ambiente: INFINITEPAY_CHAVE_ACAILANDIA acha a unidade pelo final do slug', () => {
  const r = lerContasDoAmbiente(UNIDADES, { INFINITEPAY_CHAVE_ACAILANDIA: CHAVE, INFINITEPAY_HANDLE_ACAILANDIA: '$tag-da-clinica' });
  assert.deepEqual([...r.contas.keys()], ['doutor-hernia-acailandia']);
  assert.equal(r.contas.get('doutor-hernia-acailandia')!.handle, 'tag-da-clinica', 'o $ da InfiniteTag sai');
  assert.deepEqual(r.ignoradas, []);
});

test('ambiente: o slug inteiro vale; o final ambíguo e o desconhecido são IGNORADOS, nunca adivinhados', () => {
  const r = lerContasDoAmbiente(UNIDADES, {
    INFINITEPAY_CHAVE_HM_TECNOLOGIA: CHAVE,
    INFINITEPAY_CHAVE_SERRA: CHAVE,
    INFINITEPAY_CHAVE_TALHADA: CHAVE,
    INFINITEPAY_CHAVE_NAO_EXISTE: CHAVE,
  });
  assert.ok(r.contas.has('hm-tecnologia'));
  // "-serra" só termina doutor-hernia-serra (a outra termina em "-talhada"), então não é ambíguo
  assert.ok(r.contas.has('doutor-hernia-serra'));
  assert.ok(r.contas.has('doutor-hernia-serra-talhada'));
  assert.equal(r.ignoradas.length, 1);
  assert.equal(r.ignoradas[0]!.variavel, 'INFINITEPAY_CHAVE_NAO_EXISTE');
});

test('ambiente: sufixo que casa com duas unidades é ignorado', () => {
  const u = [
    { slug: 'a-centro', nome: 'A' },
    { slug: 'b-centro', nome: 'B' },
  ];
  const r = lerContasDoAmbiente(u, { INFINITEPAY_CHAVE_CENTRO: CHAVE });
  assert.equal(r.contas.size, 0);
  assert.match(r.ignoradas[0]!.motivo, /ambígua/);
});

test('ambiente: chave vazia some sem barulho; chave fora do formato é ignorada sem repetir o valor', () => {
  const r = lerContasDoAmbiente(UNIDADES, { INFINITEPAY_CHAVE_ACAILANDIA: '  ', INFINITEPAY_CHAVE_HM_TECNOLOGIA: 'sk_live_valor-secreto-que-nao-e-inchk' });
  assert.equal(r.contas.size, 0);
  assert.equal(r.ignoradas.length, 1);
  assert.equal(JSON.stringify(r.ignoradas).includes('valor-secreto'), false);
});

test('ambiente: duas variáveis para a mesma unidade — vale a primeira, a outra é ignorada', () => {
  const r = lerContasDoAmbiente(UNIDADES, { INFINITEPAY_CHAVE_ACAILANDIA: CHAVE, INFINITEPAY_CHAVE_DOUTOR_HERNIA_ACAILANDIA: `${CHAVE}2` });
  assert.equal(r.contas.size, 1);
  assert.equal(r.ignoradas.length, 1);
  assert.match(r.ignoradas[0]!.motivo, /já tem uma chave/);
});

test('consultarPagamento: POST /payment_check com a chave no cabeçalho e nunca na URL ou no corpo', async () => {
  const { f, vistas } = falso(200, { success: true, paid: true, amount: 1500, paid_amount: 1510, installments: 1, capture_method: 'pix' });
  const r = await consultarPagamento(CHAVE, { orderNsu: 'o1', transactionNsu: 't1', slug: 's1' }, { fetcher: f });
  assert.deepEqual(r, { sucesso: true, pago: true, valorCentavos: 1500, valorPagoCentavos: 1510, parcelas: 1, forma: 'pix' });
  assert.equal(vistas[0]!.url, 'https://api.checkout.infinitepay.io/payment_check');
  assert.equal(vistas[0]!.init.method, 'POST');
  assert.equal((vistas[0]!.init.headers as Record<string, string>)['X-Api-Key'], CHAVE);
  assert.equal(vistas[0]!.url.includes('inchk_'), false);
  assert.equal(String(vistas[0]!.init.body).includes('inchk_'), false);
  assert.deepEqual(JSON.parse(String(vistas[0]!.init.body)), { order_nsu: 'o1', transaction_nsu: 't1', slug: 's1' });
});

test('consultarPagamento: manda a InfiniteTag só quando existe', async () => {
  const { f, vistas } = falso(200, { success: false });
  await consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's', handle: 'minha-tag' }, { fetcher: f });
  assert.equal(JSON.parse(String(vistas[0]!.init.body)).handle, 'minha-tag');
});

test('consultarPagamento: success:false e paid:false voltam como "não pago", sem erro', async () => {
  const a = await consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, { fetcher: falso(200, { success: false }).f });
  assert.deepEqual(a, { sucesso: false, pago: false });
  const b = await consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, { fetcher: falso(200, { success: true, paid: false, amount: 100 }).f });
  assert.equal(b.pago, false);
  assert.equal(b.sucesso, true);
});

test('consultarPagamento: 403 diz o que conferir e não repete a chave; 429 e 500 viram erro legível', async () => {
  await assert.rejects(
    () => consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, { fetcher: falso(403, { success: false, message: `Forbidden ${CHAVE}` }).f }),
    (e: unknown) => e instanceof ErroInfinitepay && e.status === 403 && /recusou a chave/.test(e.message) && !e.message.includes('inchk_FIXTURE'),
  );
  await assert.rejects(() => consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, { fetcher: falso(429, '') .f }), /mais devagar/);
  await assert.rejects(() => consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, { fetcher: falso(502, 'bad gateway').f }), /502/);
});

test('consultarPagamento: rede fora do ar e timeout viram erro legível, sem a chave', async () => {
  const rede = (async () => {
    throw new TypeError(`fetch failed (X-Api-Key: ${CHAVE})`);
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, { fetcher: rede }),
    (e: unknown) => e instanceof ErroInfinitepay && /rede/.test(e.message) && !e.message.includes('inchk_'),
  );
  const lento = (async () => {
    const e = new Error('x');
    e.name = 'TimeoutError';
    throw e;
  }) as unknown as typeof fetch;
  await assert.rejects(() => consultarPagamento(CHAVE, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, { fetcher: lento }), /a tempo/);
});

test('testarChave: consulta um pagamento INVENTADO (não cria nada); 200 passa, 403 reprova', async () => {
  const ok = falso(200, { success: false });
  await testarChave(CHAVE, { fetcher: ok.f });
  assert.equal(ok.vistas.length, 1);
  assert.equal(ok.vistas[0]!.url.endsWith('/payment_check'), true, 'nunca chama /links');
  await assert.rejects(() => testarChave(CHAVE, { fetcher: falso(403, { success: false, message: 'Forbidden' }).f }), /recusou a chave/);
});

test('tirarChave troca qualquer inchk_ por reticências', () => {
  assert.equal(tirarChave(`erro com ${CHAVE} e mais`), 'erro com inchk_… e mais');
});
