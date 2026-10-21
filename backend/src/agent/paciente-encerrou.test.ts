/**
 * Item 3 da auditoria de Araguaína (21/10/2026): a Sofia empurrava horário depois de agradecimento/despedida.
 *
 *  - Lead 28743600, 17/10 18:13–18:14: "Tabom" / "Muito obrigado pelo atendimento" → "Eu que agradeço!… pra eu
 *    garantir sua vaga de segunda (19/10): fica melhor às 08h, 14h ou 16h?". E em 19/10 08:28, "tabom" → "consegue me
 *    dizer se prefere o horário de segunda (19/10) às 08h, 14h ou 16h?".
 *  - Lead 28659614: "Ok obrigado" → "Posso contar que você vem na segunda, dia 19/10, às 16h?".
 *
 * Regra (João): agradeceu/encerrou ou disse que vai se organizar → resposta curta e calorosa, SEM pergunta de horário;
 * quem retoma é a régua. Estes testes prendem o reconhecimento do encerramento, o bloco do prompt, o juiz da pergunta
 * final (que não cobra mais pergunta nesse caso) e o corte do empurrão na resposta pronta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { ehEncerramento } from '../lib/encerramento.js';
import { avaliarChamadaFinal } from './cta-final.js';
import { composeSystemPrompt } from './prompt-composer.js';
import type { Fala } from './repeticao.js';
import { COMBINADO_CURTO, DESPEDIDA_CURTA, empurraHorario, pacienteEncerrou, renderPacienteEncerrou, semEmpurrarHorario } from './paciente-encerrou.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

// Cartão 28743600, 17/10.
const ANTONIA_17_10: Fala[] = [
  ia('A consulta é R$ 350 pagando na clínica no dia, ou R$ 250 se você pagar antes, antecipado por Pix — é o Pix que garante sua reserva no horário.\n\nPensando no seu caso, qual desses horários de segunda (19/10) fica melhor: 08h, 14h ou 16h? ☺'),
  p('[áudio]: vou ver aqui direitinho como vou me organizar e te falo'),
  ia('Pode ser sim, Antônia ☺ Sem problema nenhum, você merece se organizar com calma. Fico no aguardo do seu retorno pra garantir seu horário de segunda, tá bom? Qualquer coisa, é só me chamar por aqui!'),
  p('Tabom'),
  p('Muito obrigado pelo atendimento'),
];
const RESPOSTA_17_10 = 'Eu que agradeço, Antônia!  Fico feliz em poder te ajudar nesse momento.\n\nEntão, pra eu garantir sua vaga de segunda (19/10): fica melhor às 08h, 14h ou 16h? ☺';

// Cartão 28743600, 19/10.
const ANTONIA_19_10: Fala[] = [
  p('Bom dia'),
  ia('Bom dia, Antônia! ☺ Que bom ter você por aqui!\n\nFico à disposição, tá? Qualquer coisa é só me chamar'),
  p('tabom'),
];
const RESPOSTA_19_10 = 'Antônia, pra eu deixar tudo certo: consegue me dizer se prefere o horário de segunda (19/10) às 08h, 14h ou 16h? ☺ Assim já encaminho pra equipe confirmar sua vaga!';

// Cartão 28659614, 15/10.
const JOAO_15_10: Fala[] = [
  ia('Sem problemas, João! Vou deixar reservado o horário de segunda, 19/10, às 16h no seu nome. Assim que chegar em Araguaína, é só vir direto pra clínica — combinado?'),
  p('Ok obrigado'),
];
const RESPOSTA_15_10 = 'Isso, João! Fico no aguardo então, e quando estiver chegando pode me chamar que eu te passo tudo certo de novo ☺ Posso contar que você vem na segunda, dia 19/10, às 16h?';

test('"Tabom" e "Muito obrigado pelo atendimento" são encerramento (a frase longa não sobra pela metade)', () => {
  assert.equal(ehEncerramento('Tabom'), true);
  assert.equal(ehEncerramento('Muito obrigado pelo atendimento'), true);
  assert.equal(ehEncerramento('muito obrigada pela atenção'), true);
});

test('reconhece o encerramento das três conversas', () => {
  assert.equal(pacienteEncerrou(ANTONIA_17_10), 'agradeceu');
  assert.equal(pacienteEncerrou(ANTONIA_19_10), 'concordou'); // "tabom" depois de ela já ter fechado
  assert.equal(pacienteEncerrou(JOAO_15_10), 'agradeceu');
  assert.equal(pacienteEncerrou([ia('Quer que eu veja um horário pra você?'), p('vou me organizar aqui e te aviso')]), 'vai_se_organizar');
});

test('sim, cumprimento, ok a uma pergunta e pergunta nova não são encerramento', () => {
  const pergunta = ia('Tenho segunda às 08h ou às 14h. Qual fica melhor?');
  assert.equal(pacienteEncerrou([ia('Quer que eu veja um horário pra você?'), p('Sim')]), null);
  assert.equal(pacienteEncerrou([ia('Posso confirmar segunda às 16h?'), p('Sim, obrigado')]), null);
  assert.equal(pacienteEncerrou([p('Bom dia')]), null);
  assert.equal(pacienteEncerrou([pergunta, p('ok')]), null);
  assert.equal(pacienteEncerrou([pergunta, p('Obrigado! E quanto custa?')]), null);
  assert.equal(pacienteEncerrou([pergunta, p('Obrigado, pode ser às 14h')]), null);
});

test('o prompt do turno ganha o bloco <paciente_encerrou> só quando ele encerrou', () => {
  const bloco = renderPacienteEncerrou(ANTONIA_17_10);
  assert.match(bloco, /<paciente_encerrou>/);
  assert.match(bloco, /NÃO ofereça horário/);
  assert.match(bloco, /NÃO faça outra pergunta/);
  assert.equal(renderPacienteEncerrou([ia('Quer que eu veja um horário pra você?'), p('Sim')]), '');

  const unidade = { id: 'u1', slug: 'teste', name: 'Clínica Teste', personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
  assert.match(composeSystemPrompt({ unit: unidade, historico: ANTONIA_17_10 }), /<paciente_encerrou>/);
  const semEncerrar = composeSystemPrompt({ unit: unidade, historico: [ia('Quer que eu veja um horário pra você?'), p('Sim')] });
  assert.doesNotMatch(semEncerrar, /<paciente_encerrou>/);
  // o bloco diz que vale mais que a regra da pergunta de continuidade (a regra geral fica como estava: ela também vai
  // no prompt da régua, que tem teto de tamanho)
  assert.match(bloco, /vale mais que a regra da pergunta de continuidade/);
});

test('o juiz da pergunta final não cobra pergunta de quem encerrou', () => {
  const despedida = 'Eu que agradeço, Antônia! Fico feliz em poder te ajudar nesse momento.';
  assert.equal(avaliarChamadaFinal(despedida).precisaRefazer, true); // era aqui que a pergunta do horário voltava
  assert.equal(avaliarChamadaFinal(despedida, { pacienteEncerrou: true }).precisaRefazer, false);
});

test('as respostas reais empurravam horário; o empurrão sai e fica a parte calorosa', () => {
  const agora17 = '2026-10-17T18:14';
  assert.equal(empurraHorario(RESPOSTA_17_10, agora17), true);
  assert.equal(semEmpurrarHorario(RESPOSTA_17_10, agora17, 'agradeceu'), 'Eu que agradeço, Antônia!  Fico feliz em poder te ajudar nesse momento.');

  const agora15 = '2026-10-15T12:53';
  assert.equal(empurraHorario(RESPOSTA_15_10, agora15), true);
  assert.equal(
    semEmpurrarHorario(RESPOSTA_15_10, agora15, 'agradeceu'),
    'Isso, João! Fico no aguardo então, e quando estiver chegando pode me chamar que eu te passo tudo certo de novo ☺',
  );

  // a de 19/10 era só o empurrão ("Assim já encaminho…" não se sustenta sem a pergunta): sai o "combinado" curto
  const agora19 = '2026-10-19T08:29';
  assert.equal(empurraHorario(RESPOSTA_19_10, agora19), true);
  assert.equal(semEmpurrarHorario(RESPOSTA_19_10, agora19, 'concordou'), COMBINADO_CURTO);
  assert.equal(semEmpurrarHorario('Fica melhor às 08h ou às 14h? ☺\n[[botoes: Seg 08h | Seg 14h]]', agora19, 'agradeceu'), DESPEDIDA_CURTA);
});

test('despedida certa passa sem corte', () => {
  for (const t of [
    'Eu que agradeço, Antônia! Qualquer coisa, é só me chamar por aqui ☺',
    'Por nada, João! Te espero segunda, 19/10, às 16h. Até lá ☺',
    'Imagina! Fico à disposição, tá?',
  ]) {
    assert.equal(empurraHorario(t, '2026-10-17T18:14'), false, t);
  }
});
