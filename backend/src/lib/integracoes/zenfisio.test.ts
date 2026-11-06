import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esquecerTokensZenfisio, lerConfigZenfisio, testarChaveZenfisio, tokenZenfisio, zenfisioGet, type ConfigZenfisio } from './zenfisio.js';

const SEGREDO = 'segredo-super-sigiloso-123';
const SENHA = 'Senha Com Espaco!';
const EMAIL = 'login.privado@clinica.com';
const CFG: ConfigZenfisio = { clientId: '105', clientSecret: SEGREDO, email: EMAIL, senha: SENHA, entityId: 42739 };
const CHAVE = JSON.stringify({ clientId: '105', clientSecret: SEGREDO, email: EMAIL, senha: SENHA, entityId: 42739 });

const json = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

interface Pedido {
  url: string;
  metodo: string;
  corpo?: string;
  auth?: string | null;
}

/** ZenFisio falso: login + rotas. `rotas` decide a resposta de cada GET. */
function zenfisioFalso(rotas: (url: URL, n: number) => Response, login?: (corpo: Record<string, unknown>) => Response) {
  const pedidos: Pedido[] = [];
  let tokenAtual = 0;
  let gets = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    pedidos.push({ url: url.toString(), metodo: init?.method ?? 'GET', corpo: init?.body as string | undefined, auth: headers.get('authorization') });
    if (url.pathname === '/oauth/token') {
      const corpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (login) return login(corpo);
      tokenAtual++;
      return json(200, { token_type: 'Bearer', expires_in: 86400, access_token: `tok-${tokenAtual}`, refresh_token: 'r' });
    }
    return rotas(url, ++gets);
  }) as typeof fetch;
  return { fetcher, pedidos };
}

test('lerConfigZenfisio: aceita o JSON completo e não faz trim da senha', () => {
  const cfg = lerConfigZenfisio(CHAVE);
  assert.deepEqual(cfg, CFG);
  assert.equal(lerConfigZenfisio(JSON.stringify({ clientId: 105, clientSecret: SEGREDO, email: EMAIL, senha: SENHA })).entityId, undefined);
});

test('lerConfigZenfisio: recusa o que falta sem repetir o que foi colado', () => {
  assert.throws(() => lerConfigZenfisio('não é json ' + SEGREDO), (e: Error) => !e.message.includes(SEGREDO));
  assert.throws(() => lerConfigZenfisio(JSON.stringify({ clientSecret: SEGREDO, email: EMAIL, senha: SENHA })), /clientId/);
  assert.throws(() => lerConfigZenfisio(JSON.stringify({ clientId: '1', clientSecret: 'curto', email: EMAIL, senha: SENHA })), /clientSecret/);
  assert.throws(() => lerConfigZenfisio(JSON.stringify({ clientId: '1', clientSecret: SEGREDO, email: 'sem-arroba', senha: SENHA })), /email/);
  assert.throws(() => lerConfigZenfisio(JSON.stringify({ clientId: '1', clientSecret: SEGREDO, email: EMAIL, senha: '' })), /senha/);
  assert.throws(() => lerConfigZenfisio(JSON.stringify({ clientId: '1', clientSecret: SEGREDO, email: EMAIL, senha: SENHA, entityId: 'abc' })), /entityId/);
});

test('login manda grant password com as quatro credenciais e guarda o token', async () => {
  esquecerTokensZenfisio();
  const { fetcher, pedidos } = zenfisioFalso(() => json(200, []));
  const t1 = await tokenZenfisio('c1', CFG, fetcher);
  const t2 = await tokenZenfisio('c1', CFG, fetcher);
  assert.equal(t1, 'tok-1');
  assert.equal(t2, 'tok-1');
  assert.equal(pedidos.length, 1, 'o segundo pedido usou o token guardado');
  assert.deepEqual(JSON.parse(pedidos[0]!.corpo!), { grant_type: 'password', client_id: '105', client_secret: SEGREDO, username: EMAIL, password: SENHA });
});

test('token vencendo (5 min antes) é pedido de novo', async () => {
  esquecerTokensZenfisio();
  let agora = 0;
  const { fetcher } = zenfisioFalso(() => json(200, []));
  assert.equal(await tokenZenfisio('c2', CFG, fetcher, () => agora), 'tok-1');
  agora = (86400 - 300) * 1000 + 1;
  assert.equal(await tokenZenfisio('c2', CFG, fetcher, () => agora), 'tok-2');
});

