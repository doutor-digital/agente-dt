// Testes da trava de captura de nome. Rode: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeName,
  extractLeadingName,
  detectNameDisclosure,
  askedForName,
  titleCaseName,
} from './name-capture.js';

// ── looksLikeName ───────────────────────────────────────────────────────────
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
    'um pouco coucuda', // ← o bug da Edna
    'um pouco corcunda',
    'diabética',
    'corcunda',
    'aposentada',
    'muita dor',
    'dor na coluna',
    'de imperatriz', // "sou de imperatriz"
    'sou',
    'bom dia',
    'oi tudo bem',
    'quero saber o preço',
    'quanto é a consulta',
    '', // vazio
    '   ',
    'a', // 1 letra
    '123',
    'José123',
    'nome sobrenome mais um monte de palavra', // > 4 palavras
    'e Silva', // começa com conector
  ]) {
    assert.equal(looksLikeName(bad), false, `deveria REJEITAR: "${bad}"`);
  }
});

// ── extractLeadingName ──────────────────────────────────────────────────────
test('extractLeadingName — pega só o começo até o stopword', () => {
  assert.equal(extractLeadingName('João e tenho dor'), 'João');
  assert.equal(extractLeadingName('Maria Silva e quero saber o valor'), 'Maria Silva');
  assert.equal(extractLeadingName('um pouco coucuda'), null);
  assert.equal(extractLeadingName('Edna Evangelista Cardoso'), 'Edna Evangelista Cardoso');
  assert.equal(extractLeadingName('diabética'), null);
});

// ── detectNameDisclosure ────────────────────────────────────────────────────
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
  // sem contexto: não captura frase solta
  assert.equal(detectNameDisclosure('Edna Evangelista Cardoso'), null);
  // com contexto (IA acabou de perguntar): captura
  assert.equal(
    detectNameDisclosure('Edna Evangelista Cardoso', { nameWasAsked: true }),
    'Edna Evangelista Cardoso',
  );
  // mesmo com contexto, uma frase-não-nome não é capturada
  assert.equal(
    detectNameDisclosure('pode marcar depois do dia 25 de agosto', { nameWasAsked: true }),
    null,
  );
  assert.equal(detectNameDisclosure('tá bom pode ser', { nameWasAsked: true }), null);
});

// ── askedForName ────────────────────────────────────────────────────────────
test('askedForName — detecta a IA pedindo o nome', () => {
  assert.equal(askedForName('Antes de tudo, como posso te chamar?'), true);
  assert.equal(askedForName('Me passa seu nome completo?'), true);
  assert.equal(askedForName('Qual o seu nome?'), true);
  assert.equal(askedForName('A consulta é R$ 350 no PIX.'), false);
  assert.equal(askedForName(null), false);
});

// ── titleCaseName ───────────────────────────────────────────────────────────
test('titleCaseName — capitaliza certo', () => {
  assert.equal(titleCaseName('joão silva'), 'João Silva');
  assert.equal(titleCaseName('EDNA CARDOSO'), 'Edna Cardoso');
});
