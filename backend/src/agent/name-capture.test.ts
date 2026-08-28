import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeName,
  extractLeadingName,
  detectNameDisclosure,
  askedForName,
  titleCaseName,
} from './name-capture.js';

test('looksLikeName — nomes válidos passam', () => {
  for (const ok of [
    'Ana',
    'Maria Silva',
    'Edna Evangelista Cardoso',
    'João',
    'Maria da Silva',
    'Ana Paula de Souza',
    'João dos Santos',
    "D'Ávila",
    'Ana-Júlia',
  ]) {
    assert.equal(looksLikeName(ok), true, `deveria aceitar: "${ok}"`);
  }
});

test('looksLikeName — NÃO-nomes são rejeitados', () => {
  for (const bad of [
    'um pouco coucuda',
    'um pouco corcunda',
    'diabética',
    'corcunda',
    'aposentada',
    'muita dor',
    'dor na coluna',
    'de imperatriz',
    'sou',
    'bom dia',
    'oi tudo bem',
    'quero saber o preço',
    'quanto é a consulta',
    '',
    '   ',
    'a',
    '123',
    'José123',
    'nome sobrenome mais um monte de palavra',
    'e Silva',
  ]) {
    assert.equal(looksLikeName(bad), false, `deveria REJEITAR: "${bad}"`);
  }
});

test('extractLeadingName — pega só o começo até o stopword', () => {
  assert.equal(extractLeadingName('João e tenho dor'), 'João');
  assert.equal(extractLeadingName('Maria Silva e quero saber o valor'), 'Maria Silva');
  assert.equal(extractLeadingName('um pouco coucuda'), null);
  assert.equal(extractLeadingName('Edna Evangelista Cardoso'), 'Edna Evangelista Cardoso');
  assert.equal(extractLeadingName('diabética'), null);
});

test('detectNameDisclosure — padrões explícitos capturam', () => {
  assert.equal(detectNameDisclosure('meu nome é José'), 'José');
  assert.equal(detectNameDisclosure('me chamo Maria Silva'), 'Maria Silva');
  assert.equal(detectNameDisclosure('meu nome completo é Ana Paula de Souza'), 'Ana Paula de Souza');
  assert.equal(detectNameDisclosure('eu sou João'), 'João');
  assert.equal(detectNameDisclosure('sou a Ana'), 'Ana');
  assert.equal(detectNameDisclosure('pode me chamar de Zé'), 'Zé');
});

test('detectNameDisclosure — o BUG DA EDNA e afins retornam null', () => {
  assert.equal(detectNameDisclosure('eu sou um pouco coucuda'), null);
  assert.equal(
    detectNameDisclosure(
      'Oi bom dia eu gostaria de saber quanto é a consulta por que eu sofro com muita dor na coluna eu sou um pouco coucuda',
    ),
    null,
  );
  assert.equal(detectNameDisclosure('sou diabética'), null);
  assert.equal(detectNameDisclosure('sou aposentada'), null);
  assert.equal(detectNameDisclosure('sou de imperatriz'), null);
  assert.equal(detectNameDisclosure('tenho muita dor na coluna'), null);
  assert.equal(detectNameDisclosure('quanto é a consulta?'), null);
  assert.equal(detectNameDisclosure('quero marcar uma avaliação'), null);
});

test('detectNameDisclosure — nome "pelado" só captura quando a IA perguntou', () => {
  assert.equal(detectNameDisclosure('Edna Evangelista Cardoso'), null);
  assert.equal(
    detectNameDisclosure('Edna Evangelista Cardoso', { nameWasAsked: true }),
    'Edna Evangelista Cardoso',
  );
  assert.equal(
    detectNameDisclosure('pode marcar depois do dia 25 de agosto', { nameWasAsked: true }),
    null,
  );
  assert.equal(detectNameDisclosure('tá bom pode ser', { nameWasAsked: true }), null);
});

test('askedForName — detecta a IA pedindo o nome', () => {
  assert.equal(askedForName('Antes de tudo, como posso te chamar?'), true);
  assert.equal(askedForName('Me passa seu nome completo?'), true);
  assert.equal(askedForName('Qual o seu nome?'), true);
  assert.equal(askedForName('A consulta é R$ 350 no PIX.'), false);
  assert.equal(askedForName(null), false);
});

test('titleCaseName — capitaliza certo', () => {
  assert.equal(titleCaseName('joão silva'), 'João Silva');
  assert.equal(titleCaseName('EDNA CARDOSO'), 'Edna Cardoso');
});

/* ─── Nomes compridos (regressão de produção, 28/08/2026) ─────────────────── */

test('aceita nome brasileiro comprido com conectores', () => {
  // O caso real: Imperatriz, lead 24954279. Tinha 5 palavras e o card ficou vazio.
  assert.equal(looksLikeName('Elzilene de Sales Dias Nogueira'), true);
  assert.equal(looksLikeName('Maria da Silva dos Santos'), true);
  assert.equal(looksLikeName('José Carlos de Almeida Ferreira Neto'), true);
  assert.equal(looksLikeName('Ana Paula e Souza'), true);
});

test('continua recusando frase que o paciente digita no lugar do nome', () => {
  assert.equal(looksLikeName('quero marcar uma consulta pra minha mãe'), false);
  assert.equal(looksLikeName('estou com muita dor na coluna lombar'), false);
  assert.equal(looksLikeName('bom dia gostaria de saber o valor'), false);
});

test('recusa nome longo demais para ser nome de pessoa', () => {
  assert.equal(looksLikeName('Ana Beatriz Carolina Daniela Eduarda Fabiana Gabriela'), false);
});
