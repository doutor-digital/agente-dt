import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUTOMACOES, automacaoPorChave, automacaoPorId, verificarCatalogo } from './automacoes.js';
import {
  _semearParaTeste,
  ehEstado,
  estadoDaAutomacao,
  estadoGravado,
  naListaDoAmbiente,
  panoramaDaUnidade,
} from './automacoes-estado.js';

const SERRA = 'doutor-hernia-serra';
const TAUBATE = 'doutor-hernia-taubate';

test('catálogo: ids e chaves são únicos e bem formados', () => {
  assert.deepEqual(verificarCatalogo(), []);
  assert.ok(AUTOMACOES.length >= 20, 'o catálogo deve cobrir todas as chaves por unidade do código');
  assert.equal(automacaoPorId('parados')?.chave, 'PARADOS_SLUGS');
  assert.equal(automacaoPorChave('VOLTA_ESPERA_SLUGS')?.id, 'volta-espera');
});

test('catálogo: toda automação se explica — sem isto a tela vira outra lista que ninguém entende', () => {
  for (const a of AUTOMACOES) {
    assert.ok(a.nome.trim().length > 3, `${a.id} sem nome de gente`);
    assert.ok(a.oQueFaz.trim().length > 40, `${a.id} com descrição curta demais pra explicar algo`);
    assert.ok(a.arquivo.startsWith('src/'), `${a.id} sem apontar onde a regra mora`);
  }
});

test('sem linha no banco, vale o .env — é isto que faz a migração não ligar nada sozinha', () => {
  _semearParaTeste([]);

  // csv de sempre, com aspas sobrando e espaço, como chega do .env da VPS
  assert.equal(estadoDaAutomacao(SERRA, 'parados', '"laboratorio-kommo, doutor-hernia-serra"'), 'ligado');
  assert.equal(estadoDaAutomacao(TAUBATE, 'parados', 'laboratorio-kommo,doutor-hernia-serra'), 'desligado');
  assert.equal(estadoDaAutomacao(TAUBATE, 'parados', '*'), 'ligado');

  // vazio = ninguém, na esmagadora maioria
  assert.equal(estadoDaAutomacao(SERRA, 'parados', ''), 'desligado');
  assert.equal(estadoDaAutomacao(SERRA, 'parados', undefined), 'desligado');

  // ...menos nas duas que nasceram ligadas pra rede toda, que é justamente o que ninguém lembra
  assert.equal(estadoDaAutomacao(SERRA, 'teto-mensal', undefined), 'ligado', 'teto vazio significa TODAS');
  assert.equal(estadoDaAutomacao(SERRA, 'chat-botoes', undefined), 'ligado', 'botões vazio significa TODAS');

  // e ninguém opinou: a tela precisa saber a diferença entre "desligado" e "não falei nada"
  assert.equal(estadoGravado(SERRA, 'parados'), null);
});

test('com linha no banco, a tela vence o .env', () => {
  _semearParaTeste([
    { slug: TAUBATE, automacao: 'volta-espera', estado: 'ligado' },
    { slug: SERRA, automacao: 'parados', estado: 'desligado' },
  ]);

  // ligada na tela mesmo sem estar em variável nenhuma
  assert.equal(estadoDaAutomacao(TAUBATE, 'volta-espera', undefined), 'ligado');
  // desligada na tela mesmo estando na variável — o botão tem que poder DESLIGAR, não só ligar
  assert.equal(estadoDaAutomacao(SERRA, 'parados', 'doutor-hernia-serra'), 'desligado');
  // quem a tela não tocou continua no .env
  assert.equal(estadoDaAutomacao(SERRA, 'franquia-move', 'doutor-hernia-serra'), 'ligado');
});

test('"seco" só existe onde o catálogo diz que existe — renomear id não pode ligar nada', () => {
  _semearParaTeste([
    { slug: SERRA, automacao: 'parados', estado: 'seco' },
    { slug: SERRA, automacao: 'sofia-calada', estado: 'seco' },
  ]);

  assert.equal(automacaoPorId('parados')?.temSeco, true);
  assert.equal(estadoDaAutomacao(SERRA, 'parados', undefined), 'seco');

  // sofia-calada não tem modo seco: o estado inválido cai pro lado seguro, não pro ligado
  assert.equal(automacaoPorId('sofia-calada')?.temSeco, false);
  assert.equal(estadoDaAutomacao(SERRA, 'sofia-calada', 'doutor-hernia-serra'), 'desligado');
});

test('o panorama mostra de onde veio cada estado, pra dar pra conferir sem abrir o Docker', () => {
  _semearParaTeste([{ slug: TAUBATE, automacao: 'volta-espera', estado: 'ligado' }]);
  const linhas = panoramaDaUnidade(TAUBATE, {
    PARADOS_SLUGS: 'doutor-hernia-serra',
    VOLTA_ESPERA_SLUGS: '',
  } as NodeJS.ProcessEnv);

  const volta = linhas.find((l) => l.id === 'volta-espera');
  assert.equal(volta?.estado, 'ligado');
  assert.equal(volta?.vemDoAmbiente, false, 'foi a tela que ligou');

  const parados = linhas.find((l) => l.id === 'parados');
  assert.equal(parados?.estado, 'desligado');
  assert.equal(parados?.vemDoAmbiente, true);
  assert.equal(parados?.ambiente, 'doutor-hernia-serra', 'mostra o csv cru pra conferir contra a VPS');

  assert.equal(linhas.length, AUTOMACOES.length, 'o panorama lista TODAS, inclusive as desligadas');
});

test('ehEstado recusa qualquer coisa que não seja um dos três', () => {
  assert.equal(ehEstado('ligado'), true);
  assert.equal(ehEstado('seco'), true);
  assert.equal(ehEstado('desligado'), true);
  assert.equal(ehEstado('LIGADO'), false);
  assert.equal(ehEstado(true), false);
  assert.equal(ehEstado(undefined), false);
});

test('naListaDoAmbiente reproduz o csv que as portas liam antes', () => {
  assert.equal(naListaDoAmbiente('a', 'a,b'), true);
  assert.equal(naListaDoAmbiente('c', 'a,b'), false);
  assert.equal(naListaDoAmbiente('c', ' * '), true);
  assert.equal(naListaDoAmbiente('a', '"a, b"'), true);
  assert.equal(naListaDoAmbiente('a', ''), false);
  assert.equal(naListaDoAmbiente('a', undefined), false);
});
