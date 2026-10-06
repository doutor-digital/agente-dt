/**
 * O conector remoto de ponta a ponta, como o claude.ai faz: descobre os metadados, registra o
 * cliente, abre a tela de login, troca o código por token com PKCE e chama o /mcp. E os ataques
 * que ele tem que barrar: código reusado, renovação reusada, retorno pra site de fora, login de
 * quem não é diretoria, força bruta, usuário desativado.
 *
 * Tudo local: Express numa porta aleatória, armazém em memória, franquia falsa.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type FranquiaFalsa, subirFranquiaFalsa } from '../franquia-mcp/franquia-falsa.js';
import type { Unidade } from '../franquia-mcp/unidade.js';
import { armazemEmMemoria } from './armazem.js';
import { BuscadorCimd } from './cimd.js';
import type { Usuario } from './provedor.js';
import { hash } from './provedor.js';
import { montarConectorRemoto } from './servidor.js';

const TOKEN_FRANQUIA = 'token-franquia-serra-0123456789abcdef';
const RETORNO = 'http://127.0.0.1:9999/callback';

const usuarios = new Map<string, Usuario & { senha: string }>([
  ['diretora@dd.com', { id: 'u1', email: 'diretora@dd.com', nome: 'Diretora', papel: 'SUPER_ADMIN', ativo: true, senha: 'senha-certa-123' }],
  ['unidade@dd.com', { id: 'u2', email: 'unidade@dd.com', nome: 'Recepção', papel: 'UNIT_ADMIN', ativo: true, senha: 'senha-certa-123' }],
]);

const armazem = armazemEmMemoria();
let falsa: FranquiaFalsa;
let http: Server;
let base: string;
let parar: () => void;

/** "claude.ai" publica o documento de cliente (CIMD) aqui. */
const DOC_CIMD = 'https://claude.ai/oauth/mcp-client-metadata.json';
const buscarDocFalso = (async (url: string | URL) => {
  if (String(url) === DOC_CIMD) {
    return new Response(JSON.stringify({ client_id: DOC_CIMD, client_name: 'Claude', redirect_uris: [RETORNO] }), { status: 200 });
  }
  return new Response('não', { status: 404 });
}) as typeof fetch;

before(async () => {
  falsa = await subirFranquiaFalsa({
    [TOKEN_FRANQUIA]: { agendamentos: [{ idSchedule: 1, clientName: 'Ana', dateAttendance: '2026-06-10T13:00:00Z', statusName: 'Atendido' }] },
  });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const unidades = new Map<string, Unidade>([['serra', { slug: 'serra', nome: 'Serra', token: TOKEN_FRANQUIA, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]]);
  const r = await montarConectorRemoto(app, {
    urlPublica: new URL(base),
    armazem,
    segredo: 'segredo-de-teste-com-mais-de-32-caracteres',
    hostsConfiaveis: ['claude.ai', 'claude.com'],
    autenticar: async (email, senha) => {
      const u = usuarios.get(email);
      if (!u || u.senha !== senha) throw new Error('credenciais');
      return u;
    },
    buscarUsuario: async (id) => [...usuarios.values()].find((u) => u.id === id) ?? null,
    carregarUnidades: async () => unidades,
    franquia: { intervaloMs: 0, cliente: { log: () => {} } },
    cimd: new BuscadorCimd(['claude.ai', 'claude.com'], buscarDocFalso),
  });
  parar = r.parar;
});

after(async () => {
  parar();
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
  await falsa.fechar();
});

// ── ajudantes: o que o claude.ai faz ──

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registrar(redirect = RETORNO): Promise<Response> {
  return fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
  });
}

async function abrirLogin(clientId: string, challenge: string) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: RETORNO,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'estado-123',
    resource: `${base}/mcp`,
  });
  const r = await fetch(`${base}/authorize?${q}`, { redirect: 'manual' });
  const html = await r.text();
  const pedido = /name="pedido" value="([^"]+)"/.exec(html)?.[1];
  return { r, html, pedido };
}

