import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semTravessao } from './sem-travessao.js';

test('travessão no meio da frase vira vírgula (falas reais da Aline, Salto 17/11)', () => {
  assert.equal(
    semTravessao('Sim, Jailton, se o senhor tiver a ressonância, pode trazer no dia da consulta — ela é usada como complemento.'),
    'Sim, Jailton, se o senhor tiver a ressonância, pode trazer no dia da consulta, ela é usada como complemento.',
  );
  assert.equal(
    semTravessao('Sem problema, Jailton, pode trazer do jeito que tiver — a doutora usa como complemento na avaliação.'),
    'Sem problema, Jailton, pode trazer do jeito que tiver, a doutora usa como complemento na avaliação.',
  );
  assert.equal(semTravessao('Boa tarde! Vamos marcar sim — antes, me conta: onde é a sua dor?'), 'Boa tarde! Vamos marcar sim, antes, me conta: onde é a sua dor?');
  assert.equal(semTravessao('Aqui o atendimento é particular – mas me conta'), 'Aqui o atendimento é particular, mas me conta');
});

test('sem pontuação dobrada, sem vírgula pendurada, começo de linha some', () => {
  assert.equal(semTravessao('Tudo certo! — Te espero na quinta.'), 'Tudo certo! Te espero na quinta.');
  assert.equal(semTravessao('Até quinta —'), 'Até quinta');
  assert.equal(semTravessao('— Chegar 10 minutos antes\n— Trazer documento'), 'Chegar 10 minutos antes\nTrazer documento');
  assert.equal(semTravessao('Combinado —.'), 'Combinado.');
});

test('hífen comum e travessão colado entre números/palavras ficam como hífen', () => {
  assert.equal(semTravessao('Rua Barão do Rio Branco, 425 - Centro, (11) 94246-9735'), 'Rua Barão do Rio Branco, 425 - Centro, (11) 94246-9735');
  assert.equal(semTravessao('Atendemos seg–sex, das 08–12 e 14–18. Seja bem-vindo!'), 'Atendemos seg-sex, das 08-12 e 14-18. Seja bem-vindo!');
  assert.equal(semTravessao('Sem travessão nenhum aqui.'), 'Sem travessão nenhum aqui.');
});

test('faixa de horário com espaços vira "às", não lista (revisão do sênior, #397)', () => {
  assert.equal(semTravessao('Atendemos das 08h – 12h e das 14h – 18h.'), 'Atendemos das 08h às 12h e das 14h às 18h.');
  assert.equal(semTravessao('das 8 – 12'), 'das 8 às 12');
});
