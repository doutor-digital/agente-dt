import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESPERA_APOS_FALHA_MS,
  VALIDADE_DO_INDICE_MS,
  _zerarIndiceParaTeste,
  atualizarIndiceSeVelho,
  chaveDoGrupo,
  chaveDoNumero,
  chavesDaUnidade,
  indiceAtual,
  lerGruposDeMarketing,
  montarIndice,
  unidadeDoGrupo,
  unidadesDoNumero,
  type GrupoComParticipantes,
} from './suporte-menu-grupos.js';
import type { UnidadeBasica } from './suporte-menu-maquina.js';

const MARABA: UnidadeBasica = { slug: 'doutor-hernia-maraba', nome: 'Doutor Hérnia Marabá' };
const TIMBO: UnidadeBasica = { slug: 'timbo', nome: 'Timbó' };
const RIO: UnidadeBasica = { slug: 'rioverde', nome: 'Doutor Hérnia Rio Verde' };
const LUCAS: UnidadeBasica = { slug: 'lucas-do-rio-verde', nome: 'Lucas do Rio Verde' };
const UNIDADES = [MARABA, TIMBO, RIO, LUCAS];

beforeEach(() => _zerarIndiceParaTeste());

test('chaveDoGrupo: só "Mkt | Dr Hérnia <unidade>"', () => {
  assert.equal(chaveDoGrupo('Mkt | Dr Hérnia Marabá'), 'maraba');
  assert.equal(chaveDoGrupo('Mkt | Dr Hérnia Canaã dos Carajás'), 'canaadoscarajas');
  assert.equal(chaveDoGrupo('MKT | Doutor Hérnia Rio Verde'), 'rioverde');
  assert.equal(chaveDoGrupo('Magalhães-MKT'), null);
  assert.equal(chaveDoGrupo('Financeiro Doutor Digital'), null);
  assert.equal(chaveDoGrupo('Mkt | Dr Hérnia '), null);
});

test('unidade do grupo: igualdade exata da chave (Rio Verde ≠ Lucas do Rio Verde); nome ou slug servem', () => {
  assert.equal(unidadeDoGrupo('Mkt | Dr Hérnia Marabá', UNIDADES)?.slug, MARABA.slug);
  assert.equal(unidadeDoGrupo('Mkt | Dr Hérnia Rio Verde', UNIDADES)?.slug, 'rioverde');
  assert.equal(unidadeDoGrupo('Mkt | Dr Hérnia Lucas do Rio Verde', UNIDADES)?.slug, 'lucas-do-rio-verde');
  assert.equal(unidadeDoGrupo('Mkt | Dr Hérnia Timbó', UNIDADES)?.slug, 'timbo');
  assert.equal(unidadeDoGrupo('Mkt | Dr Hérnia Cidade Que Não Existe', UNIDADES), null);
  assert.deepEqual(chavesDaUnidade(MARABA), ['maraba']);
  assert.deepEqual(chavesDaUnidade(RIO), ['rioverde']);
});

test('chaveDoNumero: DDD + últimos 8 (com ou sem 55, com ou sem nono dígito); @lid vira lid:', () => {
  assert.equal(chaveDoNumero('556391039464@s.whatsapp.net'), '6391039464');
  assert.equal(chaveDoNumero('5563991039464@s.whatsapp.net'), '6391039464');
  assert.equal(chaveDoNumero('63991039464'), '6391039464');
  assert.equal(chaveDoNumero('9565613625565@lid'), 'lid:9565613625565');
  assert.equal(chaveDoNumero('556391039464:12@s.whatsapp.net'), '6391039464');
  assert.equal(chaveDoNumero(''), null);
  assert.equal(chaveDoNumero(null), null);
  assert.equal(chaveDoNumero('123@s.whatsapp.net'), null);
});

const grupos: GrupoComParticipantes[] = [
  {
    jid: '1@g.us',
    assunto: 'Mkt | Dr Hérnia Marabá',
    participantes: [
      { id: '111@lid', phoneNumber: '559484389296@s.whatsapp.net' }, // só Marabá
      { id: '222@lid', phoneNumber: '556391039464@s.whatsapp.net' }, // consultoria: está nos dois
    ],
  },
  {
    jid: '2@g.us',
    assunto: 'Mkt | Dr Hérnia Timbó',
    participantes: [{ id: '222@lid', phoneNumber: '556391039464@s.whatsapp.net' }, { id: '333@lid' }],
  },
  { jid: '3@g.us', assunto: 'Magalhães-MKT', participantes: [{ id: '444@lid', phoneNumber: '556399990000@s.whatsapp.net' }] },
];

