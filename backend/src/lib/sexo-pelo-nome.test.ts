/**
 * Sexo pelo nome — e a única coisa que ele não pode fazer: chutar.
 *
 * Campo vazio a recepção percebe e corrige. Campo errado ninguém desconfia, e ele viaja
 * junto no template, no relatório e no tratamento que a IA dá ao paciente. Por isso a
 * maioria destes testes prova o que a função SE RECUSA a responder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primeiroNome, sexoPeloNome } from './sexo-pelo-nome.js';

test('nomes da lista, tirados do próprio CRM', () => {
  assert.equal(sexoPeloNome('Maria da Conceição')?.sexo, 'Feminino');
  assert.equal(sexoPeloNome('João Batista')?.sexo, 'Masculino');
  assert.equal(sexoPeloNome('RAIMUNDO GOMES SOARES')?.sexo, 'Masculino');
  assert.equal(sexoPeloNome('Francisca')?.sexo, 'Feminino');
  assert.equal(sexoPeloNome('maria')?.como, 'lista');
});

test('acento e caixa não mudam a resposta — o CRM tem os dois', () => {
  for (const escrito of ['Antônio', 'ANTONIO', 'antônio', '  Antonio  ']) {
    assert.equal(sexoPeloNome(escrito)?.sexo, 'Masculino', escrito);
  }
});

test('cartão sem nome não vira chute — é 26% dos leads', () => {
  for (const titulo of ['Lead 2 25/09/2026', 'Lead #4243167', 'lead', '', '   ', null, undefined]) {
    assert.equal(sexoPeloNome(titulo), null, JSON.stringify(titulo));
  }
});

test('número de telefone como título não vira nome', () => {
  assert.equal(sexoPeloNome('94 8442-2354'), null);
  assert.equal(sexoPeloNome('+55 27 99846-3889'), null);
});

test('a lista vence a terminação — é pra isso que ela existe', () => {
  // Se algum dia entrar na lista um nome que contraria a terminação, a lista manda.
  const d = sexoPeloNome('Nicola');
  if (d?.como === 'lista') assert.equal(d.sexo, 'Masculino', 'nome de homem terminado em -a');
});

test('terminação só responde -a e -o; o resto é null', () => {
  assert.equal(sexoPeloNome('Zurilandia')?.sexo, 'Feminino');
  assert.equal(sexoPeloNome('Vanderleno')?.sexo, 'Masculino');
  // -r, -l, -s, -e: medido em 91,6% quando incluídos. Baixo demais pra escrever no CRM.
  for (const n of ['Wilker', 'Gabriel', 'Tales', 'Clideane']) {
    const d = sexoPeloNome(n);
    if (d && d.como === 'terminacao') assert.fail(`${n} não devia ser decidido por terminação`);
  }
});

test('nome curto demais não decide por terminação', () => {
  const d = sexoPeloNome('Bia Souza');
  if (d) assert.equal(d.como, 'lista', 'nome de 3 letras só pode vir da lista');
});

test('conectores e títulos são pulados até achar o nome', () => {
  assert.equal(primeiroNome('de Souza Maria'), 'souza');
  assert.equal(primeiroNome('Dra. Barbara'), 'barbara');
  assert.equal(primeiroNome('Sr. Antonio'), 'antonio');
  assert.equal(primeiroNome('Lead 5 Maria'), 'maria');
});

test('diz como decidiu — sem isso não dá pra auditar um campo estranho', () => {
  const d = sexoPeloNome('Maria');
  assert.ok(d && ['lista', 'terminacao'].includes(d.como));
  assert.equal(d?.nome, 'maria');
});
