/**
 * chatwoot-origem: anúncio → «Meta Ads» + nomes da campanha/conjunto; conversa nova sem anúncio → «Orgânico»; nunca sobrescreve;
 * seco não grava; token só no cabeçalho.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { aplicarOrigem, decidirOrigem, eventoDeOrigem, limparCacheDaOrigem, nomesDoAnuncio, ORIGEM_ANUNCIO, ORIGEM_ORGANICO } = await import('./chatwoot-origem.js');
const { automacaoPorId, verificarCatalogo } = await import('./automacoes.js');

const CAIXAS = { 3: 'doutor-hernia-parauapebas' } as const;
const AGORA = '2026-11-20T13:00:00Z';
function corpo(o: { ref?: unknown; criadaHaMin?: number; attrs?: Record<string, unknown>; tipo?: unknown; caixa?: number; ident?: string; privada?: boolean } = {}) {
  return {
    event: 'message_created',
    message_type: o.tipo ?? 'incoming',
    private: o.privada ?? false,
    created_at: AGORA,
    content_attributes: o.ref === undefined ? {} : { referral: o.ref },
    sender: { id: 77, identifier: o.ident ?? '', phone_number: '+5594999990000', custom_attributes: o.attrs ?? {} },
    conversation: { id: 900, inbox_id: o.caixa ?? 3, created_at: Math.floor((Date.parse(AGORA) - (o.criadaHaMin ?? 1) * 60_000) / 1000) },
  };
}
const ANUNCIO = { source_type: 'ad', source_id: '120253955239410514', ctwa_clid: 'Afd…', headline: 'Dor na coluna?' };

test('catálogo: chatwoot-origem existe, tem seco e nasce desligado', () => {
  const a = automacaoPorId('chatwoot-origem');
  assert.ok(a);
  assert.equal(a!.temSeco, true);
  assert.equal(a!.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(), []);
});

test('evento: só mensagem de PACIENTE, pública, numa caixa de unidade; grupo e bot fora', () => {
  assert.equal(eventoDeOrigem(corpo({ ref: ANUNCIO }), CAIXAS)?.anuncio, '120253955239410514');
  assert.equal(eventoDeOrigem(corpo({ tipo: 'outgoing' }), CAIXAS), null);
  assert.equal(eventoDeOrigem(corpo({ privada: true }), CAIXAS), null);
  assert.equal(eventoDeOrigem(corpo({ caixa: 9 }), CAIXAS), null);
  assert.equal(eventoDeOrigem(corpo({ ident: '1203@g.us' }), CAIXAS), null);
  assert.equal(eventoDeOrigem({ ...corpo(), event: 'conversation_updated' }, CAIXAS), null);
  // publicação (não anúncio): referral sem id de anúncio
  assert.equal(eventoDeOrigem(corpo({ ref: { source_type: 'post', source_id: 'x' } }), CAIXAS)?.anuncio, '');
  assert.equal(eventoDeOrigem(corpo({ criadaHaMin: 2 }), CAIXAS)?.conversaNova, true);
  assert.equal(eventoDeOrigem(corpo({ criadaHaMin: 60 * 24 }), CAIXAS)?.conversaNova, false);
});

test('decidir: anúncio → Meta Ads + campanha + conjunto; NUNCA sobrescreve; orgânico só no começo da conversa nova', () => {
  const nomes = { campanha: '06/11 | Conversas | WPP', conjunto: 'ABERTO 25-65' };
  const e = eventoDeOrigem(corpo({ ref: ANUNCIO }), CAIXAS)!;
  assert.deepEqual(decidirOrigem(e, nomes), { origem: ORIGEM_ANUNCIO, campanha_nome: nomes.campanha, conjunto: 'ABERTO 25-65' });
  // sem os nomes (Meta fora): só a Origem
  assert.deepEqual(decidirOrigem(e, null), { origem: ORIGEM_ANUNCIO });
  // preenchido à mão: fica
  const manual = eventoDeOrigem(corpo({ ref: ANUNCIO, attrs: { origem: 'Indicação' } }), CAIXAS)!;
  assert.equal(decidirOrigem(manual, nomes), null, 'origem manual diferente de anúncio: não mexe em nada');
  const parcial = eventoDeOrigem(corpo({ ref: ANUNCIO, attrs: { origem: 'Meta Ads', campanha_nome: 'Escrita à mão' } }), CAIXAS)!;
  assert.deepEqual(decidirOrigem(parcial, nomes), { conjunto: 'ABERTO 25-65' });
  // sem anúncio
  assert.deepEqual(decidirOrigem(eventoDeOrigem(corpo({ criadaHaMin: 1 }), CAIXAS)!, null), { origem: ORIGEM_ORGANICO });
  assert.equal(decidirOrigem(eventoDeOrigem(corpo({ criadaHaMin: 120 }), CAIXAS)!, null), null, 'conversa antiga: não chuta orgânico');
  assert.equal(decidirOrigem(eventoDeOrigem(corpo({ criadaHaMin: 1, attrs: { origem: 'Google' } }), CAIXAS)!, null), null);
});

test('aplicar: desligado não faz nada; seco não grava nem busca à toa; ligado grava só os campos decididos', async () => {
  const e = eventoDeOrigem(corpo({ ref: ANUNCIO }), CAIXAS)!;
  const gravados: Array<[number, Record<string, string>]> = [];
  let buscas = 0;
  const portas = (estado: 'desligado' | 'seco' | 'ligado') => ({
    estado: () => estado,
    nomes: async () => {
      buscas++;
      return { campanha: 'C', conjunto: 'J' };
    },
    gravar: async (c: number, campos: Record<string, string>) => {
      gravados.push([c, campos]);
    },
  });
  assert.equal(await aplicarOrigem(e, portas('desligado')), 'desligado');
  assert.equal(buscas, 0);
  assert.equal(await aplicarOrigem(e, portas('seco')), 'seco');
  assert.equal(gravados.length, 0);
  assert.equal(await aplicarOrigem(e, portas('ligado')), 'gravado');
  assert.deepEqual(gravados, [[77, { origem: ORIGEM_ANUNCIO, campanha_nome: 'C', conjunto: 'J' }]]);
  // contato já completo: nem pergunta à Meta
  const completo = eventoDeOrigem(corpo({ ref: ANUNCIO, attrs: { origem: 'Meta Ads', campanha_nome: 'C', conjunto: 'J' } }), CAIXAS)!;
  const antes = buscas;
  assert.equal(await aplicarOrigem(completo, portas('ligado')), 'nada');
  assert.equal(buscas, antes);
  // falha ao gravar não lança
  assert.equal(await aplicarOrigem(e, { ...portas('ligado'), gravar: async () => { throw new Error('Chatwoot fora'); } }), 'nada');
});

test('nomes do anúncio: token só no cabeçalho, cache, falha vira null', async () => {
  limparCacheDaOrigem();
  const urls: string[] = [];
  const cab: string[] = [];
  const ok = (async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(url);
    cab.push(init.headers.Authorization!);
    return { ok: true, json: async () => ({ campaign: { name: 'Campanha X' }, adset: { name: 'Conjunto Y' }, id: '1' }) };
  }) as any;
  assert.deepEqual(await nomesDoAnuncio('123456', 'segredo-xyz', ok), { campanha: 'Campanha X', conjunto: 'Conjunto Y' });
  await nomesDoAnuncio('123456', 'segredo-xyz', ok);
  assert.equal(urls.length, 1, 'cache');
  assert.ok(!urls[0]!.includes('segredo-xyz') && cab[0] === 'Bearer segredo-xyz');
  assert.match(decodeURIComponent(urls[0]!), /\/123456\?fields=campaign\{name\},adset\{name\}$/);
  limparCacheDaOrigem();
  const recusa = (async () => ({ ok: false, json: async () => ({ error: { code: 200 } }) })) as any;
  assert.equal(await nomesDoAnuncio('999999', 't', recusa), null);
  const quebra = (async () => {
    throw new Error('rede');
  }) as any;
  assert.equal(await nomesDoAnuncio('888888', 't', quebra), null);
});
