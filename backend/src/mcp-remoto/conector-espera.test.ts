/**
 * O pedido que DESISTE durante a espera. Em produção cada pedido HTTP monta um servidor MCP novo e, antes de montar as ferramentas, espera a 1ª carga das
 * listas (`aguardar`) e, para `tools/call`, uma vaga do semáforo. Se o cliente desiste nesse intervalo, os fechamentos (transporte, servidor, vaga) já têm de
 * estar registrados — senão a vaga pega depois do `close` nunca volta e o conector inteiro fica sem vaga.
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
import { montarConectorRemoto } from './servidor.js';

const RETORNO = 'http://127.0.0.1:9999/callback';
const DOC_CIMD = 'https://claude.ai/oauth/mcp-client-metadata.json';
const usuario: Usuario & { senha: string } = { id: 'u1', email: 'diretora@dd.com', nome: 'Diretora', papel: 'SUPER_ADMIN', ativo: true, senha: 'senha-certa-123' };
let falsa: FranquiaFalsa;
let http: Server;
let base: string;
let parar: () => void;
let liberar: () => void = () => undefined;
let esperando: Promise<void> = Promise.resolve();
const tentativas = { aguardou: 0 };
let fechados = 0;
let saiuDaEspera = 0;

before(async () => {
  falsa = await subirFranquiaFalsa({ 'token-franquia-serra-0123456789abcdef': { agendamentos: [] } });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  http = app.listen(0, '127.0.0.1');
  http.on('connection', (sock) => sock.on('close', () => void fechados++)); // o cliente que desiste fecha o soquete
  await new Promise((r) => http.once('listening', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const unidades = new Map<string, Unidade>([['serra', { slug: 'serra', nome: 'Serra', token: 'token-franquia-serra-0123456789abcdef', fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]]);
  const r = await montarConectorRemoto(app, {
    urlPublica: new URL(base),
    armazem: armazemEmMemoria(),
    segredo: 'segredo-de-teste-com-mais-de-32-caracteres',
    retornosPermitidos: [RETORNO],
    hostsCimd: ['claude.ai'],
    autenticar: async (email, senha) => {
      if (email !== usuario.email || senha !== usuario.senha) throw new Error('credenciais');
      return usuario;
    },
    buscarUsuario: async () => usuario,
    carregarUnidades: async () => unidades,
    franquia: { intervaloMs: 0, cliente: { log: () => {} } },
    cimd: new BuscadorCimd(['claude.ai'], (async (url: string | URL) => (String(url) === DOC_CIMD ? new Response(JSON.stringify({ client_id: DOC_CIMD, client_name: 'Claude', redirect_uris: [RETORNO] }), { status: 200 }) : new Response('não', { status: 404 }))) as typeof fetch),
    ferramentasSimultaneas: 1,
    // a espera de que o teste manda: enquanto `liberar` não for chamado, todo pedido fica parado aqui
    aguardar: () => {
      tentativas.aguardou++;
      return esperando.then(() => void saiuDaEspera++);
    },
  });
  parar = r.parar;
});
after(async () => {
  parar();
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
  await falsa.fechar();
});

async function acesso(): Promise<string> {
  const reg = (await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [RETORNO], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) })).json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: RETORNO, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'e', resource: `${base}/mcp` });
  const html = await (await fetch(`${base}/authorize?${q}`, { redirect: 'manual' })).text();
  const pedido = /name="pedido" value="([^"]+)"/.exec(html)![1]!;
  const r = await fetch(`${base}/oauth/entrar`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pedido, email: usuario.email, senha: usuario.senha }), redirect: 'manual' });
  const code = new URL(r.headers.get('location')!).searchParams.get('code')!;
  const t = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: RETORNO, client_id: reg.client_id, code_verifier: verifier, resource: `${base}/mcp` }) });
  return ((await t.json()) as { access_token: string }).access_token;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Espera uma CONDIÇÃO (não um tempo fixo): confere a cada 10 ms até o limite. */
async function ate(condicao: () => boolean, descricao: string, limiteMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!condicao()) {
    if (Date.now() - t0 > limiteMs) assert.fail(`condição não veio: ${descricao}`);
    await dormir(10);
  }
}

test('o cliente DESISTE durante a espera da 1ª carga: a vaga do semáforo (só 1) não vaza — o pedido seguinte passa', async () => {
  const token = await acesso();
  esperando = new Promise<void>((r) => (liberar = r)); // as ferramentas só são montadas quando o teste liberar
  // pedido A: tools/call (que pegaria a vaga), e o cliente desiste durante a espera
  const aborta = new AbortController();
  const a = fetch(`${base}/mcp`, {
    method: 'POST',
    signal: aborta.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'buscar_agendamentos', arguments: { unidade: 'serra', inicio: '2026-06-01', fim: '2026-06-30' } } }),
  }).catch(() => 'desistiu');
  await ate(() => tentativas.aguardou >= 1, 'o pedido A chegou na espera');
  aborta.abort();
  assert.equal(await a, 'desistiu');
  await ate(() => fechados >= 1, 'o servidor viu o cliente desistir (close)');
  liberar(); // a espera acaba; o pedido A (já fechado) segue o caminho e NÃO pode ficar com a vaga
  await ate(() => saiuDaEspera >= 1, 'o pedido A saiu da espera');
  await dormir(20); // um respiro para o pedido A terminar o que lhe resta (não há nada a esperar: não pega vaga)
  // pedido B: um cliente de verdade faz uma chamada de ferramenta; com a vaga vazada ela esperaria 60 s e daria 503
  const c = new Client({ name: 'teste', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const r = await Promise.race([c.callTool({ name: 'buscar_agendamentos', arguments: { unidade: 'serra', inicio: '2026-06-01', fim: '2026-06-30' } }), dormir(8000).then(() => 'preso')]);
  assert.notEqual(r, 'preso', 'a vaga do pedido que desistiu vazou: o conector ficou sem vaga');
  assert.notEqual((r as { isError?: boolean }).isError, true);
  await c.close();
  assert.ok(tentativas.aguardou >= 2);
});
