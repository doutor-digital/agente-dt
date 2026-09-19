import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semCoracao, temCoracao } from './sem-coracao.js';

test('tira o ♥ que estava saindo em 17% das mensagens', () => {
  // frase real, Açailândia, 19/09/2026
  assert.equal(semCoracao('Prazer, Daiane! ♥ Me conta uma coisa:'), 'Prazer, Daiane! Me conta uma coisa:');
});

test('coração no fim não deixa espaço sobrando', () => {
  assert.equal(semCoracao('Posso te ajudar em mais alguma coisa agora? ♥'), 'Posso te ajudar em mais alguma coisa agora?');
});

test('pega todas as cores e formatos', () => {
  for (const c of ['❤️', '❤', '♥', '♡', '❣', '💙', '💚', '💛', '🧡', '💜', '🤍', '🖤', '🤎', '💕', '💖', '💗', '💓', '💝', '💞', '💘', '🩷']) {
    assert.equal(semCoracao(`oi ${c} tudo bem`), 'oi tudo bem', `falhou em ${c}`);
  }
});

test('o seletor de variação invisível não fica pra trás', () => {
  const comSeletor = 'Até logo ❤️';
  assert.equal(semCoracao(comSeletor), 'Até logo');
  assert.equal(/️/.test(semCoracao(comSeletor)), false);
});

test('não encosta nos outros emojis', () => {
  assert.equal(semCoracao('Combinado ☺ até terça!'), 'Combinado ☺ até terça!');
  assert.equal(semCoracao('Obrigada 🙏'), 'Obrigada 🙏');
  assert.equal(semCoracao('Perfeito 👍'), 'Perfeito 👍');
});

test('🙏 não é coração — a flag u impede o falso positivo', () => {
  // sem a flag `u`, o JS compara metade de par substituto e 🙏 casa com 💗
  assert.equal(temCoracao('🙏'), false);
  assert.equal(temCoracao('💗'), true);
});

test('pontuação não fica separada do texto', () => {
  assert.equal(semCoracao('Que bom ♥ !'), 'Que bom!');
  assert.equal(semCoracao('Oi ♥, tudo bem?'), 'Oi, tudo bem?');
});

test('texto sem coração passa intacto', () => {
  const t = 'Consulta marcada para terça-feira, 22/09 às 09:00.';
  assert.equal(semCoracao(t), t);
});

test('texto vazio não quebra', () => {
  assert.equal(semCoracao(''), '');
});
