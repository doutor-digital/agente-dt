/**
 * Chave `adiamento-propoe-dia` (decisão do João, 27/11/2026). Frases reais do relatório ops/relatorios/2026-11-27-por-que-sofia-nao-converte.md
 * (L1-04: "Só recebo dia 8" → "Vou te procurar no dia 08/12"): quem adia dizendo o motivo ou o quando recebe um dia e dois horários reais;
 * quem só agradece, se despede, recusa ou diz "vou ver e te aviso" sem motivo NÃO — o corte de 21/10 (Araguaína, commit 13cfbaf9) fica.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { composeSystemPrompt, renderEsperaRules } from './prompt-composer.js';
import type { Fala } from './repeticao.js';
import { adiouComMotivo, encerramentoParaCorte, pacienteEncerrou, renderPacienteAdiou, renderPacienteEncerrou } from './paciente-encerrou.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });
const OFERTA = ia('A consulta é R$ 350. Tenho segunda às 8h ou terça às 14h. Qual fica melhor?');

after(() => _semearParaTeste([]));

test('adiou com motivo ou data: as frases reais dos pacientes', () => {
  for (const frase of [
    'Só recebo dia 8',
    'só recebo dia 5, depois eu falo com vocês',
    'vou falar com meu esposo e te aviso',
    'Preciso conversar com minha esposa antes',
    'vou ver isso com meu filho',
    'quando eu receber eu te chamo',
    'tô viajando, volto semana que vem',
    'só mês que vem',
    'depois do dia 05 de dezembro eu vejo',
    'a partir do dia 10 eu consigo',
    'esse mês não dá, só no outro',
  ]) {
    assert.equal(adiouComMotivo([OFERTA, p(frase)]), true, frase);
  }
});

test('NÃO é adiamento com motivo: despedida, recusa, "vou ver e te aviso" sem motivo, pergunta, pedido', () => {
  for (const frase of [
    'Muito obrigado pelo atendimento',
    'tabom',
    'ok obrigada, até mais',
    'agora não posso, vou me organizar e te aviso depois',
    'vou ver e te aviso',
    'não quero, já resolvi',
    'não tenho interesse, obrigado',
    'desisti de tratar',
    'vocês recebem convênio?',
    'se eu só receber dia 8, tem horário?',
    'quero marcar para segunda',
    '',
  ]) {
    assert.equal(adiouComMotivo([OFERTA, p(frase)]), false, frase);
  }
  assert.equal(adiouComMotivo(undefined), false);
});

test('o corte de 21/10 preservado: com a chave, quem só agradece ou diz "vou me organizar" segue "encerrou" (sem horário empurrado)', () => {
  const despede = [OFERTA, p('Muito obrigado pelo atendimento')];
  assert.equal(encerramentoParaCorte(despede, true), 'agradeceu');
  assert.equal(encerramentoParaCorte(despede, false), 'agradeceu');
  const semMotivo = [OFERTA, p('agora não posso, vou me organizar e te aviso depois')];
  assert.equal(encerramentoParaCorte(semMotivo, true), 'vai_se_organizar');
  assert.match(renderPacienteEncerrou(semMotivo, { propoeDia: true }), /NÃO ofereça horário/);
  assert.doesNotMatch(renderPacienteEncerrou(semMotivo, { propoeDia: true }), /paciente_adiou/);
});

test('com a chave, quem adiou COM motivo deixa de ser "encerrou" (o corte do empurrão e o bloqueio da trava do horário não valem)', () => {
  // exemplo que hoje já é cortado: "vou me organizar" COM motivo ("quando receber")
  const adiou = [OFERTA, p('vou me organizar e quando receber eu te falo')];
  assert.equal(pacienteEncerrou(adiou), 'vai_se_organizar', 'sem a chave: como sempre');
  assert.equal(encerramentoParaCorte(adiou, false), 'vai_se_organizar');
  assert.equal(encerramentoParaCorte(adiou, true), null, 'com a chave: pode propor o dia');
});

test('o bloco do turno: propõe UM dia e DOIS horários de consultar_horarios, só marca se ele escolher, não inventa vaga', () => {
  const b = renderPacienteEncerrou([OFERTA, p('Só recebo dia 8')], { propoeDia: true });
  assert.match(b, /^<paciente_adiou>/);
  assert.match(b, /chame consultar_horarios/);
  assert.match(b, /UM dia com os DOIS horários que a agenda devolveu/);
  assert.match(b, /Tenho \{h1\} ou \{h2\}/);
  assert.match(b, /SÓ de consultar_horarios; nunca invente vaga/);
  assert.match(b, /Só chame agendar_consulta se ele ESCOLHER/);
  assert.match(b, /JÁ TEM consulta marcada[^\n]*NÃO proponha outro horário/);
  assert.match(b, /Se ele recusar marcar agora[^\n]*aceite sem insistir/);
  assert.match(b, /NUNCA diga que está reservado/);
  assert.equal(b, renderPacienteAdiou());
  // sem a chave: nada disso — o bloco é o de sempre
  assert.doesNotMatch(renderPacienteEncerrou([OFERTA, p('Só recebo dia 8')]), /paciente_adiou/);
});

test('o prompt completo: chave ligada na unidade traz <paciente_adiou>; em outra unidade nada muda', () => {
  const un = (slug: string) => ({ id: `u-${slug}`, slug, name: slug, personaEmojis: [], handoffKeywords: [] }) as unknown as Unit;
  _semearParaTeste([{ slug: 'doutor-hernia-araguaina', automacao: 'adiamento-propoe-dia', estado: 'ligado' }]);
  const historico = [OFERTA, p('vou falar com meu esposo e te aviso')];
  assert.match(composeSystemPrompt({ unit: un('doutor-hernia-araguaina'), historico }), /<paciente_adiou>/);
  const outra = composeSystemPrompt({ unit: un('doutor-hernia-imperatriz'), historico });
  assert.doesNotMatch(outra, /<paciente_adiou>/);
});

test('EM ESPERA, regra 3: com a chave propõe dia + dois horários reais; sem a chave o texto é byte a byte o de sempre', () => {
  const sem = renderEsperaRules({ waiting_deferred: 111 });
  const com = renderEsperaRules({ waiting_deferred: 111 }, { propoeDia: true });
  assert.match(sem, /3\. Responda combinando a volta — "combinado, te procuro no dia DD\/MM/);
  assert.equal(renderEsperaRules({ waiting_deferred: 111 }, { propoeDia: false }), sem);
  assert.match(com, /3\. Responda ao adiamento COM UM DIA E DOIS HORÁRIOS/);
  assert.match(com, /chame consultar_horarios/);
  assert.match(com, /nunca invente vaga/);
  assert.match(com, /Só chame\s+agendar_consulta se ele ESCOLHER/);
  assert.match(com, /só agradeceu, se despediu ou recusou, NÃO empurre horário/);
  assert.match(com, /Nunca prometa HORA/);
  // as outras regras ficam
  for (const trecho of [/1\. Só quando o paciente QUER e adia/, /2\. ANTES de mover, salve os dois campos/, /4\. Depois disso, não mande mais nada/]) {
    assert.match(com, trecho);
  }
  assert.equal(renderEsperaRules({}, { propoeDia: true }), '', 'sem a etapa EM ESPERA, nada');
});
