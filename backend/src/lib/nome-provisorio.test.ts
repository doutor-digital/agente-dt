import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehNomeProvisorio, nomeProvisorioDoLead } from './nome-provisorio.js';
import { avaliarNome } from '../services/spine-sync.service.js';

test('nome provisório: padronizado, com os 4 últimos dígitos, em qualquer formato de telefone', () => {
  assert.equal(nomeProvisorioDoLead('+55 11 98888-7777'), 'Paciente WhatsApp (final 7777)');
  assert.equal(nomeProvisorioDoLead('5511988887777'), 'Paciente WhatsApp (final 7777)');
  assert.equal(nomeProvisorioDoLead('(98) 3333-1234'), 'Paciente WhatsApp (final 1234)');
});

test('sem telefone utilizável não há nome provisório (e o lead não sai)', () => {
  assert.equal(nomeProvisorioDoLead(null), null);
  assert.equal(nomeProvisorioDoLead(''), null);
  assert.equal(nomeProvisorioDoLead('1234'), null);
});

test('o nome provisório é reconhecido como provisório, e o filtro de nome-lixo continua o tratando como nome automático', () => {
  assert.equal(ehNomeProvisorio('Paciente WhatsApp (final 7777)'), true);
  assert.equal(ehNomeProvisorio('Maria Souza'), false);
  assert.equal(ehNomeProvisorio(null), false);
  assert.equal(avaliarNome('Paciente WhatsApp (final 7777)').ok, false);
});

test('o comentário e o código dizem a mesma coisa: telefone com menos de 8 dígitos não gera nome provisório (4 dígitos não bastam)', () => {
  assert.equal(nomeProvisorioDoLead('1234567'), null);
  assert.equal(nomeProvisorioDoLead('12345678'), 'Paciente WhatsApp (final 5678)');
});
