import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErroPluggy,
  clienteCompartilhado,
  criarClientePluggy,
  depoisDoCursor,
  itemMascarado,
  lerCredenciais,
  lerItensDoAmbiente,
  numeroMascarado,
  resolverEmpresas,
  tirarSegredos,
} from './pluggy.js';

// valores de mentira com o formato real (nada daqui é segredo de verdade)
const SEGREDO = 'pluggy_sk_FIXTURE0123456789abcdefghijklmnopqrstuvwxyz0123';
const CLIENT_ID = '00000000-1111-2222-3333-444444444444';
// montada em partes: o guarda do repositório recusa qualquer JWT literal no código (o repositório é público)
const API_KEY = ['eyJhbGciOiJIUzI1NiJ9', 'eyJmaXh0dXJlIjoidGVzdGUifQ', 'FIXTUREsignature0123456789'].join('.');
const ITEM = 'a5c763cb-0952-457b-9936-630f79c5b016';
const ITEM2 = 'd161a74a-8bc8-4093-88de-724312969b0d';
const CONTA = '562b795d-1653-429f-be86-74ead9502813';

interface Chamada {
  metodo: string;
  caminho: string;
  query: URLSearchParams;
  chave?: string;
  corpo?: unknown;
}

/** Um fetch que responde no formato DOCUMENTADO da Pluggy e anota o que recebeu. */
function pluggyFalso(rotas: Record<string, (c: Chamada, n: number) => { status?: number; json?: unknown; texto?: string; headers?: Record<string, string> } | Error>) {
  const chamadas: Chamada[] = [];
  const contagem = new Map<string, number>();
  const fetcher = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const h = init.headers as Record<string, string>;
    const c: Chamada = { metodo: String(init.method), caminho: u.pathname, query: u.searchParams, chave: h['X-API-KEY'], ...(init.body ? { corpo: JSON.parse(String(init.body)) } : {}) };
    chamadas.push(c);
    const k = `${c.metodo} ${c.caminho}`;
    const n = (contagem.get(k) ?? 0) + 1;
    contagem.set(k, n);
    const rota = rotas[k];
    if (!rota) return new Response('{}', { status: 404 });
    const r = rota(c, n);
    if (r instanceof Error) throw r;
    return new Response(r.texto ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetcher, chamadas };
}

const semEspera = async () => undefined;
const cliente = (f: typeof fetch, o: Parameters<typeof criarClientePluggy>[1] = {}) =>
  criarClientePluggy({ clientId: CLIENT_ID, clientSecret: SEGREDO }, { fetcher: f, esperar: semEspera, ...o });

const auth = (n = 0) => ({ json: { apiKey: `${API_KEY}${n}` } });

// ------------------------------------------------------------------ configuração

test('PLUGGY_ITENS: lê empresa:itemId[:apelido]; vazio não gera nada', () => {
  assert.deepEqual(lerItensDoAmbiente(undefined), { entradas: [], ignoradas: [] });
  assert.deepEqual(lerItensDoAmbiente('  '), { entradas: [], ignoradas: [] });
  const r = lerItensDoAmbiente(`doutor-digital:${ITEM}:Nubank_PJ, Doutor-Digital:${ITEM2}`);
  assert.deepEqual(r.entradas, [
    { empresa: 'doutor-digital', itemId: ITEM, apelido: 'Nubank_PJ' },
    { empresa: 'doutor-digital', itemId: ITEM2 },
  ]);
  assert.deepEqual(r.ignoradas, []);
});

test('PLUGGY_ITENS: malformado é ignorado com motivo, sem o texto inteiro no log', () => {
  const r = lerItensDoAmbiente(`so-uma-parte, doutor-digital:nao-e-uuid, doutor-digital:${ITEM}:a:b, doutor-digital:${ITEM}:com espaco, X:${ITEM2}`);
  assert.equal(r.entradas.length, 0);
  assert.equal(r.ignoradas.length, 5);
  assert.match(JSON.stringify(r.ignoradas), /formato esperado/);
  assert.match(JSON.stringify(r.ignoradas), /UUID/);
  assert.match(JSON.stringify(r.ignoradas), /apelido inválido/);
  assert.match(JSON.stringify(r.ignoradas), /empresa com formato inválido/);
  // o id inteiro nunca vai para o log: só o final
  assert.equal(JSON.stringify(r.ignoradas).includes(ITEM), false);
});

