/** De onde veio um vínculo "ok": criado por nós, o telefone já era lead lá, ou já era paciente lá. A tela da franquia só pode contar o primeiro como "enviado". */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contarPorTipoDoVinculo, tipoDoVinculo } from './paciente-existente.js';

test('tipoDoVinculo: sem motivo (ou outro) = criado por nós; os dois prefixos do 1º contato e do casamento = já existia', () => {
  assert.equal(tipoDoVinculo(null), 'criado');
  assert.equal(tipoDoVinculo(undefined), 'criado');
  assert.equal(tipoDoVinculo(''), 'criado');
  assert.equal(tipoDoVinculo('o telefone é de 2 pacientes da franquia (1, 2): não criei lead'), 'criado');
  assert.equal(tipoDoVinculo('lead já existe na franquia (idLead 4321, achado pelo telefone no índice): não criei lead'), 'lead-ja-existia');
  assert.equal(tipoDoVinculo('paciente já existe na franquia (idClient 9001, achado por telefone): não criei lead'), 'paciente-ja-existia');
});

test('contarPorTipoDoVinculo separa criados × lead já existia × paciente já existia', () => {
  const r = contarPorTipoDoVinculo([null, null, 'lead já existe na franquia (idLead 1)', 'paciente já existe na franquia (idClient 2)', 'paciente já existe na franquia (idClient 3)']);
  assert.deepEqual(r, { criado: 2, 'lead-ja-existia': 1, 'paciente-ja-existia': 2 });
});
