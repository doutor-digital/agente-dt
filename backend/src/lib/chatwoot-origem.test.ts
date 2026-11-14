/**
 * chatwoot-origem (refeito sobre o kapso-referral): só com anúncio comprovado; nunca «Orgânico»; relê o contato antes de gravar;
 * só campo vazio; seco não grava; erro da Meta vira log, token só no cabeçalho.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { decidirOrigem, limparCacheDaOrigem, nomesDoAnuncio, preencherOrigem, ORIGEM_ANUNCIO } = await import('./chatwoot-origem.js');
const { automacaoPorId, verificarCatalogo } = await import('./automacoes.js');

const REF = { anuncio: '120253955239410514', ctwaClid: 'Afd', tipo: 'ad', titulo: 'Dor?', url: null, quando: 1 };
const E = { slug: 'doutor-hernia-parauapebas', contato: 77, conversa: 900, ref: REF };

function portas(o: { estado?: 'desligado' | 'seco' | 'ligado'; contatos?: Array<Record<string, unknown>> } = {}) {
  const gravados: Array<[number, Record<string, string>]> = [];
  let leituras = 0;
  let buscas = 0;
  const lista = o.contatos ?? [{}];
  return {
    gravados,
    lidas: () => leituras,
    buscas: () => buscas,
    p: {
      estado: () => o.estado ?? 'ligado',
      contato: async () => lista[Math.min(leituras++, lista.length - 1)]!,
      nomes: async () => { buscas++; return { campanha: 'Campanha X', conjunto: 'Conjunto Y' }; },
      gravar: async (c: number, campos: Record<string, string>) => { gravados.push([c, campos]); },
    },
  };
}

test('catálogo: chatwoot-origem existe, tem seco, nasce desligado e não fala em «Orgânico» por dedução', () => {
  const a = automacaoPorId('chatwoot-origem');
  assert.ok(a && a.temSeco && a.quandoVazio === 'desligado');
  assert.ok(/não marca «Orgânico» por dedução/i.test(a!.oQueFaz));
  assert.deepEqual(verificarCatalogo(), []);
});

test('decidir: vazio → Meta Ads + nomes; origem manual diferente → não mexe; parcial → só o que falta', () => {
  const n = { campanha: 'C', conjunto: 'J' };
  assert.deepEqual(decidirOrigem({}, n), { origem: ORIGEM_ANUNCIO, campanha_nome: 'C', conjunto: 'J' });
  assert.deepEqual(decidirOrigem({}, null), { origem: ORIGEM_ANUNCIO });
  assert.equal(decidirOrigem({ origem: 'Indicação' }, n), null);
  assert.deepEqual(decidirOrigem({ origem: 'Meta Ads', campanha_nome: 'à mão' }, n), { conjunto: 'J' });
  assert.equal(decidirOrigem({ origem: 'Meta Ads', campanha_nome: 'a', conjunto: 'b' }, n), null);
});

test('preencher: desligado não lê nada; seco não grava; ligado grava; publicação (não anúncio) não chuta', async () => {
  const d = portas({ estado: 'desligado' });
  assert.equal(await preencherOrigem(E, d.p), 'desligado');
  assert.equal(d.lidas(), 0);
  const s = portas({ estado: 'seco' });
  assert.equal(await preencherOrigem(E, s.p), 'seco');
  assert.equal(s.gravados.length, 0);
  const l = portas();
  assert.equal(await preencherOrigem(E, l.p), 'gravado');
  assert.deepEqual(l.gravados, [[77, { origem: ORIGEM_ANUNCIO, campanha_nome: 'Campanha X', conjunto: 'Conjunto Y' }]]);
  const post = portas();
  assert.equal(await preencherOrigem({ ...E, ref: { ...REF, tipo: 'post', anuncio: null } }, post.p), 'nada');
  assert.equal(post.gravados.length, 0);
});

test('corrida: RELÊ o contato depois de ler a Meta — o que alguém preencheu nesse meio-tempo fica', async () => {
  // 1ª leitura vazia; enquanto a Meta respondia, outra mensagem (ou a menina) gravou origem e campanha
  const c = portas({ contatos: [{}, { origem: 'Meta Ads', campanha_nome: 'Escrita à mão' }] });
  assert.equal(await preencherOrigem(E, c.p), 'gravado');
  assert.deepEqual(c.gravados, [[77, { conjunto: 'Conjunto Y' }]]);
  assert.equal(c.lidas(), 2);
  // contato completo: nem pergunta à Meta
  const completo = portas({ contatos: [{ origem: 'Meta Ads', campanha_nome: 'a', conjunto: 'b' }] });
  assert.equal(await preencherOrigem(E, completo.p), 'nada');
  assert.equal(completo.buscas(), 0);
  // falha ao gravar não lança
  const f = portas();
  assert.equal(await preencherOrigem(E, { ...f.p, gravar: async () => { throw new Error('fora'); } }), 'nada');
});

test('nomes do anúncio: token só no cabeçalho, cache, recusa da Meta = null', async () => {
  limparCacheDaOrigem();
  const urls: string[] = [];
  const cab: string[] = [];
  const ok = (async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(url); cab.push(init.headers.Authorization!);
    return { ok: true, status: 200, json: async () => ({ campaign: { name: 'Campanha X' }, adset: { name: 'Conjunto Y' } }) };
  }) as any;
  assert.deepEqual(await nomesDoAnuncio('123456', 'segredo-xyz', ok), { campanha: 'Campanha X', conjunto: 'Conjunto Y' });
  await nomesDoAnuncio('123456', 'segredo-xyz', ok);
  assert.equal(urls.length, 1);
  assert.ok(!urls[0]!.includes('segredo-xyz') && cab[0] === 'Bearer segredo-xyz');
  limparCacheDaOrigem();
  assert.equal(await nomesDoAnuncio('999999', 't', (async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 100 } }) })) as any), null);
});
