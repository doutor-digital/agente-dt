/**
 * Item 4 da auditoria de Araguaína (21/10/2026): a Sofia interrogou uma objeção que o paciente não levantou, e não
 * deu horário.
 *
 * Lead 28740960, 17/10: "Se quiser, posso só te mostrar um horário disponível pra você ver se encaixa na sua rotina.
 * Quer que eu veja?" → "Sim" → "Me conta então: é mais o valor da consulta que pesa, ou é a questão do horário que fica
 * difícil pro seu trabalho?" e, dez minutos depois, "O que mais pesa hoje: o valor ou o horário disponível?". O horário
 * só saiu três horas depois. Regra (João): não inventar objeção; sem dúvida dele, seguir para os 2 horários.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';
import type { Fala } from './repeticao.js';
import { instrucaoSemObjecao, objecaoInventada, semASonda } from './objecao-inventada.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

// Cartão 28740960, 17/10 15:34–15:35.
const ALDEONES: Fala[] = [
  ia('Essa dor que já vem desde pequeno e agora voltou mais forte, irradiando pra perna, é exatamente o tipo de caso que a gente trata aqui.\n\nQuer que eu veja um horário pra você fazer a consulta com o especialista?'),
  ia('Aldeones, sem pressa pra decidir ☺ Se quiser, posso só te mostrar um horário disponível pra você ver se encaixa na sua rotina. Quer que eu veja?'),
  p('Sim'),
];
const SONDA_15_35 = 'Me conta então: é mais o valor da consulta que pesa, ou é a questão do horário que fica difícil pro seu trabalho? ☺';
const SONDA_15_45 = 'Aldeones, quero ajudar do jeito certo O que mais pesa hoje: o valor ou o horário disponível?';

test('"Sim" para ver um horário e a resposta pergunta o que pesa: objeção inventada', () => {
  assert.equal(objecaoInventada(ALDEONES, SONDA_15_35), SONDA_15_35);
  assert.equal(objecaoInventada(ALDEONES, SONDA_15_45), SONDA_15_45);
  assert.equal(
    // 15:23, a primeira sondagem (a frase da pergunta é a que volta)
    objecaoInventada([ia('Quer que eu veja os horários?'), p('pode ver sim')], 'Sem problemas, Aldeones! Só pra eu entender melhor: é o valor que te preocupa, o horário que não encaixa, ou você ainda tá em dúvida se isso vai resolver sua dor?'),
    'Só pra eu entender melhor: é o valor que te preocupa, o horário que não encaixa, ou você ainda tá em dúvida se isso vai resolver sua dor?',
  );
});

test('quando ELE levantou a dúvida (ou disse "não"), a sondagem pode ter razão', () => {
  for (const fala of ['Vou pensar', 'Achei caro', 'Preciso ver com meu marido', 'Não sei se dá pra mim agora', 'Não', 'Agora não']) {
    assert.equal(objecaoInventada([ia('Quer que eu veja os horários?'), p(fala)], SONDA_15_35), null, fala);
  }
});

test('resposta que segue para os horários, sem sondar, passa', () => {
  assert.equal(objecaoInventada(ALDEONES, 'Tenho horário segunda-feira, 19/10, às 08h ou às 14h — qual fica melhor pra você?'), null);
  assert.equal(objecaoInventada(ALDEONES, 'Que bom! Deixa eu ver a agenda pra você.'), null);
});

test('com horário na resposta, só a pergunta que sonda sai', () => {
  const resposta = 'Que bom, Aldeones! Tenho segunda, 19/10, às 08h ou às 14h. É o valor que te preocupa ou o horário?';
  const sonda = objecaoInventada(ALDEONES, resposta);
  assert.equal(sonda, 'É o valor que te preocupa ou o horário?');
  assert.equal(semASonda(resposta, sonda!), 'Que bom, Aldeones! Tenho segunda, 19/10, às 08h ou às 14h.');
  // a sondagem era a resposta inteira: não sobra nada para mandar
  assert.equal(semASonda(SONDA_15_35, SONDA_15_35), '');
});

test('a instrução da refeita manda seguir para os dois horários, com a fala dele', () => {
  const i = instrucaoSemObjecao('Sim');
  assert.match(i, /NÃO levantou dúvida nem objeção \(a mensagem dele foi: "Sim"\)/);
  assert.match(i, /chame consultar_horarios e\s+ofereça DOIS horários concretos/);
});

test('a regra "VOU PENSAR" do prompt só vale quando ELE disse que vai pensar', () => {
  const unidade = {
    id: 'u1',
    slug: 'teste',
    name: 'Clínica Teste',
    sourceProdutos: 'Consulta com o especialista: R$ 350 no dia ou R$ 250 antecipado no Pix.',
    personaEmojis: [],
    handoffKeywords: [],
  } as unknown as Unit;
  const prompt = composeSystemPrompt({ unit: unidade });
  const regra = prompt.slice(prompt.indexOf('"VOU PENSAR"'), prompt.indexOf('"VOU FALAR COM MEU MARIDO'));
  assert.ok(regra.length > 0, 'a regra VOU PENSAR sumiu');
  assert.match(regra, /SÓ quando ELE disse que vai pensar ou mostrou dúvida/);
  assert.match(regra, /Nunca invente objeção/);
  assert.match(regra, /"Não" curto pode estar respondendo à pergunta anterior/);
});