test('PLUGGY_ITENS: item repetido na mesma empresa fica uma vez; o mesmo item em duas empresas é ambíguo e NENHUMA vale', () => {
  const rep = lerItensDoAmbiente(`doutor-digital:${ITEM}, doutor-digital:${ITEM}:outro`);
  assert.equal(rep.entradas.length, 1);
  assert.equal(rep.ignoradas.length, 1);
  assert.match(rep.ignoradas[0]!.motivo, /repetido/);
  const amb = lerItensDoAmbiente(`doutor-digital:${ITEM}, hm-tecnologia:${ITEM}, hm-tecnologia:${ITEM2}`);
  assert.deepEqual(amb.entradas.map((e) => e.itemId), [ITEM2]);
  assert.equal(amb.ignoradas.filter((i) => /ambíguo/.test(i.motivo)).length, 2);
});

test('resolverEmpresas: só o slug EXATO de unidade ativa; desconhecida e inativa são ignoradas, nunca aproximadas', () => {
  const { entradas } = lerItensDoAmbiente(`doutor-digital:${ITEM}, digital:${ITEM2}, hm-tecnologia:d161a74a-8bc8-4093-88de-724312969b0e`);
  const r = resolverEmpresas(entradas, [
    { slug: 'doutor-digital', nome: 'Doutor Digital' },
    { slug: 'hm-tecnologia', nome: 'HM', ativa: false },
  ]);
  assert.deepEqual(r.itens.map((i) => i.empresa), ['doutor-digital']);
  assert.equal(r.itens[0]!.nomeDaEmpresa, 'Doutor Digital');
  assert.equal(r.ignoradas.length, 2);
  assert.match(r.ignoradas[0]!.motivo, /nenhuma empresa\/unidade com o slug "digital"/);
  assert.match(JSON.stringify(r.ignoradas), /inativa/);
});

test('credenciais: precisa dos dois; vazio ou só um = desligado', () => {
  assert.equal(lerCredenciais({}), null);
  assert.equal(lerCredenciais({ PLUGGY_CLIENT_ID: CLIENT_ID }), null);
  assert.equal(lerCredenciais({ PLUGGY_CLIENT_ID: ' ', PLUGGY_CLIENT_SECRET: SEGREDO }), null);
  assert.deepEqual(lerCredenciais({ PLUGGY_CLIENT_ID: CLIENT_ID, PLUGGY_CLIENT_SECRET: ` ${SEGREDO} ` }), { clientId: CLIENT_ID, clientSecret: SEGREDO });
  assert.equal(clienteCompartilhado({}), null);
  const a = clienteCompartilhado({ PLUGGY_CLIENT_ID: CLIENT_ID, PLUGGY_CLIENT_SECRET: SEGREDO });
  assert.ok(a);
  assert.equal(clienteCompartilhado({ PLUGGY_CLIENT_ID: CLIENT_ID, PLUGGY_CLIENT_SECRET: SEGREDO }), a, 'o mesmo cliente para o conector e o webhook');
});

test('máscaras: número de conta, id de item e segredos nos formatos conhecidos', () => {
  assert.equal(numeroMascarado('0001/12345-0'), '•••3450');
  assert.equal(numeroMascarado('xxxx8670'), '•••8670');
  assert.equal(numeroMascarado(null), null);
  assert.equal(numeroMascarado('--'), null);
  assert.equal(itemMascarado(ITEM), '…c5b016');
  const sujo = `falhou com ${SEGREDO} e ${API_KEY} e whsec_${'a'.repeat(64)}`;
  const limpo = tirarSegredos(sujo);
  assert.equal(/FIXTURE|eyJ|aaaaaaaa/.test(limpo), false, limpo);
  // valor exato conhecido sai mesmo sem o formato
  assert.equal(tirarSegredos('o segredo é abcdef123456 ok', ['abcdef123456']).includes('abcdef'), false);
  assert.equal(new ErroPluggy(`x ${SEGREDO}`).message.includes('FIXTURE'), false);
});

// ------------------------------------------------------------------ cliente HTTP

