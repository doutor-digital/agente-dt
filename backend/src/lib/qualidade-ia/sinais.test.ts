import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PADROES_CLINICOS, PADROES_FALHA_TECNICA, PADROES_NAO_ENTENDI, PADROES_VAZAMENTO, classificarMensagem, totalDeSinais } from './sinais.js';
import { final4, limparTrecho, primeiroNome } from './privacidade.js';

test('vazamento de raciocínio: pega as frases do João, ignora conversa normal', () => {
  for (const frase of [
    'Vou acolher a dor dele antes de falar de preço.',
    'O paciente ainda não disse onde sente dor.',
    'Antes de soltar o valor, preciso entender o quadro.',
    'VOU ACOLHER primeiro',
  ]) {
    assert.equal(classificarMensagem(frase).vazamento, true, frase);
  }
  for (const frase of [
    'Entendo, deve ser difícil. Onde exatamente você sente a dor?',
    'O valor da consulta é R$ 250,00.',
    'Vou verificar a agenda para você.',
  ]) {
    assert.equal(classificarMensagem(frase).vazamento, false, frase);
  }
});

test('falha admitida: "não consegui abrir", "tivemos uma instabilidade", "não entendi" no começo da resposta', () => {
  for (const frase of [
    'Não consegui abrir o seu áudio.',
    'Tivemos uma instabilidade aqui, pode repetir por favor?',
    'Estamos com instabilidade no sistema, um instante.',
    'Houve uma instabilidade na conexão.',
    'Desculpe, não entendi. Pode repetir?',
    'Não entendi, pode escrever de outro jeito?',
    'Poxa, não entendi o que você quis dizer.',
  ]) {
    assert.equal(classificarMensagem(frase).falha, true, frase);
  }
});

test('frases clínicas reais NÃO são falha: instabilidade de coluna e pergunta legítima', () => {
  for (const frase of [
    'A instabilidade da coluna lombar pode causar essa dor.',
    'Se você sente instabilidade ao caminhar, é um sinal importante de avaliar.',
    'Pacientes com instabilidade vertebral costumam relatar dor ao levantar.',
    'Não entendi qual região da coluna dói, é a lombar ou a cervical?',
    'Não entendi bem: a dor desce pela perna?',
    'Desculpe, não entendi se você já fez ressonância.',
    'Entendo a sua dor, só não entendi o horário que você prefere.', // no meio da frase
    'Perfeito, te espero amanhã às 14h.',
  ]) {
    assert.equal(classificarMensagem(frase).falha, false, frase);
  }
  // falha técnica continua valendo mesmo com assunto clínico na mesma mensagem
  assert.equal(classificarMensagem('Não consegui abrir o seu exame, pode mandar de novo?').falha, true);
});

test('todo padrão compila e só usa sintaxe comum ao JavaScript e ao Postgres', () => {
  for (const p of [...PADROES_VAZAMENTO, ...PADROES_FALHA_TECNICA, ...PADROES_NAO_ENTENDI, ...PADROES_CLINICOS]) {
    // Construções que o Postgres não lê igual: lookaround, \m, (?i), referência nomeada.
    assert.doesNotMatch(p, /\(\?|\\m|\\M|\\y/, `padrão com sintaxe só de JS: ${p}`);
    assert.doesNotThrow(() => new RegExp(p, 'i'), p);
  }
});

test('total de sinais soma as três categorias', () => {
  assert.equal(totalDeSinais({ repetidas: 3, vazamento: 2, falha: 7 }), 12);
});

test('privacidade: 1º nome, 4 últimos dígitos, trecho sem número', () => {
  assert.equal(primeiroNome('Maria Aparecida da Silva'), 'Maria');
  assert.equal(primeiroNome('  joão  '), 'joão');
  assert.equal(primeiroNome('5511999998888'), null, 'telefone no lugar do nome não é nome');
  assert.equal(primeiroNome(null), null);
  assert.equal(primeiroNome(''), null);

  assert.equal(final4('+55 (11) 99999-8888'), '8888');
  assert.equal(final4('12'), null);
  assert.equal(final4(null), null);

  const t = limparTrecho('Meu zap é 11 99999-8888 e o outro +5511988887777, ok?');
  assert.doesNotMatch(t, /\d{4}/);
  assert.match(t, /\[número\]/);
  assert.equal(limparTrecho('escreve pra maria.souza@gmail.com por favor'), 'escreve pra [e-mail] por favor');
  assert.equal(limparTrecho('R$ 250,00 no Pix'), 'R$ 250,00 no Pix', 'preço não é telefone');
  assert.ok(limparTrecho('a'.repeat(300)).length <= 140);
});
