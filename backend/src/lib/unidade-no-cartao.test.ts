/**
 * ⌂ Unidade no cartão — o campo que o modelo da primeira sessão lê (20/10/2026, Aciolino em Balsas recebeu
 * "Unidade: Imperatriz/MA").
 *
 * O que estes testes prendem:
 *  - campo vazio recebe a cidade da unidade, no formato do exemplo do modelo ("Cidade/UF");
 *  - o que alguém escreveu nunca é trocado; o que não fala da cidade vira "diverge" (só registro);
 *  - o robô corrige só o valor que ele mesmo põe (conta dividida, quando a SDR troca a unidade de atendimento);
 *  - Petrópolis × Caxias: o valor segue a unidade de atendimento; vazia, ninguém grava;
 *  - o campo é achado pelo nome exato (Petrópolis tem também o "⌂ Unidade de atendimento");
 *  - o teto da rodada e o cursor do estoque.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALOR_POR_UNIDADE,
  acharCampoDoModelo,
  caberNoTeto,
  falaDaCidade,
  planejarUnidadeNoCartao,
  valorDesejado,
} from './unidade-no-cartao.js';

const BALSAS = VALOR_POR_UNIDADE['doutor-hernia-balsas']!;
const PETRO = VALOR_POR_UNIDADE['doutor-hernia-petropolis']!;

test('campo vazio: grava a cidade da unidade', () => {
  assert.deepEqual(planejarUnidadeNoCartao({ regra: BALSAS, noCartao: null, atendimento: null }), {
    acao: 'gravar',
    valor: 'Balsas/MA',
    motivo: 'campo vazio',
  });
  assert.equal(planejarUnidadeNoCartao({ regra: BALSAS, noCartao: '   ', atendimento: null })?.acao, 'gravar');
});

test('já certo, ou certo em outro formato: nada a fazer', () => {
  assert.equal(planejarUnidadeNoCartao({ regra: BALSAS, noCartao: 'Balsas/MA', atendimento: null }), null);
  assert.equal(planejarUnidadeNoCartao({ regra: BALSAS, noCartao: 'balsas/ma ', atendimento: null }), null);
  // os 2 cartões de Balsas que tinham o campo em 20/10
  assert.equal(planejarUnidadeNoCartao({ regra: BALSAS, noCartao: 'BALSAS - MA', atendimento: null }), null);
  assert.equal(planejarUnidadeNoCartao({ regra: BALSAS, noCartao: 'Doutor Hérnia Balsas', atendimento: null }), null);
});

test('valor à mão de outra cidade: diverge, nunca troca', () => {
  const p = planejarUnidadeNoCartao({ regra: BALSAS, noCartao: 'Imperatriz/MA', atendimento: null });
  assert.equal(p?.acao, 'diverge');
  assert.equal(p && 'noCartao' in p ? p.noCartao : null, 'Imperatriz/MA');
});

test('Petrópolis × Caxias: segue a unidade de atendimento; vazia não grava', () => {
  assert.equal(valorDesejado(PETRO, 'Petrópolis'), 'Petrópolis/RJ');
  assert.equal(valorDesejado(PETRO, 'Caxias'), 'Duque de Caxias/RJ');
  assert.equal(valorDesejado(PETRO, 'caxias'), 'Duque de Caxias/RJ');
  assert.equal(valorDesejado(PETRO, null), null);
  assert.equal(valorDesejado(PETRO, 'Niterói'), null);
  assert.equal(planejarUnidadeNoCartao({ regra: PETRO, noCartao: null, atendimento: null }), null);
  assert.deepEqual(planejarUnidadeNoCartao({ regra: PETRO, noCartao: null, atendimento: 'Caxias' }), {
    acao: 'gravar',
    valor: 'Duque de Caxias/RJ',
    motivo: 'campo vazio (unidade de atendimento: Caxias)',
  });
});

test('o robô corrige o que ele mesmo pôs quando a SDR troca a unidade de atendimento', () => {
  const p = planejarUnidadeNoCartao({ regra: PETRO, noCartao: 'Petrópolis/RJ', atendimento: 'Caxias' });
  assert.equal(p?.acao, 'trocar');
  assert.equal(p?.valor, 'Duque de Caxias/RJ');
  // mas não sem saber a unidade
  assert.equal(planejarUnidadeNoCartao({ regra: PETRO, noCartao: 'Petrópolis/RJ', atendimento: null }), null);
  // e nunca o que a SDR escreveu: "Caxias" à mão fala de Duque de Caxias
  assert.equal(planejarUnidadeNoCartao({ regra: PETRO, noCartao: 'Caxias', atendimento: 'Caxias' }), null);
  assert.equal(planejarUnidadeNoCartao({ regra: PETRO, noCartao: 'Caxias', atendimento: 'Petrópolis' })?.acao, 'diverge');
});

test('fala da cidade: UF e símbolos não atrapalham; sigla solta não conta', () => {
  assert.equal(falaDaCidade('BALSAS - MA', 'Balsas/MA'), true);
  assert.equal(falaDaCidade('Canaã', 'Canaã dos Carajás/PA'), true);
  assert.equal(falaDaCidade('Imperatriz/MA', 'Balsas/MA'), false);
  assert.equal(falaDaCidade('MA', 'Balsas/MA'), false);
  assert.equal(falaDaCidade('Rio Verde', 'Rio Verde/GO'), true);
});

test('campo pelo nome exato: "⌂ Unidade de atendimento" não serve; dois iguais = não sei qual', () => {
  const campos = [
    { id: 479786, name: '⌂ Unidade de atendimento' },
    { id: 264810, name: '⌂ Unidade' },
  ];
  assert.equal(acharCampoDoModelo(campos)?.id, 264810);
  assert.equal(acharCampoDoModelo([{ id: 1, name: '⌂ Unidade de atendimento' }]), null);
  assert.equal(acharCampoDoModelo([{ id: 1, name: '⌂ Unidade ' }, { id: 2, name: '⌂ Unidade' }]), null);
  assert.equal(acharCampoDoModelo([{ id: 1, name: 'Unidade' }]), null);
});

test('todo valor fixo está no formato do exemplo do modelo: "Cidade/UF"', () => {
  for (const [slug, regra] of Object.entries(VALOR_POR_UNIDADE)) {
    const valores = 'fixo' in regra ? [regra.fixo] : Object.values(regra.porAtendimento);
    for (const v of valores) assert.match(v, /^[^/]+\/[A-Z]{2}$/, `${slug}: ${v}`);
  }
});

test('teto da rodada: o que não coube fica, e o cursor não anda', () => {
  assert.deepEqual(caberNoTeto([1, 2, 3], 5), { entram: [1, 2, 3], paginaInteira: true });
  assert.deepEqual(caberNoTeto([1, 2, 3], 3), { entram: [1, 2, 3], paginaInteira: true });
  assert.deepEqual(caberNoTeto([1, 2, 3], 2), { entram: [1, 2], paginaInteira: false });
  assert.deepEqual(caberNoTeto([1, 2, 3], 0), { entram: [], paginaInteira: false });
  assert.deepEqual(caberNoTeto([], 0), { entram: [], paginaInteira: true });
});
