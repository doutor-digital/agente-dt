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

import { leadAchadoNoMotivo, leadParaConverter, motivoDeLeadJaExistente } from './paciente-existente.js';

test('o motivo do lead achado guarda o id e o NOME (mesmo com aspas e parênteses) e é lido de volta', () => {
  const m = motivoDeLeadJaExistente({ id: 4321, nome: 'Maria "Mãe" (Silva)', onde: 'no índice' });
  assert.equal(tipoDoVinculo(m), 'lead-ja-existia');
  assert.deepEqual(leadAchadoNoMotivo(m), { id: 4321, nome: 'Maria "Mãe" (Silva)' });
  assert.deepEqual(leadAchadoNoMotivo(motivoDeLeadJaExistente({ id: 7, nome: null, onde: 'x' })), { id: 7, nome: null });
  // o formato antigo (sem nome), já gravado em produção
  assert.deepEqual(leadAchadoNoMotivo('lead já existe na franquia (idLead 6071221, achado pelo telefone no índice): não criei lead'), { id: 6071221, nome: null });
  assert.equal(leadAchadoNoMotivo('paciente já existe na franquia (idClient 9001, achado por telefone): não criei lead'), null);
  assert.equal(leadAchadoNoMotivo(null), null);
});

// ── na hora de agendar: que lead a consulta pode converter? ─────────────────────────────────────────────

const achado = (nome: string | null) => ({ spineIdLead: null, motivo: motivoDeLeadJaExistente({ id: 4321, nome, onde: 'no índice' }) });

test('CASO REAL: o cartão tem o perfil da MÃE, a consulta é da FILHA — o lead da mãe NÃO é convertido (paciente novo)', () => {
  // o lead achado se chama "Maria Souza Lima" (a mãe); o perfil do WhatsApp do cartão era o mesmo nome, e a filha agenda como "Joana Souza Lima"
  const r = leadParaConverter(achado('Maria Souza Lima'), 'Joana Souza Lima');
  assert.deepEqual(r, { id: null, achadoDescartado: 4321 });
});

test('a própria dona do lead agendando (nome e sobrenome batem): converte o lead achado', () => {
  assert.deepEqual(leadParaConverter(achado('Maria Souza Lima'), 'Maria Souza Lima'), { id: 4321, achadoDescartado: null });
  assert.deepEqual(leadParaConverter(achado('Maria Souza'), 'Maria José Souza'), { id: 4321, achadoDescartado: null });
});

test('"Maria José Souza" × lead "Maria Aparecida": só o primeiro nome igual não converte', () => {
  assert.deepEqual(leadParaConverter(achado('Maria Aparecida'), 'Maria José Souza'), { id: null, achadoDescartado: 4321 });
});

test('lead achado SEM NOME (franquia fora, fora da janela, formato antigo): nunca converte', () => {
  assert.deepEqual(leadParaConverter(achado(null), 'Maria Souza Lima'), { id: null, achadoDescartado: 4321 });
});

test('o lead que o vínculo guarda como SEU (criado por nós) converte sempre; sem vínculo ou com paciente achado, nada', () => {
  assert.deepEqual(leadParaConverter({ spineIdLead: 55, motivo: null }, 'Qualquer Nome'), { id: 55, achadoDescartado: null });
  assert.deepEqual(leadParaConverter(null, 'Maria Souza'), { id: null, achadoDescartado: null });
  assert.deepEqual(leadParaConverter({ spineIdLead: null, motivo: 'paciente já existe na franquia (idClient 9, achado pelo telefone no índice): não criei lead' }, 'Maria Souza'), { id: null, achadoDescartado: null });
});
