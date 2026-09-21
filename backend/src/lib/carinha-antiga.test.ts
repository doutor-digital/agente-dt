import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semCarinha, semCarinhaLigado } from './carinha-antiga.js';

test('lista vazia mantém o comportamento antigo', () => {
  assert.equal(semCarinhaLigado('doutor-hernia-taubate', ''), false);
  assert.equal(semCarinhaLigado('doutor-hernia-taubate', undefined), false);
});

test('só a unidade da lista fica sem carinha', () => {
  assert.equal(semCarinhaLigado('doutor-hernia-taubate', 'doutor-hernia-taubate'), true);
  assert.equal(semCarinhaLigado('doutor-hernia-serra', 'doutor-hernia-taubate'), false);
  assert.equal(semCarinhaLigado('qualquer', '*'), true);
});

test('unidade sem slug nunca liga', () => {
  assert.equal(semCarinhaLigado(null, '*'), false);
});

test('tira o ☺ que sai em 72% das mensagens de Taubaté', () => {
  // frase real, Taubaté, 20/09/2026
  assert.equal(
    semCarinha('Consegui sim, Betânia! Na terça-feira tenho às 10:00 ou às 15:00. Qual prefere? ☺'),
    'Consegui sim, Betânia! Na terça-feira tenho às 10:00 ou às 15:00. Qual prefere?',
  );
});

test('tira também a carinha triste no meio da frase', () => {
  assert.equal(semCarinha('Poxa, isso é sofrido ☹ Dá pra sentir o peso.'), 'Poxa, isso é sofrido Dá pra sentir o peso.');
});

test('pega o emoji ANTES de virar ☺ — é lá que a gente corta', () => {
  assert.equal(semCarinha('Tudo certo 😊'), 'Tudo certo');
  assert.equal(semCarinha('Que pena 😢'), 'Que pena');
  assert.equal(semCarinha('Oi 🙂 tudo bem?'), 'Oi tudo bem?');
});

test('não encosta nos outros emojis', () => {
  assert.equal(semCarinha('Obrigada 🙏'), 'Obrigada 🙏');
  assert.equal(semCarinha('Combinado 👍'), 'Combinado 👍');
  assert.equal(semCarinha('Consulta ⭐ marcada'), 'Consulta ⭐ marcada');
});

test('não deixa espaço nem pontuação solta', () => {
  assert.equal(semCarinha('Perfeito ☺ !'), 'Perfeito!');
  assert.equal(semCarinha('Oi ☺, tudo bem?'), 'Oi, tudo bem?');
});
