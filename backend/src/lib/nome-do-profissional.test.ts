import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comQuemVaiSerAtendido, nomeDoProfissional } from './nome-do-profissional.js';

// Os nomes são os que a franquia de Araguaína devolve de verdade.
test('tira o DR. que a própria franquia cola no nome', () => {
  assert.equal(nomeDoProfissional('DR. PAULO HENRIQUE AZEVEDO DE SOUSA '), 'Paulo Henrique Azevedo de Sousa');
  assert.equal(nomeDoProfissional('DR. LUIS EDUARDO RAPOSO LOBATO '), 'Luis Eduardo Raposo Lobato');
  assert.equal(nomeDoProfissional('DR. JONNÃ SOUSA CARNEIRO'), 'Jonnã Sousa Carneiro');
});

test('pega as outras formas do título', () => {
  for (const t of ['DRA. ANA PAULA', 'Dra ANA PAULA', 'Doutora ANA PAULA', 'dra. ana paula']) {
    assert.equal(nomeDoProfissional(t), 'Ana Paula', `falhou em ${t}`);
  }
});

test('nome sem título passa igual', () => {
  assert.equal(nomeDoProfissional('BÁRBARA WIRTZBIKI'), 'Bárbara Wirtzbiki');
});

test('o paciente ouve a profissão, não a patente', () => {
  assert.equal(comQuemVaiSerAtendido('DR. PAULO HENRIQUE AZEVEDO DE SOUSA'), 'fisioterapeuta Paulo Henrique Azevedo de Sousa');
  // sem artigo: "Regiane" não termina em A e a primeira versão disto a tratou
  // como homem. Nome não diz gênero, e a franquia não manda esse dado.
  assert.equal(comQuemVaiSerAtendido('DRA. REGIANE DUARTE'), 'fisioterapeuta Regiane Duarte');
});

test('sem nome, sem linha — não invento profissional', () => {
  assert.equal(nomeDoProfissional(null), null);
  assert.equal(nomeDoProfissional('   '), null);
  assert.equal(comQuemVaiSerAtendido(''), null);
  assert.equal(comQuemVaiSerAtendido('DR.'), null);
});

test('"médico" nunca sobra no texto entregue', () => {
  const saida = comQuemVaiSerAtendido('DR. PAULO HENRIQUE');
  assert.doesNotMatch(String(saida), /\bDr\.?\b|\bdoutor\b|\bm[ée]dic/i);
});