test('montarIndice + unidadesDoNumero: um grupo, vários grupos, por telefone ou por @lid, ignora grupo que não é de unidade', () => {
  const ix = montarIndice(grupos, UNIDADES);
  assert.deepEqual(unidadesDoNumero(ix, '559484389296@s.whatsapp.net').map((u) => u.slug), [MARABA.slug]);
  assert.deepEqual(unidadesDoNumero(ix, '5594984389296@s.whatsapp.net').map((u) => u.slug), [MARABA.slug]); // com nono dígito
  assert.deepEqual(unidadesDoNumero(ix, '111@lid').map((u) => u.slug), [MARABA.slug]); // quem chega como @lid
  assert.deepEqual(unidadesDoNumero(ix, '556391039464@s.whatsapp.net').map((u) => u.slug).sort(), [MARABA.slug, 'timbo'].sort());
  assert.deepEqual(unidadesDoNumero(ix, '333@lid').map((u) => u.slug), ['timbo']);
  assert.deepEqual(unidadesDoNumero(ix, '556399990000@s.whatsapp.net'), []); // grupo da Magalhães não conta
  assert.deepEqual(unidadesDoNumero(ix, '5511911112222@s.whatsapp.net'), []);
  // o mesmo número por telefone e por lid não duplica a unidade
  assert.equal(unidadesDoNumero(ix, '559484389296@s.whatsapp.net', '111@lid').length, 1);
});

function respostas(map: Record<string, unknown | number>): typeof fetch {
  return (async (url: string) => {
    const hit = Object.entries(map).find(([k]) => String(url).includes(k));
    if (!hit) return new Response('{}', { status: 404 });
    if (typeof hit[1] === 'number') return new Response('{}', { status: hit[1] });
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  }) as unknown as typeof fetch;
}

test('lerGruposDeMarketing: lista só os grupos Mkt, lê um por um e manda a chave da instância no cabeçalho', async () => {
  const pedidos: Array<{ url: string; apikey: string | null }> = [];
  const f = (async (url: string, init: RequestInit) => {
    pedidos.push({ url: String(url), apikey: new Headers(init.headers).get('apikey') });
    if (String(url).includes('/group/fetchAllGroups/')) {
      return new Response(JSON.stringify([{ id: '1@g.us', subject: 'Mkt | Dr Hérnia Marabá' }, { id: '9@g.us', subject: 'Família' }]));
    }
    return new Response(JSON.stringify({ participants: [{ id: '1@lid', phoneNumber: '556391039464@s.whatsapp.net' }] }));
  }) as unknown as typeof fetch;
  const r = await lerGruposDeMarketing({ url: 'https://evo.exemplo/', instancia: 'analista-dt', apikey: 'CHAVE-FALSA' }, { fetch: f, esperar: async () => {}, intervaloMs: 0 });
  assert.equal(r?.length, 1);
  assert.equal(r?.[0]?.assunto, 'Mkt | Dr Hérnia Marabá');
  assert.equal(pedidos.length, 2); // 1 lista + 1 grupo Mkt (a "Família" não é lida)
  assert.ok(pedidos.every((p) => p.apikey === 'CHAVE-FALSA'));
  assert.ok(pedidos[0]!.url.includes('getParticipants=false'));
  assert.ok(pedidos[1]!.url.includes('groupJid=1%40g.us'));
});

test('lerGruposDeMarketing: 429 em qualquer chamada aborta a rodada (devolve null), sem lançar e sem vazar a chave', async () => {
  const r = await lerGruposDeMarketing(
    { url: 'https://evo.exemplo', instancia: 'x', apikey: 'CHAVE-FALSA' },
    { fetch: respostas({ '/group/fetchAllGroups/': 429 }), esperar: async () => {}, intervaloMs: 0 },
  );
  assert.equal(r, null);
});

test('atualizarIndiceSeVelho: carrega, não repete antes da validade, espera após falha, não roda duas ao mesmo tempo', async () => {
  let leituras = 0;
  const ler = async () => {
    leituras += 1;
    return grupos;
  };
  const us = async () => UNIDADES;
  const t0 = 1_000_000;
  const p = atualizarIndiceSeVelho(us, ler, t0);
  assert.ok(p);
  assert.equal(atualizarIndiceSeVelho(us, ler, t0), null); // já carregando
  await p;
  assert.equal(leituras, 1);
  assert.ok(indiceAtual().size > 0);
  assert.equal(atualizarIndiceSeVelho(us, ler, t0 + VALIDADE_DO_INDICE_MS - 1), null); // ainda válido
  const p2 = atualizarIndiceSeVelho(us, ler, t0 + VALIDADE_DO_INDICE_MS + 1);
  assert.ok(p2);
  await p2;
  assert.equal(leituras, 2);
});

test('atualizarIndiceSeVelho: leitura que falha mantém o índice antigo e só tenta de novo depois da espera', async () => {
  const us = async () => UNIDADES;
  const t0 = 5_000_000;
  await atualizarIndiceSeVelho(us, async () => grupos, t0);
  const antes = indiceAtual().size;
  const tFalha = t0 + VALIDADE_DO_INDICE_MS + 10;
  await atualizarIndiceSeVelho(us, async () => null, tFalha);
  assert.equal(indiceAtual().size, antes); // índice antigo intacto
  assert.equal(atualizarIndiceSeVelho(us, async () => grupos, tFalha + 1000), null); // em espera
  assert.ok(atualizarIndiceSeVelho(us, async () => grupos, tFalha + ESPERA_APOS_FALHA_MS + 1)); // liberou
});
