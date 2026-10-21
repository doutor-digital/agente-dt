import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nomeApresentavel, saudacao, semNomeDoPerfil, vocativo } from './nome-apresentavel.js';

test('o nome que a Sofia gravou no título vale, sem a data do fim', () => {
  assert.equal(nomeApresentavel('CRISTINA REGIA 15/10/26', null), 'Cristina');
  assert.equal(nomeApresentavel('Índia Narah 11/10/26', 'india narah'), 'Índia');
  assert.equal(nomeApresentavel('DARIO 14/10/2026', 'Dario Araújo Souza'), 'Dario');
  assert.equal(nomeApresentavel('Dayse Moreira 28/04/25 Sem Origem', null), 'Dayse');
  assert.equal(nomeApresentavel('Maria (mãe do João)', null), 'Maria');
  assert.equal(nomeApresentavel('Dra. Ana Lima', null), 'Ana');
});

test('Araguaína, lead 28659614: título "ANTONIO 15/10/26" ganha do perfil "Meu Único Amigo É Deus"', () => {
  assert.equal(nomeApresentavel('ANTONIO 15/10/26', 'Meu Único Amigo É Deus'), 'Antonio');
  assert.equal(nomeApresentavel(null, 'Meu Único Amigo É Deus'), null, 'só o perfil: frase, não nome');
});

test('título sem nome: o perfil do WhatsApp só serve quando parece nome próprio', () => {
  assert.equal(nomeApresentavel('Lead #28222940', 'india narah'), 'India');
  assert.equal(nomeApresentavel('Lead #2 25/09/2026', '✨ Júlia ✨'), 'Júlia');
  assert.equal(nomeApresentavel('Obg 20/10/2026', 'Rosa❤️'), 'Rosa', 'título com resto de conversa não vale');
  assert.equal(nomeApresentavel(null, 'Pastor João Batista'), 'João');
  assert.equal(nomeApresentavel(null, 'Maria de Jesus'), 'Maria');
  assert.equal(nomeApresentavel(null, 'Maria da Luz'), 'Maria');
  assert.equal(nomeApresentavel(null, 'José Filho'), 'José');
  assert.equal(nomeApresentavel(null, 'Vitória'), 'Vitória');
});

test('vazio, e-mail, telefone, frase, emoji, apelido e loja: sem nome', () => {
  for (const perfil of [
    '', ' , ', ',', '😃', 'maria.silva@gmail.com', '+55 99 90000-0043', // vazio, e-mail, telefone
    'Meu Único Amigo É Deus', 'Deus é fiel', 'Quero saber o valor', 'Flamengo até morrer', // frase
    'tricolor', 'Princesa', 'Neguinho', 'Ocupado', 'Tia', 'Aaaa', 'Luz', // apelido, recado, enfeite
    'Space Conv. Hookah', 'Leily Espaço Diva', 'ARENA SABOR', // loja (vistos em Canaã, 19/10)
  ]) {
    assert.equal(nomeApresentavel(null, perfil), null, perfil);
  }
  assert.equal(nomeApresentavel('Lead 22261987', null), null);
  assert.equal(nomeApresentavel(undefined, undefined), null);
});

test('saudação: "Olá, Maria!" ou "Olá!" — nunca "Olá, ," nem "Olá, tricolor"', () => {
  assert.equal(saudacao('Maria Souza'), 'Olá, Maria!');
  assert.equal(saudacao(null), 'Olá!');
  assert.equal(saudacao(' , '), 'Olá!');
  assert.equal(saudacao('tricolor'), 'Olá!');
  assert.equal(saudacao('Meu Único Amigo É Deus', 'Oi'), 'Oi!');
  assert.equal(vocativo('Índia'), ', Índia');
  assert.equal(vocativo('maria@x.com'), '');
});

test('régua gerada pelo modelo: o nome do perfil que não é nome sai do vocativo; nome bom fica', () => {
  assert.equal(semNomeDoPerfil('Oi, Tricolor! Tudo bem por aí?', 'tricolor'), 'Oi! Tudo bem por aí?');
  assert.equal(semNomeDoPerfil('Olá Meu Único Amigo É Deus, tudo certo?', 'Meu Único Amigo É Deus'), 'Olá, tudo certo?');
  assert.equal(semNomeDoPerfil('Tudo certo, Space? Posso ver um horário?', 'Space Conv. Hookah'), 'Tudo certo? Posso ver um horário?');
  assert.equal(semNomeDoPerfil('Oi, Maria! Tudo bem?', 'Maria Souza'), 'Oi, Maria! Tudo bem?');
  assert.equal(semNomeDoPerfil('Oi, tudo bem?', 'tricolor'), 'Oi, tudo bem?');
  assert.equal(semNomeDoPerfil('Oi! Tudo bem?', null), 'Oi! Tudo bem?');
});
