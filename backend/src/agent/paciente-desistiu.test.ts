/**
 * Item 6 da Suzanne (25/10/2026) + decisão do coordenador (26/10, depois da reprovação do sênior no #132):
 * a Sofia tenta remarcar e NUNCA cancela na franquia; na recusa explícita ela se despede sem dizer que cancelou e o sistema
 * (lib/desistencia-acao.ts) avisa a equipe; na dúvida ela responde normal e o sistema abre "conferir com o paciente".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';
import type { Fala } from './repeticao.js';
import { acaoDaDesistencia, pacienteDesistiu, renderPacienteDesistiu } from './paciente-desistiu.js';
import {
  falouDeOutraConsulta,
  hesitou,
  oferecuHorario,
  pareceDesistenciaDaConsulta,
  quisManter,
  recusouRemarcarExplicitamente,
} from '../lib/desistencia-frases.js';
import { pareceDesistencia } from '../lib/vespera-segura.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });
const OFERTA = 'Tudo bem! Se quiser, tenho sexta às 10h ou segunda às 14h. Qual fica melhor?';
const LILIANE = [ia('Olá! Sua consulta é amanhã, 23/10, às 14:00. Posso confirmar?'), p('Cancelei.')];
const COM_OFERTA = (resposta: string): Fala[] => [ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p(resposta)];

test('"Cancelei." depois do lembrete → o bloco manda REMARCAR; nunca cancelar, nunca "tem certeza?"', () => {
  assert.equal(pacienteDesistiu(LILIANE)?.trecho, 'Cancelei.');
  assert.equal(acaoDaDesistencia(pacienteDesistiu(LILIANE)), 'oferta');
  const bloco = renderPacienteDesistiu(LILIANE);
  assert.match(bloco, /<paciente_desistiu>/);
  assert.match(bloco, /TENTA REMARCAR/);
  assert.match(bloco, /consultar_horarios/);
  assert.match(bloco, /DOIS horários reais/);
  assert.match(bloco, /remarcar_consulta/);
  assert.match(bloco, /NÃO pergunte "tem certeza\?"/);
  assert.match(bloco, /NÃO chame cancelar_consulta/);
  assert.match(bloco, /NÃO diga que cancelou/);
  assert.match(bloco, /Se não tem/, 'sem consulta marcada o bloco manda ignorar');
});

test('as mensagens seguidas do turno contam; a de antes da última fala da Sofia só como o par da oferta', () => {
  assert.equal(pacienteDesistiu([ia('Quer horário?'), p('oi'), p('tive um imprevisto, não vou poder ir')])?.trecho, 'tive um imprevisto, não vou poder ir');
  assert.equal(pacienteDesistiu([p('Cancelei.'), ia('Sem problema! Posso te oferecer sexta às 14h ou segunda às 9h?'), p('segunda às 9h')])?.momento, 'respondeu_a_oferta');
});

test('conversa normal não ganha o bloco', () => {
  assert.equal(renderPacienteDesistiu([ia('Quer que eu veja um horário?'), p('Sim')]), '');
  assert.equal(renderPacienteDesistiu([ia('Segue o contrato'), p('Segue o print do cancelamento de contrato')]), '');
  assert.equal(renderPacienteDesistiu(undefined), '');
  assert.equal(renderPacienteDesistiu([]), '');
});

test('o prompt do turno ganha o bloco só quando ele desistiu', () => {
  const unidade = { id: 'u1', slug: 'teste', name: 'Clínica Teste', personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
  assert.match(composeSystemPrompt({ unit: unidade, historico: LILIANE }), /<paciente_desistiu>/);
  assert.doesNotMatch(composeSystemPrompt({ unit: unidade, historico: [ia('Quer que eu veja um horário pra você?'), p('Sim')] }), /<paciente_desistiu>/);
});

// ── a ação do SISTEMA por situação ────────────────────────────────────────────────────────────────────────────────

test('RECUSA EXPLÍCITA depois da oferta: a Sofia se despede SEM dizer que cancelou; o sistema avisa a equipe', () => {
  for (const r of ['não quero remarcar', 'pode cancelar mesmo', 'desisti']) {
    const falas = COM_OFERTA(r);
    assert.equal(acaoDaDesistencia(pacienteDesistiu(falas)), 'recusou', r);
    const bloco = renderPacienteDesistiu(falas, { slug: 'doutor-hernia-araguaina' });
    assert.match(bloco, /RECUSA EXPLÍCITA: despeça-se/, r);
    assert.match(bloco, /NÃO diga que a consulta foi cancelada/, r);
    assert.match(bloco, /vou avisar a equipe para cancelar/, r);
    assert.match(bloco, /NÃO chame cancelar_consulta e NÃO crie tarefa/, r);
    assert.doesNotMatch(bloco, /Confirmo o cancelamento/, r);
  }
});

test('DÚVIDA (hesitou, quer manter, insistiu sem recusa clara): responde normal, não cancela, o sistema abre "conferir"', () => {
  for (const r of ['acho que não vou conseguir', 'vou ver', 'depois eu aviso', 'Não quero remarcar, quero manter', 'não preciso remarcar, vou sim', 'cancela não']) {
    const falas = COM_OFERTA(r);
    assert.equal(acaoDaDesistencia(pacienteDesistiu(falas)), 'duvida', r);
    const bloco = renderPacienteDesistiu(falas, { slug: 'x' });
    assert.match(bloco, /NÃO diga que cancelou, NÃO chame cancelar_consulta/, r);
    assert.doesNotMatch(bloco, /RECUSA EXPLÍCITA/, r);
  }
  // não vou poder ir de novo, sem dizer "não quero remarcar": ainda é dúvida
  assert.equal(acaoDaDesistencia(pacienteDesistiu(COM_OFERTA('não vou poder ir mesmo'))), 'duvida');
});

test('resposta que não é recusa nem dúvida (escolheu horário, perguntou o valor, agradeceu) → o sistema não faz nada', () => {
  for (const r of ['sexta às 10h', 'quanto custa?', 'obrigada']) {
    assert.equal(acaoDaDesistencia(pacienteDesistiu(COM_OFERTA(r))), 'nada', r);
  }
  assert.equal(acaoDaDesistencia(null), 'nada');
});

test('OUTRA consulta: não cancela, o sistema abre "conferir"', () => {
  for (const frase of ['cancela a do meu filho, a minha mantém', 'cancela a minha de terça e deixa a de quinta', 'preciso cancelar a consulta da minha mãe']) {
    const falas = [ia('Sua consulta é amanhã. Posso confirmar?'), p(frase)];
    assert.equal(pacienteDesistiu(falas)?.momento, 'outra_consulta', frase);
    assert.equal(acaoDaDesistencia(pacienteDesistiu(falas)), 'duvida', frase);
    assert.equal(pareceDesistenciaDaConsulta(frase), false, 'não cala a véspera de quem mantém a sua');
    assert.match(renderPacienteDesistiu(falas), /NÃO chame cancelar_consulta e NÃO diga que cancelou/);
  }
  for (const t of ['quero marcar a consulta da minha esposa também', 'a consulta do meu pai é amanhã']) {
    assert.equal(pacienteDesistiu([ia('Posso ajudar?'), p(t)]), null, t);
  }
});

test('a oferta em DUAS mensagens da Sofia não faz o bloco sumir', () => {
  const falas = [p('Cancelei.'), ia('Entendo, vou ver os horários.'), ia('Tenho sexta 30/10 às 14h ou sábado 31/10 às 10h. Qual prefere?'), p('não quero remarcar')];
  assert.equal(pacienteDesistiu(falas)?.momento, 'respondeu_a_oferta');
  assert.equal(acaoDaDesistencia(pacienteDesistiu(falas)), 'recusou');
});

// ── um teste por frase (sênior, #132) ────────────────────────────────────────────────────────────────────────────

for (const frase of ['Não quero remarcar, quero manter', 'não preciso remarcar, vou sim', 'não quero outro dia, prefiro manter a de amanhã', 'consegui me organizar, não vou mais faltar', 'cancela não']) {
  test(`"${frase}" é MANTER, não recusa: nunca silencia véspera nem régua`, () => {
    assert.equal(recusouRemarcarExplicitamente(frase), false);
    assert.equal(pareceDesistenciaDaConsulta(frase), false);
    assert.equal(pareceDesistencia(frase), false, 'a véspera continua saindo');
  });
}

for (const frase of ['não vou mais atrasar, prometo', 'Não vou mais esquecer', 'não vou mais demorar', 'não vou mais faltar']) {
  test(`nit: "${frase}" não é desistência`, () => {
    assert.equal(pareceDesistenciaDaConsulta(frase), false);
  });
}

// itens 3 e 4 da 3ª reprovação: decidem se a véspera para
for (const [frase, desiste] of [
  ['Cancela não vou mais', true],
  ['cancela n vou poder ir', true],
  ['pode cancelar a do dia 29', true],
  ['cancela a de amanhã por favor', true],
  ['n vou conseguir manter a consulta', true],
  ['não sei se vou conseguir manter, pode cancelar', true],
  ['cancela a consulta, não tenho como ir de carro', true],
  ['Não vou conseguir manter a consulta de amanhã', true],
  ['Eu vou viajar, não vou poder ir', true],
] as Array<[string, boolean]>) {
  test(`desistência real: "${frase}"`, () => {
    assert.equal(pareceDesistenciaDaConsulta(frase), desiste);
    assert.equal(quisManter(frase), false, 'não é "manter"');
    assert.equal(falouDeOutraConsulta(frase), false, 'não é "outra consulta"');
    assert.equal(pareceDesistencia(frase), true, 'a véspera para');
  });
}

test('"não vou ir de carro, vou de ônibus" não é desistência; "cancela o lembrete, eu vou" também não', () => {
  assert.equal(pareceDesistenciaDaConsulta('não vou ir de carro, vou de ônibus'), false);
  assert.equal(pareceDesistenciaDaConsulta('Cancela o lembrete, eu vou'), false);
});

test('oferta de UM horário também é oferta; "amanhã" casa; funcionamento e lembrete não são oferta', () => {
  assert.equal(oferecuHorario('Que tal quinta às 14h?'), true);
  assert.equal(oferecuHorario('Consigo quinta 29/10 às 14h, pode ser?'), true);
  assert.equal(oferecuHorario('Tenho amanhã às 9h ou às 14h30. Qual prefere?'), true);
  assert.equal(oferecuHorario('Atendemos de segunda a sexta das 8h às 18h'), false);
  assert.equal(oferecuHorario('Sua consulta é amanhã às 14h, confirma?'), false);
  assert.equal(oferecuHorario('Pronto! Remarquei para sexta, 30/10 às 14h.'), false);
  assert.equal(hesitou('acho que não vou conseguir'), true);
});

test('oferta de um horário só: a recusa seguinte é lida como resposta à oferta', () => {
  const falas = [p('Cancelei.'), ia('Que tal quinta às 14h?'), p('não quero remarcar')];
  assert.equal(acaoDaDesistencia(pacienteDesistiu(falas)), 'recusou');
});
