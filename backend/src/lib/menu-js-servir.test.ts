/**
 * `GET /funil/menu.js` pela rede: comprimido (br/gzip) quando o navegador aceita, ETag forte e 304, cache com revalidação por trás — e o CONTEÚDO
 * que chega (depois de descomprimir) é exatamente o de `montarMenuJs`. Servidor Express de verdade, o handler de verdade, pedido HTTP de verdade.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import express from 'express';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/x';
process.env.SESSION_JWT_SECRET ??= 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
process.env.CHATWOOT_API_TOKEN = 'token-da-conta';
process.env.CHATWOOT_CONTA_ID = '1';
process.env.CHATWOOT_URL = 'https://chatwoot.exemplo.test';

const { prisma } = await import('./prisma.js');
Object.defineProperty(prisma, 'unitChatwoot', { value: { findMany: async () => [] }, configurable: true });
const { _esquecerCacheDoGuia } = await import('./guia-sem-antecipado.js');
const { menuFunilHandler, montarMenuJs } = await import('../controllers/funil.controller.js');
const { dominiosDasClinicas } = await import('./chatwoot-unidades.js');
const { contaChatwootDoAmbiente } = await import('../mcp-remoto/chatwoot.js');
const { CACHE_DO_MENU_JS, escolherCodificacao, prepararMenuJs, _esquecerMenuJsPronto } = await import('./menu-js-servir.js');

let servidor: http.Server;
let porta = 0;
before(async () => {
  _esquecerCacheDoGuia();
  _esquecerMenuJsPronto();
  const app = express();
  // o mesmo `Vary: Origin` que o CORS do servidor põe antes da rota
  app.use((_req, res, next) => { res.vary('Origin'); next(); });
  app.get('/funil/menu.js', menuFunilHandler);
  servidor = await new Promise<http.Server>((ok) => { const s = app.listen(0, () => ok(s)); });
  porta = (servidor.address() as AddressInfo).port;
});
after(() => { servidor.close(); });

interface Resposta { status: number; headers: http.IncomingHttpHeaders; corpo: Buffer }
// http cru: nada descomprime sozinho, então dá para ver os bytes que vão pela rede
const pedir = (headers: Record<string, string> = {}, metodo = 'GET'): Promise<Resposta> =>
  new Promise((ok, falha) => {
    const rq = http.request({ host: '127.0.0.1', port: porta, path: '/funil/menu.js', method: metodo, headers }, (r) => {
      const partes: Buffer[] = [];
      r.on('data', (d: Buffer) => partes.push(d));
      r.on('end', () => ok({ status: r.statusCode ?? 0, headers: r.headers, corpo: Buffer.concat(partes) }));
    });
    rq.on('error', falha);
    rq.end();
  });

const esperado = (): string => montarMenuJs('https://agente-vps.doutordigitalconsultoria.com', [], dominiosDasClinicas(contaChatwootDoAmbiente()?.conta ?? null));
const texto = (r: Resposta): string => {
  const e = r.headers['content-encoding'];
  const bytes = e === 'br' ? brotliDecompressSync(r.corpo) : e === 'gzip' ? gunzipSync(r.corpo) : r.corpo;
  return bytes.toString('utf8');
};

test('escolherCodificacao: br se aceita, senão gzip, senão nada; respeita q=0 e o curinga', () => {
  assert.equal(escolherCodificacao(undefined), 'identity');
  assert.equal(escolherCodificacao(''), 'identity');
  assert.equal(escolherCodificacao('identity'), 'identity');
  assert.equal(escolherCodificacao('gzip, deflate, br, zstd'), 'br');
  assert.equal(escolherCodificacao('gzip, deflate'), 'gzip');
  assert.equal(escolherCodificacao('GZIP'), 'gzip');
  assert.equal(escolherCodificacao('gzip;q=1.0, br;q=0.5'), 'gzip');
  assert.equal(escolherCodificacao('br;q=0, gzip'), 'gzip');
  assert.equal(escolherCodificacao('gzip;q=0, br;q=0'), 'identity');
  assert.equal(escolherCodificacao('*'), 'br');
  assert.equal(escolherCodificacao('gzip;q=0, *'), 'br');
  assert.equal(escolherCodificacao('deflate'), 'identity');
});

test('com Accept-Encoding o menu.js vai comprimido e MUITO menor; descomprimido é byte a byte o de montarMenuJs', async () => {
  const bruto = await pedir();
  assert.equal(bruto.status, 200);
  assert.equal(bruto.headers['content-encoding'], undefined, 'sem Accept-Encoding, sem compressão (como era)');
  assert.equal(bruto.corpo.toString('utf8'), esperado());
  assert.match(String(bruto.headers['content-type']), /^application\/javascript; charset=utf-8$/);

  const gz = await pedir({ 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(texto(gz), esperado());
  assert.ok(gz.corpo.length < bruto.corpo.length * 0.4, `gzip ${gz.corpo.length} de ${bruto.corpo.length}`);

  const br = await pedir({ 'accept-encoding': 'gzip, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(texto(br), esperado());
  assert.ok(br.corpo.length < gz.corpo.length, `br ${br.corpo.length} não é menor que gzip ${gz.corpo.length}`);
  assert.equal(Number(br.headers['content-length']), br.corpo.length);
});

test('cabeçalhos: cache com revalidação por trás, CORP, Vary com Origin E Accept-Encoding, ETag FORTE e diferente por codificação', async () => {
  const [a, g, b] = [await pedir(), await pedir({ 'accept-encoding': 'gzip' }), await pedir({ 'accept-encoding': 'br' })];
  for (const r of [a, g, b]) {
    assert.equal(r.headers['cache-control'], CACHE_DO_MENU_JS);
    assert.match(CACHE_DO_MENU_JS, /max-age=300, stale-while-revalidate=\d+/);
    assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(String(r.headers.vary), /Origin/);
    assert.match(String(r.headers.vary), /Accept-Encoding/);
    assert.match(String(r.headers.etag), /^"[A-Za-z0-9_-]+(-gzip|-br)?"$/, 'ETag forte (sem W/)');
  }
  assert.equal(new Set([a.headers.etag, g.headers.etag, b.headers.etag]).size, 3, 'bytes diferentes, ETags diferentes');
  // estável entre pedidos (o navegador consegue revalidar)
  assert.equal((await pedir({ 'accept-encoding': 'br' })).headers.etag, b.headers.etag);
});

test('If-None-Match com o ETag certo = 304 sem corpo; com outro ETag (ou o de outra codificação) = 200', async () => {
  for (const enc of ['', 'gzip', 'br']) {
    const h: Record<string, string> = enc ? { 'accept-encoding': enc } : {};
    const primeira = await pedir(h);
    const etag = String(primeira.headers.etag);
    const igual = await pedir({ ...h, 'if-none-match': etag });
    assert.equal(igual.status, 304, `304 com ${enc || 'identity'}`);
    assert.equal(igual.corpo.length, 0);
    assert.equal(igual.headers.etag, etag);
    assert.equal((await pedir({ ...h, 'if-none-match': `W/${etag}` })).status, 304, 'comparação fraca também vale para GET');
    assert.equal((await pedir({ ...h, 'if-none-match': '"outro"' })).status, 200);
  }
  const gz = String((await pedir({ 'accept-encoding': 'gzip' })).headers.etag);
  assert.equal((await pedir({ 'accept-encoding': 'br', 'if-none-match': gz })).status, 200, 'o ETag do gzip não vale para o br');
  assert.equal((await pedir({ 'accept-encoding': 'gzip', 'if-none-match': `"x", ${gz}` })).status, 304, 'lista de ETags');
});

test('HEAD sai com os mesmos cabeçalhos e sem corpo', async () => {
  const h = await pedir({ 'accept-encoding': 'br' }, 'HEAD');
  assert.equal(h.status, 200);
  assert.equal(h.corpo.length, 0);
  assert.equal(h.headers['content-encoding'], 'br');
});

test('conteúdo novo (a lista de contas ou o mapa de domínios mudou) = hash novo e bytes novos; o mesmo texto reaproveita o preparo (uma só compressão)', async () => {
  const a = prepararMenuJs('console.log(1);');
  assert.equal(prepararMenuJs('console.log(1);'), a, 'mesmo texto, mesma promessa');
  const b = prepararMenuJs('console.log(2);');
  assert.notEqual(b, a);
  const [pa, pb] = [await a, await b];
  assert.notEqual(pa.hash, pb.hash);
  assert.equal(gunzipSync(pb.bytes.gzip).toString(), 'console.log(2);');
  assert.equal(brotliDecompressSync(pb.bytes.br).toString(), 'console.log(2);');
  assert.equal(pb.bytes.identity.toString(), 'console.log(2);');
});