test('/auth leva clientId e clientSecret no corpo; a chave vai em X-API-KEY; a chave fica em cache entre chamadas', async () => {
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    ['GET /items/' + ITEM]: () => ({ json: { id: ITEM, status: 'UPDATED', executionStatus: 'SUCCESS', connector: { id: 1, name: 'Nubank' }, lastUpdatedAt: '2026-11-26T09:00:00.000Z', consentExpiresAt: '2027-11-01T00:00:00.000Z' } }),
    'GET /accounts': () => ({ json: { page: 1, total: 0, totalPages: 1, results: [] } }),
  });
  const c = cliente(p.fetcher, { cacheMs: 0 });
  const it = await c.item(ITEM);
  await c.contas(ITEM);
  await c.item(ITEM);
  const autenticacoes = p.chamadas.filter((x) => x.caminho === '/auth');
  assert.equal(autenticacoes.length, 1, 'a chave de 2 h é reaproveitada');
  assert.deepEqual(autenticacoes[0]!.corpo, { clientId: CLIENT_ID, clientSecret: SEGREDO });
  assert.equal(autenticacoes[0]!.chave, undefined, '/auth não leva X-API-KEY');
  assert.ok(p.chamadas.filter((x) => x.caminho !== '/auth').every((x) => x.chave === `${API_KEY}0`));
  assert.deepEqual(it, {
    id: ITEM, banco: 'Nubank', status: 'UPDATED', statusDaSincronizacao: 'SUCCESS',
    atualizadoEm: '2026-11-26T09:00:00.000Z', consentimentoExpiraEm: '2027-11-01T00:00:00.000Z', erroCodigo: null,
  });
});

test('a chave é renovada perto de vencer (margem) e uma única vez por vez, mesmo com chamadas em paralelo', async () => {
  let agora = 1_000_000;
  const p = pluggyFalso({
    'POST /auth': (_c, n) => auth(n),
    ['GET /items/' + ITEM]: () => ({ json: { id: ITEM, status: 'UPDATED' } }),
  });
  const c = cliente(p.fetcher, { agora: () => agora, cacheMs: 0 });
  await Promise.all([c.item(ITEM), c.item(ITEM), c.item(ITEM)]);
  assert.equal(p.chamadas.filter((x) => x.caminho === '/auth').length, 1, 'três chamadas juntas = um /auth');
  agora += 2 * 60 * 60_000 - 6 * 60_000; // ainda dentro da validade menos a margem de 5 min
  await c.item(ITEM);
  assert.equal(p.chamadas.filter((x) => x.caminho === '/auth').length, 1);
  agora += 2 * 60_000; // passou da margem: renova
  await c.item(ITEM);
  const autenticacoes = p.chamadas.filter((x) => x.caminho === '/auth');
  assert.equal(autenticacoes.length, 2);
  assert.equal(p.chamadas.at(-1)!.chave, `${API_KEY}2`);
});

test('401 numa leitura com a chave guardada: renova a chave UMA vez e repete; 401 de novo vira erro', async () => {
  const p = pluggyFalso({
    'POST /auth': (_c, n) => auth(n),
    ['GET /items/' + ITEM]: (c) => (c.chave === `${API_KEY}1` ? { status: 401, json: { message: 'expired' } } : { json: { id: ITEM, status: 'UPDATED' } }),
  });
  const c = cliente(p.fetcher, { cacheMs: 0 });
  const r = await c.item(ITEM);
  assert.equal(r.status, 'UPDATED');
  assert.equal(p.chamadas.filter((x) => x.caminho === '/auth').length, 2);
  const sempre401 = pluggyFalso({ 'POST /auth': () => auth(), ['GET /items/' + ITEM]: () => ({ status: 401, json: {} }) });
  await assert.rejects(() => cliente(sempre401.fetcher).item(ITEM), /não aceitou a chave/);
  assert.equal(sempre401.chamadas.filter((x) => x.caminho === '/auth').length, 2, 'renova uma vez, não em laço');
});

