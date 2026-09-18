import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classificarRegiao, ehCampoQueixa, ehCampoRegiao, etiquetasDaRegiao, regiaoDoValor } from './regiao-dor.js';

test('queixas reais da Imperatriz caem na região certa', () => {
  const casos: Array<[string, string | null]> = [
    ['Dor lombar há 3 meses, irradiando para a perna esquerda', 'Lombar'],
    ['Dor no pescoço e formigamento no braço direito', 'Cervical'],
    ['Hérnia de disco L4-L5, dor forte ao levantar', 'Lombar'],
    ['Dor na parte de baixo das costas há 2 anos', 'Lombar'],
    ['Nervo ciático inflamado', 'Lombar'],
    ['Dor no coccix', 'Lombar'],
    ['Dor no meio das costas, entre as escápulas', 'Torácica'],
    ['Dor no ombro direito ao levantar o braço', 'Outra'],
    ['Dor no joelho', 'Outra'],
    ['Dor na coluna há 5 anos', null],
    ['Dor nas costas', null],
    ['Paciente veio a procura de plano de saude.', null],
    ['', null],
  ];
  for (const [q, esperado] of casos) assert.equal(classificarRegiao(q), esperado, q);
});

test('cervical vence quando a queixa cita pescoço e coluna', () => {
  assert.equal(classificarRegiao('dor na coluna cervical que desce pro braço'), 'Cervical');
});

test('duas regiões da coluna na mesma queixa = ambíguo, a Sofia pergunta', () => {
  assert.equal(classificarRegiao('hérnia lombar forte que irradia pra perna, e formigamento no braço'), null);
  assert.equal(classificarRegiao('dor lombar e no joelho'), 'Lombar', 'articulação não gera conflito');
  assert.equal(classificarRegiao('doc12 abc34'), null, 'código não vira vértebra cervical');
});

test('reconhece os campos pelo nome, com símbolo na frente', () => {
  assert.equal(ehCampoRegiao('⚕ Região da dor'), true);
  assert.equal(ehCampoRegiao('Regiao da dor'), true);
  assert.equal(ehCampoRegiao('⚕ Local do tratamento'), false);
  assert.equal(ehCampoQueixa('✎ Queixa'), true);
  assert.equal(ehCampoQueixa('✎ Queixa principal'), true);
  assert.equal(ehCampoQueixa('Motivo (qualificação)'), false);
});

test('etiquetas: lombar e cervical entram, a outra sai; Torácica tira as duas', () => {
  assert.deepEqual(etiquetasDaRegiao('Lombar'), { colocar: 'lombar', tirar: ['cervical'] });
  assert.deepEqual(etiquetasDaRegiao('cervical'), { colocar: 'cervical', tirar: ['lombar'] });
  assert.deepEqual(etiquetasDaRegiao('Torácica'), { colocar: null, tirar: ['cervical', 'lombar'] });
  assert.deepEqual(etiquetasDaRegiao(42), { colocar: null, tirar: ['cervical', 'lombar'] });
  assert.equal(regiaoDoValor('TORACICA'), 'Torácica');
  assert.equal(regiaoDoValor('perna'), null);
});
