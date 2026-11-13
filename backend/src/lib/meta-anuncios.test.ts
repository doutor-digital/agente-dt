/**
 * Gasto da conta de anúncios (Graph): o token vai no cabeçalho (nunca na URL), a paginação só segue link do próprio Graph,
 * erro da Meta vira motivo legível, e o resultado fica em cache.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gastoDaConta, gastoDiarioDaConta, limparCacheDeAnuncios } from './meta-anuncios.js';

type Chamada = { url: string; headers: Record<string, string> };
function falso(respostas: Array<{ ok?: boolean; status?: number; corpo: unknown }>) {
  const chamadas: Chamada[] = [];
  let i = 0;
  const buscar = async (url: string, init: { headers: Record<string, string> }) => {
    chamadas.push({ url, headers: init.headers });
    const r = respostas[Math.min(i++, respostas.length - 1)]!;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.corpo };
  };
  return { buscar, chamadas };
}
const linha = (ad: string, camp: string, spend: string) => ({ ad_id: ad, ad_name: `Anúncio ${ad}`, campaign_id: camp, campaign_name: `Campanha ${camp}`, spend, account_currency: 'BRL' });

test('lê o gasto por anúncio, soma o total e manda o token só no cabeçalho', async () => {
  limparCacheDeAnuncios();
  const f = falso([{ corpo: { data: [linha('111', '9001', '100.50'), linha('112', '9001', '20'), linha('113', '9002', 'x')] } }]);
  const r = await gastoDaConta('12345678', 'segredo-do-token', '2026-11-01', '2026-11-13', f.buscar as any);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.linhas.length, 2); // «x» não é número: descarta
  assert.equal(r.total, 120.5);
  assert.equal(r.moeda, 'BRL');
  assert.equal(f.chamadas[0]!.headers.Authorization, 'Bearer segredo-do-token');
  assert.ok(!f.chamadas[0]!.url.includes('segredo-do-token'));
  assert.match(f.chamadas[0]!.url, /act_12345678\/insights/);
  assert.match(decodeURIComponent(f.chamadas[0]!.url), /"since":"2026-11-01","until":"2026-11-13"/);
});

test('cache: o mesmo pedido não vai de novo à Meta', async () => {
  limparCacheDeAnuncios();
  const f = falso([{ corpo: { data: [linha('111', '9001', '10')] } }]);
  await gastoDaConta('12345678', 't', '2026-11-01', '2026-11-13', f.buscar as any);
  await gastoDaConta('12345678', 't', '2026-11-01', '2026-11-13', f.buscar as any);
  assert.equal(f.chamadas.length, 1);
  await gastoDaConta('12345678', 't', '2026-11-02', '2026-11-13', f.buscar as any);
  assert.equal(f.chamadas.length, 2);
});

test('paginação: segue o próximo link do Graph, e só dele', async () => {
  limparCacheDeAnuncios();
  const f = falso([
    { corpo: { data: [linha('111', '9001', '10')], paging: { next: 'https://graph.facebook.com/v23.0/act_1/insights?after=abc' } } },
    { corpo: { data: [linha('112', '9001', '5')], paging: { next: 'https://site-malicioso.example/roubar-token' } } },
  ]);
  const r = await gastoDaConta('12345678', 't', '2026-11-01', '2026-11-13', f.buscar as any);
  assert.ok(r.ok);
  assert.equal(f.chamadas.length, 2); // não foi ao site malicioso
  if (r.ok) {
    assert.equal(r.total, 15);
    assert.equal(r.parcial, false);
  }
});

test('leitura que passa do limite de páginas avisa que o total pode estar abaixo do real', async () => {
  limparCacheDeAnuncios();
  const sempre = { corpo: { data: [linha('111', '9001', '1')], paging: { next: 'https://graph.facebook.com/v23.0/act_1/insights?after=mais' } } };
  const f = falso([sempre]);
  const r = await gastoDaConta('12345678', 't', '2026-11-01', '2026-11-13', f.buscar as any);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.parcial, true);
  assert.equal(f.chamadas.length, 8);
});

test('erro da Meta vira motivo legível, sem vazar o token', async () => {
  limparCacheDeAnuncios();
  const f = falso([{ ok: false, status: 400, corpo: { error: { code: 190, message: 'Invalid OAuth access token segredo' } } }]);
  const r = await gastoDaConta('12345678', 'segredo', '2026-11-01', '2026-11-13', f.buscar as any);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.motivo, /recusou o token/);
    assert.ok(!r.motivo.includes('segredo'));
  }
  limparCacheDeAnuncios();
  const f2 = falso([{ ok: false, status: 502, corpo: null }]);
  const r2 = await gastoDaConta('12345678', 't', '2026-11-01', '2026-11-13', f2.buscar as any);
  assert.equal(r2.ok, false);
  const queda = async () => { throw new Error('rede caiu com t'); };
  limparCacheDeAnuncios();
  const r3 = await gastoDaConta('12345678', 't', '2026-11-01', '2026-11-13', queda as any);
  assert.deepEqual(r3, { ok: false, motivo: 'não consegui falar com a Meta agora' });
});

test('gasto por dia (gráfico e período anterior)', async () => {
  limparCacheDeAnuncios();
  const f = falso([{ corpo: { data: [{ spend: '100', date_start: '2026-11-10' }, { spend: '50.5', date_start: '2026-11-11' }, { spend: 'lixo', date_start: '2026-11-12' }] } }]);
  const r = await gastoDiarioDaConta('12345678', 't', '2026-11-10', '2026-11-13', f.buscar as any);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.porDia, { '2026-11-10': 100, '2026-11-11': 50.5 });
    assert.equal(r.total, 150.5);
  }
  assert.match(decodeURIComponent(f.chamadas[0]!.url), /time_increment=1/);
  assert.match(f.chamadas[0]!.url, /level=account/);
});