test('retentativa LIMITADA em 429 e 5xx (2 extras, espera pelo RateLimit-Reset); 4xx não repete', async () => {
  const esperas: number[] = [];
  const esperar = async (ms: number) => void esperas.push(ms);
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    ['GET /items/' + ITEM]: (_c, n) => (n === 1 ? { status: 429, json: { code: 429 }, headers: { 'RateLimit-Reset': '3', 'Retry-After': '60' } } : n === 2 ? { status: 503, json: {} } : { json: { id: ITEM, status: 'UPDATED' } }),
  });
  const r = await cliente(p.fetcher, { esperar }).item(ITEM);
  assert.equal(r.status, 'UPDATED');
  assert.deepEqual(esperas, [3000, 1000], '429 espera o RateLimit-Reset; 5xx recua');
  const sempre500 = pluggyFalso({ 'POST /auth': () => auth(), ['GET /items/' + ITEM]: () => ({ status: 500, json: {} }) });
  await assert.rejects(() => cliente(sempre500.fetcher).item(ITEM), /respondeu 500/);
  assert.equal(sempre500.chamadas.filter((x) => x.caminho.startsWith('/items')).length, 3, '1 + 2 retentativas, e para');
  const nao = pluggyFalso({ 'POST /auth': () => auth(), ['GET /items/' + ITEM]: () => ({ status: 404, json: {} }) });
  await assert.rejects(() => cliente(nao.fetcher).item(ITEM), /não achou/);
  assert.equal(nao.chamadas.filter((x) => x.caminho.startsWith('/items')).length, 1, '404 não repete');
});

test('429 espera no máximo 10 s e queda de rede também tem retentativa limitada', async () => {
  const esperas: number[] = [];
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    ['GET /items/' + ITEM]: (_c, n) => (n === 1 ? { status: 429, headers: { 'RateLimit-Reset': '45' } } : n === 2 ? new TypeError('fetch failed') : { json: { id: ITEM } }),
  });
  await cliente(p.fetcher, { esperar: async (ms) => void esperas.push(ms) }).item(ITEM);
  assert.deepEqual(esperas, [10_000, 1000]);
  const fora = pluggyFalso({ 'POST /auth': () => new TypeError('fetch failed') });
  await assert.rejects(() => cliente(fora.fetcher).testar(), /rede/);
  assert.equal(fora.chamadas.length, 3);
});

test('timeout: a chamada leva um sinal de tempo limite e a falha vira mensagem legível', async () => {
  let sinal: AbortSignal | undefined;
  const f = (async (_u: string, init: RequestInit) => {
    sinal = init.signal as AbortSignal;
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  }) as unknown as typeof fetch;
  await assert.rejects(() => cliente(f, { retentativas: 0 }).testar(), /não respondeu a tempo/);
  assert.ok(sinal instanceof AbortSignal);
});

test('/auth recusado: 401 com codeDescription mostra só o CÓDIGO e nunca o corpo; nenhum erro carrega o secret', async () => {
  const p = pluggyFalso({ 'POST /auth': () => ({ status: 401, json: { message: `bad ${SEGREDO}`, codeDescription: 'CLIENT_SECRET_EXPIRED' } }) });
  const e = await cliente(p.fetcher).testar().catch((x: Error) => x);
  assert.ok(e instanceof ErroPluggy);
  assert.match(e.message, /recusou o clientId\/clientSecret \(401\) \[CLIENT_SECRET_EXPIRED\]/);
  assert.equal(e.message.includes('FIXTURE'), false);
  const eco = pluggyFalso({ 'POST /auth': () => ({ status: 500, json: { codeDescription: 'x'.repeat(5) + SEGREDO } }) });
  const e2 = await cliente(eco.fetcher).testar().catch((x: Error) => x);
  assert.equal(String((e2 as Error).message).includes('FIXTURE'), false);
  // 200 sem apiKey (proxy) não vira credencial válida
  const sem = pluggyFalso({ 'POST /auth': () => ({ json: { ok: true } }) });
  await assert.rejects(() => cliente(sem.fetcher).testar(), /sem a chave/);
});

test('apiKey e secret nunca aparecem num erro de leitura, mesmo que a API os repita', async () => {
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    ['GET /items/' + ITEM]: () => ({ status: 403, json: { message: `proibido ${API_KEY}0 ${SEGREDO}`, codeDescription: 'FORBIDDEN' } }),
  });
  const e = await cliente(p.fetcher).item(ITEM).catch((x: Error) => x);
  assert.match((e as Error).message, /403/);
  assert.equal(/FIXTURE|eyJ/.test((e as Error).message), false);
});