async function entrar(pedido: string, email: string, senha: string): Promise<Response> {
  return fetch(`${base}/oauth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pedido, email, senha }),
    redirect: 'manual',
  });
}

async function token(corpo: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(corpo) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** O fluxo inteiro, até ter os tokens. */
async function conectar(clientId?: string) {
  const id = clientId ?? ((await (await registrar()).json()) as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  const { pedido } = await abrirLogin(id, challenge);
  const r = await entrar(pedido!, 'diretora@dd.com', 'senha-certa-123');
  const code = new URL(r.headers.get('location')!).searchParams.get('code')!;
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: RETORNO, client_id: id, code_verifier: verifier, resource: `${base}/mcp` });
  return { clientId: id, code, verifier, ...t };
}

async function clienteMcp(acesso: string): Promise<Client> {
  const c = new Client({ name: 'teste', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${acesso}` } } }));
  return c;
}

// ── o caminho feliz ──

test('metadados: recurso aponta pro servidor de autorização, que anuncia PKCE S256, DCR e CIMD', async () => {
  const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  assert.equal(prm.resource, `${base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [`${base}/`]);
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.equal(as.client_id_metadata_document_supported, true);
});

test('sem token, /mcp responde 401 apontando os metadados (é assim que o claude.ai descobre o login)', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('tela de login: mostra o destino, não entra em iframe, CSP libera a volta pro retorno', async () => {
  const id = ((await (await registrar()).json()) as { client_id: string }).client_id;
  const { r, html, pedido } = await abrirLogin(id, pkce().challenge);
  assert.equal(r.status, 200);
  assert.ok(pedido);
  assert.match(html, /entregue a <strong>127\.0\.0\.1:9999<\/strong>/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') ?? '', /form-action 'self' http:\/\/127\.0\.0\.1:9999;.*frame-ancestors 'none'/);
});

test('fluxo completo: login → código → token com PKCE → ferramentas da franquia → auditoria', async () => {
  const c = await conectar();
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.match(String(c.json.access_token), /^dda_/);
  assert.match(String(c.json.refresh_token), /^ddr_/);
  assert.equal(c.json.expires_in, 3600);

  const mcp = await clienteMcp(String(c.json.access_token));
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 11);
  const r = await mcp.callTool({ name: 'buscar_agendamentos', arguments: { unidade: 'serra', inicio: '2026-06-01', fim: '2026-06-30' } });
  const corpo = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
  assert.equal(corpo.porUnidade.serra.total, 1);
  await mcp.close();

  const ultimo = armazem.auditoria.at(-1)!;
  assert.equal(ultimo.ferramenta, 'buscar_agendamentos');
  assert.equal(ultimo.userId, 'u1');
  assert.equal(ultimo.clientId, c.clientId);
  assert.equal(ultimo.ok, true);
});

test('tokens ficam só como hash no banco', async () => {
  const c = await conectar();
  const acesso = String(c.json.access_token);
  assert.equal(armazem.tokens.has(acesso), false);
  assert.equal(armazem.tokens.has(hash(acesso)), true);
});

test('CIMD: client_id que é a URL do documento publicado pelo claude.ai funciona sem registro', async () => {
  const c = await conectar(DOC_CIMD);
  assert.equal(c.status, 200, JSON.stringify(c.json));
});

// ── os ataques ──

test('registro com retorno pra site de fora é recusado (golpe do link de login)', async () => {
  for (const ruim of ['https://evil.com/cb', 'https://claude.ai.evil.com/cb', 'http://claude.ai/cb', 'javascript:alert(1)']) {
    const r = await registrar(ruim);
    assert.equal(r.status, 400, ruim);
  }
  assert.equal((await registrar('https://claude.ai/api/mcp/auth_callback')).status, 201);
});

test('CIMD de host não confiável é cliente inválido', async () => {
  const { r } = await abrirLogin('https://evil.com/client.json', pkce().challenge);
  assert.equal(r.status, 400);
});

test('PKCE: verifier errado não troca o código', async () => {
  const id = ((await (await registrar()).json()) as { client_id: string }).client_id;
  const { challenge } = pkce();
  const { pedido } = await abrirLogin(id, challenge);
  const code = new URL((await entrar(pedido!, 'diretora@dd.com', 'senha-certa-123')).headers.get('location')!).searchParams.get('code')!;
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: RETORNO, client_id: id, code_verifier: pkce().verifier });
  assert.equal(t.status, 400);
  assert.equal(t.json.error, 'invalid_grant');
});

test('código usado duas vezes: a 2ª falha e derruba o token da 1ª', async () => {
  const c = await conectar();
  const de_novo = await token({ grant_type: 'authorization_code', code: c.code, redirect_uri: RETORNO, client_id: c.clientId, code_verifier: c.verifier });
  assert.equal(de_novo.status, 400);
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${c.json.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('renovação: troca o par; reusar a antiga derruba a concessão inteira', async () => {
  const c = await conectar();
  const nova = await token({ grant_type: 'refresh_token', refresh_token: String(c.json.refresh_token), client_id: c.clientId });
  assert.equal(nova.status, 200, JSON.stringify(nova.json));
  assert.notEqual(nova.json.access_token, c.json.access_token);

  const reuso = await token({ grant_type: 'refresh_token', refresh_token: String(c.json.refresh_token), client_id: c.clientId });
  assert.equal(reuso.status, 400);
  // o par novo também caiu: quem tinha a cópia não continua
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${nova.json.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('quem não é SUPER_ADMIN não recebe código', async () => {
  const id = ((await (await registrar()).json()) as { client_id: string }).client_id;
  const { pedido } = await abrirLogin(id, pkce().challenge);
  const r = await entrar(pedido!, 'unidade@dd.com', 'senha-certa-123');
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('location'), null);
  assert.match(await r.text(), /só para a diretoria/);
});

test('senha errada: mensagem genérica, e 8 erros travam o e-mail', async () => {
  const id = ((await (await registrar()).json()) as { client_id: string }).client_id;
  const { pedido } = await abrirLogin(id, pkce().challenge);
  const primeira = await entrar(pedido!, 'alvo@dd.com', 'errada');
  assert.equal(primeira.status, 401);
  assert.match(await primeira.text(), /E-mail ou senha incorretos/);
  for (let i = 0; i < 7; i++) await entrar(pedido!, 'alvo@dd.com', 'errada');
  const travado = await entrar(pedido!, 'alvo@dd.com', 'errada');
  assert.equal(travado.status, 429);
});

test('pedido de login adulterado não passa', async () => {
  const id = ((await (await registrar()).json()) as { client_id: string }).client_id;
  const { pedido } = await abrirLogin(id, pkce().challenge);
  const r = await entrar(`${pedido!.slice(0, -4)}AAAA`, 'diretora@dd.com', 'senha-certa-123');
  assert.equal(r.status, 400);
  assert.match(await r.text(), /venceu/);
});

test('usuário desativado perde o acesso na hora, sem esperar o token vencer', async () => {
  usuarios.set('temp@dd.com', { id: 'u3', email: 'temp@dd.com', nome: null, papel: 'SUPER_ADMIN', ativo: true, senha: 'senha-certa-123' });
  const id = ((await (await registrar()).json()) as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  const { pedido } = await abrirLogin(id, challenge);
  const code = new URL((await entrar(pedido!, 'temp@dd.com', 'senha-certa-123')).headers.get('location')!).searchParams.get('code')!;
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: RETORNO, client_id: id, code_verifier: verifier });
  const chamar = () =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.json.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  assert.notEqual((await chamar()).status, 401);
  usuarios.get('temp@dd.com')!.ativo = false;
  assert.equal((await chamar()).status, 401);
});

test('revogar pelo /revoke corta o acesso', async () => {
  const c = await conectar();
  const r = await fetch(`${base}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: String(c.json.refresh_token), client_id: c.clientId }),
  });
  assert.equal(r.status, 200);
  const depois = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${c.json.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(depois.status, 401);
});

test('GET /mcp é 405 (servidor sem sessão)', async () => {
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
});
