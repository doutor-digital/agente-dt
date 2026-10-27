import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definicaoParaAUnidade, impressaoDaOnda, type Definicao } from './disparo/modelo.js';
import { OFERTA_MAX, problemaNaOferta } from './disparo/regras.js';
import { campanhaSchema, camposDaCampanha } from './disparo/campanha-schema.js';
import { montarPainelDaOnda } from './disparo/painel.js';
import { FREIOS_PADRAO } from './disparo/freios.js';

const DEF: Definicao = { template: 'rosa', idioma: 'pt_BR', textoModelo: 'Oi {{1}}!', variaveis: ['primeiroNome'], cabecalho: null };
const PESSOAS = [{ chave: '6391021001', nome: 'Ana' }];

test('a oferta precisa estar escrita como "R$ 150": "150 reais" e "por 150 contos" são recusados (a trava de preço só reconhece R$)', () => {
  assert.equal(problemaNaOferta('Consulta por R$ 150 até 31/10.'), null);
  assert.equal(problemaNaOferta('R$150,00 à vista ou 2x de R$ 80'), null);
  assert.equal(problemaNaOferta('Condição especial para quem veio do Outubro Rosa.'), null);
  assert.equal(problemaNaOferta(null), null);
  assert.equal(problemaNaOferta(''), null);
  for (const ruim of ['Consulta por 150 reais até sexta', 'sai por 1.500 reais', 'só 150 contos', 'apenas 99 real']) assert.match(problemaNaOferta(ruim) ?? '', /R\$ 150/, ruim);
});

test('a oferta entra na impressão do que o João aprova: mudar a oferta invalida a aprovação; sem oferta o resultado é o mesmo de antes', () => {
  const sem = impressaoDaOnda(DEF, PESSOAS);
  assert.equal(impressaoDaOnda({ ...DEF, oferta: null }, PESSOAS), sem);
  assert.equal(impressaoDaOnda({ ...DEF, oferta: '   ' as string }, PESSOAS) === sem, false, 'texto em branco ainda é texto: quem copia a oferta já tira o espaço');
  const a = impressaoDaOnda({ ...DEF, oferta: 'R$ 150 até 31/10' }, PESSOAS);
  const b = impressaoDaOnda({ ...DEF, oferta: 'R$ 140 até 31/10' }, PESSOAS);
  assert.notEqual(a, sem);
  assert.notEqual(a, b);
  assert.equal(impressaoDaOnda({ ...DEF, oferta: 'R$ 150 até 31/10' }, PESSOAS), a, 'estável');
});

test('a onda COPIA a oferta da campanha na montagem (com espaço aparado; vazia não entra)', () => {
  const campanha = { template: 'rosa', idioma: 'pt_BR', textoModelo: 'Oi {{1}}!', variaveis: ['primeiroNome'], cabecalho: null, porUnidade: {}, oferta: '  R$ 150 até 31/10  ' };
  assert.equal((definicaoParaAUnidade(campanha, 'doutor-hernia-canaa') as Definicao).oferta, 'R$ 150 até 31/10');
  assert.equal((definicaoParaAUnidade({ ...campanha, oferta: '  ' }, 'doutor-hernia-canaa') as Definicao).oferta, undefined);
  assert.equal('oferta' in (definicaoParaAUnidade({ ...campanha, oferta: undefined }, 'doutor-hernia-canaa') as Definicao), false);
});

test('o schema da campanha é um só (rota e conector): ausente é ausente, limites iguais', () => {
  const minimo = campanhaSchema.parse({ nome: 'Rosa', textoModelo: 'Oi {{1}}' });
  assert.deepEqual(Object.keys(minimo).sort(), ['nome', 'textoModelo'], 'sem padrão escondido: quem salva decide o que ausente significa');
  assert.equal(campanhaSchema.safeParse({ nome: 'Rosa', textoModelo: 'x', oferta: 'x'.repeat(OFERTA_MAX + 1) }).success, false);
  assert.equal(campanhaSchema.safeParse({ nome: 'Rosa', textoModelo: 'x', oferta: null }).success, true);
  assert.equal(campanhaSchema.safeParse({ nome: 'Rosa', textoModelo: 'x', cabecalho: { tipo: 'image', link: 'http://inseguro/x.png' } }).success, false, 'cabeçalho só https');
  assert.ok('oferta' in camposDaCampanha && 'porUnidade' in camposDaCampanha);
});

test('tela: a janela da oferta mostrada é a configurada, e a oferta é a COPIADA na onda', () => {
  const base = {
    onda: { id: 'o1', estado: 'montada', total: 1, etiqueta: 'rosa', impressao: 'x', aprovadaPor: null, aprovadaEm: null, pausaMotivo: null, ...DEF, oferta: 'R$ 150 até 31/10' },
    campanhaNome: 'Rosa', unidade: { slug: 'u', nome: 'U' }, modo: 'seco' as const, freios: FREIOS_PADRAO, resumo: {}, contagem: {}, simulados: 0,
    amostra: [], conferenciaMeta: { ok: true } as const, podeAprovar: true, listaDeTeste: null,
  };
  const html = montarPainelDaOnda({ ...base, oferta: 'R$ 150 até 31/10', ofertaDias: 30 });
  assert.match(html, /nos próximos 30 dias/);
  assert.match(html, /copiada da campanha na montagem/);
  assert.doesNotMatch(html, /nos próximos 14 dias/);
});