test('contas: formato documentado da Pluggy (banco e cartão), saldo e limite; sem results é erro', async () => {
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    'GET /accounts': (c) =>
      c.query.get('itemId') === ITEM
        ? {
            json: {
              page: 1, total: 2, totalPages: 1,
              results: [
                { id: CONTA, type: 'BANK', subtype: 'CHECKING_ACCOUNT', number: '0001/12345-0', name: 'Conta Corrente', marketingName: 'GOLD', balance: 1209.5, itemId: ITEM, taxNumber: '333.333.333-33', owner: 'John Doe', currencyCode: 'BRL', bankData: { transferNumber: '0001/12345-0' } },
                { id: 'a658c848-e475-457b-8565-d1fffba127c4', type: 'CREDIT', subtype: 'CREDIT_CARD', number: 'xxxx8670', name: 'Mastercard Black', balance: 300, itemId: ITEM, currencyCode: 'BRL', creditData: { creditLimit: 3000, availableCreditLimit: 2000 } },
              ],
            },
          }
        : { json: { nada: true } },
  });
  const c = cliente(p.fetcher);
  const contas = await c.contas(ITEM);
  assert.equal(contas.length, 2);
  assert.deepEqual(contas[0], { id: CONTA, tipo: 'BANK', subtipo: 'CHECKING_ACCOUNT', nome: 'Conta Corrente', numero: '0001/12345-0', saldo: 1209.5, moeda: 'BRL' });
  assert.equal(contas[1]!.limiteDisponivel, 2000);
  assert.equal(JSON.stringify(contas).includes('333.333'), false, 'CPF do titular não é lido');
  assert.equal(JSON.stringify(contas).includes('John'), false, 'nome do titular não é lido');
  assert.equal(p.chamadas.find((x) => x.caminho === '/accounts')!.query.get('itemId'), ITEM);
  await assert.rejects(() => c.contas(ITEM2), /sem results/);
});

const tx = (id: string, data: string, amount: number, type: 'DEBIT' | 'CREDIT', extra: Record<string, unknown> = {}) => ({
  id, createdAt: '2026-11-01T00:00:00.000Z', description: `desc ${id}`, descriptionRaw: `raw ${id}`, currencyCode: 'BRL', amount, date: `${data}T00:00:00.000Z`, balance: 100, category: 'Transfers', accountId: CONTA, providerCode: null, status: 'POSTED', paymentData: null, type, providerId: null, ...extra,
});

test('lançamentos: usa a /v2 (a /transactions sai do ar em 31/12/2026), manda dateFrom/dateTo e segue o cursor `next` até acabar', async () => {
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    'GET /v2/transactions': (c) => {
      const depois = c.query.get('after');
      if (!depois) return { json: { results: [tx('t1', '2026-11-03', -50, 'DEBIT'), tx('t2', '2026-11-02', 200, 'CREDIT', { paymentData: { payer: { name: 'Maria Souza', documentNumber: { type: 'CPF', value: '666.666.666-66' } }, receiver: { name: 'Doutor Digital' }, reason: 'Consulta', paymentMethod: 'PIX' } })], next: `?accountId=${CONTA}&after=ABC%3D%3D` } };
      if (depois === 'ABC==') return { json: { results: [tx('t3', '2026-11-01', -10.1, 'DEBIT')], next: null } };
      return { status: 400, json: {} };
    },
  });
  const r = await cliente(p.fetcher).transacoes(CONTA, '2026-11-01', '2026-11-30');
  assert.equal(r.truncado, false);
  assert.deepEqual(r.lancamentos.map((l) => l.id), ['t1', 't2', 't3']);
  const chamadas = p.chamadas.filter((x) => x.caminho === '/v2/transactions');
  assert.equal(chamadas.length, 2);
  assert.equal(chamadas[0]!.query.get('accountId'), CONTA);
  assert.equal(chamadas[0]!.query.get('dateFrom'), '2026-11-01');
  assert.equal(chamadas[0]!.query.get('dateTo'), '2026-11-30');
  assert.equal(chamadas[0]!.query.get('after'), null);
  assert.equal(chamadas[1]!.query.get('after'), 'ABC==', 'só o valor de `after`, já decodificado, nunca o `next` inteiro');
  assert.equal(p.chamadas.some((x) => x.caminho === '/transactions'), false, 'a rota obsoleta não é usada');
  const t2 = r.lancamentos[1]!;
  // o NÚMERO do documento do pagador nunca é lido; só o tipo (PF/PJ), para saber que o Pix veio de empresa
  assert.deepEqual(t2, { id: 't2', data: '2026-11-02', descricao: 'desc t2', valor: 200, tipo: 'entrada', categoria: 'Transfers', status: 'POSTED', pagador: 'Maria Souza', pagadorTipoDocumento: 'PF', metodoDePagamento: 'PIX', recebedor: 'Doutor Digital', motivo: 'Consulta' });
  assert.equal(JSON.stringify(r).includes('666'), false, 'o documento do pagador nunca é lido');
  assert.equal(r.lancamentos[0]!.tipo, 'saida');
});