test('invalid_credentials vira mensagem clara sobre e-mail/senha, sem vazar nada', async () => {
  esquecerTokensZenfisio();
  const { fetcher } = zenfisioFalso(
    () => json(200, []),
    () => json(400, { error: 'invalid_credentials', error_description: 'The user credentials were incorrect.' }),
  );
  await assert.rejects(tokenZenfisio('c3', CFG, fetcher), (e: Error) => {
    assert.match(e.message, /e-mail ou a senha/);
    for (const s of [SEGREDO, SENHA, EMAIL]) assert.ok(!e.message.includes(s));
    return true;
  });
});

test('invalid_client aponta para o Client ID/Secret', async () => {
  esquecerTokensZenfisio();
  const { fetcher } = zenfisioFalso(() => json(200, []), () => json(401, { error: 'invalid_client' }));
  await assert.rejects(tokenZenfisio('c4', CFG, fetcher), /Client ID\/Client Secret/);
});

test('zenfisioGet: Bearer, /api/v1 e query; 401 no meio refaz o login uma vez', async () => {
  esquecerTokensZenfisio();
  const { fetcher, pedidos } = zenfisioFalso((url, n) => (n === 1 ? json(401, { message: 'Unauthenticated.' }) : json(200, { ok: url.searchParams.get('page') })));
  const r = await zenfisioGet<{ ok: string }>('c5', CFG, '/entity/42739/appointments', { page: 2, vazio: '', nada: undefined }, fetcher);
  assert.deepEqual(r, { ok: '2' });
  const gets = pedidos.filter((p) => p.metodo === 'GET');
  assert.equal(gets.length, 2);
  assert.equal(gets[0]!.auth, 'Bearer tok-1');
  assert.equal(gets[1]!.auth, 'Bearer tok-2');
  assert.equal(gets[1]!.url, 'https://app.zenfisio.com/api/v1/entity/42739/appointments?page=2');
});

test('zenfisioGet: 401 depois do relogin é erro; 422 traz a mensagem da API', async () => {
  esquecerTokensZenfisio();
  const sempre401 = zenfisioFalso(() => json(401, {}));
  await assert.rejects(zenfisioGet('c6', CFG, '/units', {}, sempre401.fetcher), /novo login \(401\)/);
  esquecerTokensZenfisio();
  const validacao = zenfisioFalso(() => json(422, { message: 'Erro de validação', errors: { start_date: ['obrigatório'] } }));
  await assert.rejects(zenfisioGet('c7', CFG, '/appointments', {}, validacao.fetcher), /recusou os parâmetros.*Erro de validação/);
});

test('testarChaveZenfisio: confere o entityId nas unidades e devolve o rótulo', async () => {
  esquecerTokensZenfisio();
  const unidades = [{ id: 42739, name: 'Instituto Trauma', document: '54.561.185/0001-32', email: 'x@y.com', is_main_entity: 1 }];
  const { fetcher } = zenfisioFalso(() => json(200, unidades));
  const rotulo = await testarChaveZenfisio(CHAVE, fetcher);
  assert.equal(rotulo, 'ZenFisio · Instituto Trauma (entityId 42739)');
  assert.ok(!rotulo.includes('54.561'), 'CNPJ da unidade não vai para o painel');

  const outra = JSON.stringify({ ...JSON.parse(CHAVE), entityId: 1 });
  await assert.rejects(testarChaveZenfisio(outra, fetcher), /entityId 1 não é uma unidade desta conta.*42739/);
});

test('testarChaveZenfisio: sem entityId funciona com uma unidade e pede o id com várias', async () => {
  esquecerTokensZenfisio();
  const sem = JSON.stringify({ clientId: '105', clientSecret: SEGREDO, email: EMAIL, senha: SENHA });
  const uma = zenfisioFalso(() => json(200, [{ id: 9, name: 'Única' }]));
  assert.equal(await testarChaveZenfisio(sem, uma.fetcher), 'ZenFisio · Única (entityId 9)');
  const duas = zenfisioFalso(() => json(200, [{ id: 9, name: 'A' }, { id: 10, name: 'B' }]));
  await assert.rejects(testarChaveZenfisio(sem, duas.fetcher), /ponha "entityId"/);
});
