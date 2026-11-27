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
import { adiamentoDoTurno, adiouComMotivo, encerramentoParaCorte, pacienteEncerrou, renderPacienteAdiou, renderPacienteEncerrou } from './paciente-encerrou.js';

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
    'vou falar com meu marido, pode ser?',
    'vou falar com o meu marido e te aviso',
    'preciso ver com a minha mãe primeiro',
    'depois que eu receber eu te falo',
    'não tenho condições agora, só mês que vem',
    'vou conversar com o marido e te falo, tá bom?',
    'só depois do meu salário',
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
    'não tenho condições, meu salário é muito baixo',
    'já fechei com outra clínica, obrigado',
    'meu salário é baixo',
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
  assert.match(com, /só agradeceu, se despediu[^\n]*[\s\S]*NÃO proponha/);
  assert.match(com, /Nunca prometa HORA/);
  // as outras regras ficam
  for (const trecho of [/1\. Só quando o paciente QUER e adia/, /2\. ANTES de mover, salve os dois campos/, /4\. Depois disso, não mande mais nada/]) {
    assert.match(com, trecho);
  }
  assert.equal(renderEsperaRules({}, { propoeDia: true }), '', 'sem a etapa EM ESPERA, nada');
});

test('quem JÁ TEM consulta de pé segue cortado: a chave só vale sem consulta no prompt (graph.ts usa promptTemConsulta)', async () => {
  const { promptTemConsulta } = await import('./reserva-sem-marcar.js');
  assert.equal(promptTemConsulta('<consulta_do_paciente>\nEste paciente TEM consulta marcada: 20/10/2026 às 11:30\n</consulta_do_paciente>'), true);
  assert.equal(promptTemConsulta('<regras_gerais>nada de consulta marcada</regras_gerais>'), false);
});

// ── devolução do sênior (27/11): os defeitos só aparecem com a chave LIGADA ────────────────────────────────────────────────────

const DESPEDIDAS_COM_MOTIVO = [
  'Obrigada! Vou conversar com meu esposo e te retorno. Boa noite',
  'Muito obrigada pela atenção, vou ver com minha filha e qualquer coisa te chamo. Tchau',
  'Obrigado, só mês que vem. Tchau tchau',
  'ok, obrigada. Quando eu receber eu te chamo, até mais',
  'Vou falar com meu marido, obrigada, fica com Deus',
];

test('1) despedida COM motivo: o corte de 21/10 vale (5 de 5) — nada de horário, bloco de quem encerrou', () => {
  for (const frase of DESPEDIDAS_COM_MOTIVO) {
    const h = [OFERTA, p(frase)];
    assert.equal(adiouComMotivo(h), false, frase);
    // com a chave ligada o corte do grafo é IGUAL ao do main (chave desligada)
    assert.equal(encerramentoParaCorte(h, true), pacienteEncerrou(h), frase);
    assert.doesNotMatch(renderPacienteEncerrou(h, { propoeDia: true }), /paciente_adiou/, frase);
  }
  // "boa noite" só ABRINDO a fala é cumprimento, não despedida: o motivo vale
  assert.equal(adiouComMotivo([OFERTA, p('Boa noite, só recebo dia 8')]), true);
});

test('2) UMA proposta só, no código: adiar de novo depois da proposta volta ao corte do main', () => {
  const proposta = ia('Combinado! Já deixo pra quarta 09/12, depois que você receber? Tenho 7h ou 13h.');
  const segundo = [OFERTA, p('Só recebo dia 8'), proposta, p('vou falar com meu marido primeiro e depois te falo')];
  assert.equal(adiamentoDoTurno([OFERTA, p('Só recebo dia 8')]), 'propor');
  assert.equal(adiamentoDoTurno(segundo), 'ja_propos');
  assert.equal(adiouComMotivo(segundo), false);
  // o main corta ("depois te falo" = vai_se_organizar): com a chave ligada continua cortando
  assert.equal(pacienteEncerrou(segundo), 'vai_se_organizar');
  assert.equal(encerramentoParaCorte(segundo, true), 'vai_se_organizar');
  const bloco = renderPacienteEncerrou(segundo, { propoeDia: true });
  assert.match(bloco, /adiou de novo[\s\S]*NÃO proponha horário outra vez/);
  // o adiamento de ANTES de qualquer proposta continua propondo
  assert.equal(adiamentoDoTurno([ia('Qual horário fica melhor?'), p('só recebo dia 5')]), 'propor');
});

test('5) quem já ESCOLHEU horário não vira "adiou": a escolha vence', () => {
  for (const frase of [
    'Pode ser segunda às 8h, só recebo dia 5 mas pago no dia',
    'quero terça às 14h, mas só recebo dia 10',
    'pode ser quarta de manhã, vou falar com meu marido hoje à noite',
  ]) {
    assert.equal(adiouComMotivo([OFERTA, p(frase)]), false, frase);
    assert.doesNotMatch(renderPacienteEncerrou([OFERTA, p(frase)], { propoeDia: true }), /paciente_adiou/, frase);
  }
});

test('6) frases comuns reconhecidas e alinhadas com o corte: onde a regra 3 manda propor, o código não corta', () => {
  for (const frase of ['vou falar com o meu marido', 'vou conversar com a minha mãe', 'depois que eu receber eu te falo', 'não tenho condições agora, só mês que vem']) {
    const h = [OFERTA, p(frase)];
    assert.equal(adiouComMotivo(h), true, frase);
    assert.equal(encerramentoParaCorte(h, true), null, `${frase}: sem corte`);
  }
  // e onde o código corta, a regra 3 manda NÃO propor e diz quem decide
  const com = renderEsperaRules({ waiting_deferred: 111 }, { propoeDia: true });
  assert.match(com, /disse só "vou pensar"\/"te aviso" sem motivo nem\s+data/);
  assert.match(com, /<paciente_adiou> = proponha uma vez; <paciente_encerrou> = nada\s+de horário/);
  assert.match(com, /UMA proposta só/);
});

test('nit: a regra 4 do EM ESPERA deixa responder à proposta em aberto', () => {
  const com = renderEsperaRules({ waiting_deferred: 111 }, { propoeDia: true });
  assert.match(com, /4\. Depois disso[^\n]*EXCETO responder se ele responder à proposta/);
  assert.match(renderEsperaRules({ waiting_deferred: 111 }), /4\. Depois disso, não mande mais nada nesta conversa até a data\. A retomada é automática\./);
});

test('nit: o prompt confere consulta marcada como o grafo — com consulta de pé, bloco de quem encerrou (sem proposta)', () => {
  const un = { id: 'u-x', slug: 'doutor-hernia-araguaina', name: 'x', personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
  _semearParaTeste([{ slug: 'doutor-hernia-araguaina', automacao: 'adiamento-propoe-dia', estado: 'ligado' }]);
  const historico = [OFERTA, p('só recebo dia 8')];
  const consulta = { estado: 'confirmada', quando: '2099-12-01T09:00', idSchedule: 1 } as never;
  const com = composeSystemPrompt({ unit: un, historico, consulta });
  assert.doesNotMatch(com, /<paciente_adiou>/);
  assert.match(composeSystemPrompt({ unit: un, historico }), /<paciente_adiou>/);
});