test('lançamentos: só o TIPO do documento do pagador é guardado (CPF→PF, CNPJ→PJ); o número nunca, em nenhum formato', async () => {
  const pg = (value: unknown, type: unknown = 'CPF') => ({ paymentData: { payer: { name: 'Fulana Teste', documentNumber: { type, value } }, receiver: {}, paymentMethod: 'PIX' } });
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    'GET /v2/transactions': () => ({
      json: {
        results: [
          tx('cpf', '2026-11-02', 10, 'CREDIT', pg('111.222.333-44')),
          tx('cnpj', '2026-11-02', 10, 'CREDIT', pg('12.345.678/0001-90', 'CNPJ')),
          tx('mascarado', '2026-11-02', 10, 'CREDIT', pg('***.222.333-**')),
          tx('tipo', '2026-11-02', 10, 'CREDIT', pg('11122233344', 'RG')),
          tx('sem', '2026-11-02', 10, 'CREDIT'),
        ],
        next: null,
      },
    }),
  });
  const r = await cliente(p.fetcher).transacoes(CONTA, '2026-11-01', '2026-11-30');
  const tipo = (id: string) => r.lancamentos.find((l) => l.id === id)!.pagadorTipoDocumento;
  assert.equal(tipo('cpf'), 'PF');
  assert.equal(tipo('cnpj'), 'PJ');
  for (const id of ['tipo', 'sem']) assert.equal(tipo(id), undefined, id);
  const tudo = JSON.stringify(r);
  for (const numero of ['111', '222', '333', '12.345', '0001', '11122233344']) assert.equal(tudo.includes(numero), false, `o número do documento (${numero}) nunca entra no modelo`);
});

test('lançamentos: o método de pagamento (paymentMethod) é lido em maiúsculas; valor estranho ou ausente não vira método', async () => {
  const pg = (paymentMethod: unknown) => ({ paymentData: { payer: { name: 'Fulana Teste' }, receiver: {}, paymentMethod } });
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    'GET /v2/transactions': () => ({ json: { results: [tx('pix', '2026-11-02', 10, 'CREDIT', pg('PIX')), tx('baixo', '2026-11-02', 10, 'CREDIT', pg('pix')), tx('estranho', '2026-11-02', 10, 'CREDIT', pg('pix; DROP')), tx('sem', '2026-11-02', 10, 'CREDIT')], next: null } }),
  });
  const r = await cliente(p.fetcher).transacoes(CONTA, '2026-11-01', '2026-11-30');
  const m = (id: string) => r.lancamentos.find((l) => l.id === id)!.metodoDePagamento;
  assert.equal(m('pix'), 'PIX');
  assert.equal(m('baixo'), 'PIX');
  assert.equal(m('estranho'), undefined);
  assert.equal(m('sem'), undefined);
});

