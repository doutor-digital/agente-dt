import { test } from 'node:test';
import assert from 'node:assert/strict';

import { montarEsquema, normalizarNome } from './kommo-schema.js';

const CAMPOS_ITZ = [
  { id: 2442703, name: '✓ Agendou' },
  { id: 2440909, name: '◷ Agendado pela SDR em' },
  { id: 2444497, name: '◷ Data da Consulta' },
  { id: 2442715, name: '⬢ Forma de pagamento' },
  { id: 2442951, name: '⬢ Forma de pagamento' },
];
const CAMPOS_MARABA = [
  { id: 2445790, name: '✓ Agendou' },
  { id: 2445806, name: '◷ Agendado pela SDR em' },
  { id: 2445700, name: '◷ Data da Consulta' },
];

const PIPES_ITZ = [
  {
    id: 14091100,
    name: 'COMERCIAL',
    statuses: [
      { id: 108773008, name: 'AGENDADO' },
      { id: 110342960, name: 'RETORNO PÓS-TRATAMENTO' },
    ],
  },
];
const PIPES_MARABA = [
  {
    id: 13789563,
    name: 'COMERCIAL',
    statuses: [
      { id: 106518979, name: 'AGENDADO' },
      { id: 106519001, name: 'RETORNO PÓS-TRATAMENTO' },
    ],
  },
];

const itz = montarEsquema(CAMPOS_ITZ, PIPES_ITZ);
const maraba = montarEsquema(CAMPOS_MARABA, PIPES_MARABA);

test('cada conta resolve o mesmo nome para o SEU id', () => {
  assert.equal(itz.campoPorNome('◷ Data da Consulta'), 2444497);
  assert.equal(maraba.campoPorNome('◷ Data da Consulta'), 2445700);
  assert.equal(itz.campoPorNome('◷ Agendado pela SDR em'), 2440909);
  assert.equal(maraba.campoPorNome('◷ Agendado pela SDR em'), 2445806);
});

test('campo que não existe na conta devolve null em vez de id de outra conta', () => {
  assert.equal(maraba.campoPorNome('⬢ Forma de pagamento'), null);
  assert.equal(maraba.campoPorNome('✓ Situação da consulta'), null);
});

test('nome repetido devolve todos os ids', () => {
  assert.deepEqual(itz.camposPorNome('⬢ Forma de pagamento'), [2442715, 2442951]);
});

test('resolve funil e etapa por nome em cada conta', () => {
  assert.equal(itz.pipelinePorNome('COMERCIAL'), 14091100);
  assert.equal(maraba.pipelinePorNome('COMERCIAL'), 13789563);
  assert.equal(itz.statusPorNome('COMERCIAL', 'RETORNO PÓS-TRATAMENTO'), 110342960);
  assert.equal(maraba.statusPorNome('COMERCIAL', 'RETORNO PÓS-TRATAMENTO'), 106519001);
  assert.equal(itz.statusPorNome('TRATAMENTO', 'ALTA'), null);
});

test('ignora acento, símbolo e caixa ao casar o nome', () => {
  assert.equal(normalizarNome('◷ Data da Consulta'), normalizarNome('data da consulta'));
  assert.equal(itz.campoPorNome('data da consulta'), 2444497);
  assert.equal(itz.campoPorNome('DATA DA CONSULTA'), 2444497);
});

test('conta vazia não quebra', () => {
  const vazio = montarEsquema([], []);
  assert.equal(vazio.campoPorNome('qualquer'), null);
  assert.equal(vazio.pipelinePorNome('COMERCIAL'), null);
  assert.equal(vazio.statusPorNome('COMERCIAL', 'AGENDADO'), null);
});