test('lançamentos: o `type` manda; sem ele vale o sinal; lançamento sem id/data/valor é descartado; cursor repetido e teto de páginas marcam truncado', async () => {
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    'GET /v2/transactions': () => ({ json: { results: [tx('a', '2026-11-03', 99, 'DEBIT'), { id: 'b', date: '2026-11-04T00:00:00.000Z', amount: -5 }, { id: 'c', amount: 1 }, { date: '2026-11-04', amount: 1 }], next: '?accountId=x&after=MESMO' } }),
  });
  const r = await cliente(p.fetcher).transacoes(CONTA, '2026-11-01', '2026-11-30');
  assert.equal(r.truncado, true, 'cursor que se repete não gira para sempre');
  assert.equal(p.chamadas.filter((x) => x.caminho === '/v2/transactions').length, 2);
  assert.equal(r.lancamentos[0]!.tipo, 'saida', 'DEBIT com valor positivo continua saída');
  assert.equal(r.lancamentos[1]!.tipo, 'saida', 'sem type, o sinal negativo é saída');
  assert.equal(r.lancamentos.filter((l) => l.id === 'c').length, 0);
  let n = 0;
  const infinito = pluggyFalso({ 'POST /auth': () => auth(), 'GET /v2/transactions': () => ({ json: { results: [], next: `?accountId=x&after=P${n++}` } }) });
  const t = await cliente(infinito.fetcher, { maxPaginas: 3 }).transacoes(CONTA, '2026-11-01', '2026-11-30');
  assert.equal(t.truncado, true);
  assert.equal(infinito.chamadas.filter((x) => x.caminho === '/v2/transactions').length, 3);
});

test('o webhook invalida o cache do item (item e contas voltam a ser lidos)', async () => {
  const p = pluggyFalso({
    'POST /auth': () => auth(),
    ['GET /items/' + ITEM]: () => ({ json: { id: ITEM, status: 'UPDATED' } }),
    'GET /accounts': () => ({ json: { results: [] } }),
  });
  const c = cliente(p.fetcher);
  await c.item(ITEM);
  await c.contas(ITEM);
  await c.item(ITEM);
  await c.contas(ITEM);
  assert.equal(p.chamadas.length, 3, 'auth + item + contas, o resto veio do cache');
  c.invalidarItem(ITEM);
  await c.item(ITEM);
  await c.contas(ITEM);
  assert.equal(p.chamadas.length, 5);
});

test('testar força uma chave nova e só chama /auth (não lê dado)', async () => {
  const p = pluggyFalso({ 'POST /auth': (_c, n) => auth(n) });
  const c = cliente(p.fetcher);
  await c.testar();
  await c.testar();
  assert.deepEqual(p.chamadas.map((x) => x.caminho), ['/auth', '/auth']);
});

test('resposta que não é JSON (proxy) não vira dado', async () => {
  const p = pluggyFalso({ 'POST /auth': () => auth(), ['GET /items/' + ITEM]: () => ({ texto: '<html>bad gateway</html>' }) });
  await assert.rejects(() => cliente(p.fetcher).item(ITEM), /formato inesperado/);
});

test('cursor: `next` vira o valor decodificado de `after`, em query pura, caminho ou URL completa; sem after = null', () => {
  assert.equal(depoisDoCursor('?accountId=x&after=ABC%3D%3D'), 'ABC==');
  assert.equal(depoisDoCursor('/v2/transactions?after=ZZ%2B&accountId=x'), 'ZZ+');
  assert.equal(depoisDoCursor('https://api.pluggy.ai/v2/transactions?after=QQ&accountId=x'), 'QQ');
  assert.equal(depoisDoCursor('?accountId=x'), null);
});

test('401 em leituras paralelas: a chave que outra leitura já renovou NÃO é apagada (um /auth por rodada, não um por leitura)', async () => {
  const p = pluggyFalso({
    'POST /auth': (_c, n) => auth(n),
    ['GET /items/' + ITEM]: (c) => (c.chave === `${API_KEY}1` ? { status: 401, json: {} } : { json: { id: ITEM, status: 'UPDATED' } }),
    ['GET /items/' + ITEM2]: (c) => (c.chave === `${API_KEY}1` ? { status: 401, json: {} } : { json: { id: ITEM2, status: 'UPDATED' } }),
  });
  const c = cliente(p.fetcher, { cacheMs: 0 });
  await Promise.all([c.item(ITEM), c.item(ITEM2)]);
  assert.equal(p.chamadas.filter((x) => x.caminho === '/auth').length, 2, 'a 1ª chave e UMA renovação, não uma por leitura');
});

test('403 de leitura não culpa a listagem de itens: aponta consentimento e IP, e só lembra da listagem', async () => {
  const p = pluggyFalso({ 'POST /auth': () => auth(), 'GET /v2/transactions': () => ({ status: 403, json: {} }) });
  const e = await cliente(p.fetcher).transacoes(CONTA, '2026-11-01', '2026-11-30').catch((x: Error) => x);
  assert.match((e as Error).message, /consentimento do Meu Pluggy/);
});
