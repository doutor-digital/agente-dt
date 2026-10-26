/**
 * Item 6 da Suzanne (25/10/2026), decisão do João em 26/10: quando o paciente escreve "cancelei"/"desmarquei"/"não vou",
 * a Sofia TENTA REMARCAR — acolhe em uma frase e oferece novo horário, em vez de perguntar "tem certeza?".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';
import type { Fala } from './repeticao.js';
import { pacienteDesistiu, renderPacienteDesistiu } from './paciente-desistiu.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

// Araguaína #28861610 (22/10): respondeu ao lembrete de 24 h.
const LILIANE = [ia('Olá! Sua consulta é amanhã, 23/10, às 14:00. Posso confirmar?'), p('Cancelei.')];

test('"Cancelei." depois do lembrete → o bloco manda REMARCAR, não perguntar "tem certeza?"', () => {
  assert.equal(pacienteDesistiu(LILIANE)?.trecho, 'Cancelei.');
  const bloco = renderPacienteDesistiu(LILIANE);
  assert.match(bloco, /<paciente_desistiu>/);
  assert.match(bloco, /TENTA REMARCAR/);
  assert.match(bloco, /consultar_horarios/);
  assert.match(bloco, /DOIS horários reais/);
  assert.match(bloco, /remarcar_consulta/);
  assert.match(bloco, /NÃO pergunte "tem certeza\?"/);
  assert.match(bloco, /NÃO chame cancelar_consulta agora/);
  assert.match(bloco, /criar_tarefa/);
  assert.match(bloco, /NO_FOLLOW_UP/);
  assert.match(bloco, /Se não tem/, 'sem consulta marcada o bloco manda ignorar');
});

test('as mensagens seguidas do turno contam; a de antes da última fala da Sofia não', () => {
  assert.equal(pacienteDesistiu([ia('Quer horário?'), p('oi'), p('tive um imprevisto, não vou poder ir')])?.trecho, 'tive um imprevisto, não vou poder ir');
  assert.equal(pacienteDesistiu([p('Cancelei.'), ia('Sem problema! Posso te oferecer sexta às 14h ou segunda às 9h?'), p('segunda às 9h')]), null);
});

test('conversa normal não ganha o bloco', () => {
  assert.equal(renderPacienteDesistiu([ia('Quer que eu veja um horário?'), p('Sim')]), '');
  assert.equal(renderPacienteDesistiu([ia('Segue o contrato'), p('Segue o print do cancelamento de contrato')]), '');
  assert.equal(renderPacienteDesistiu(undefined), '');
  assert.equal(renderPacienteDesistiu([]), '');
});

test('o prompt do turno ganha o bloco só quando ele desistiu, e o texto de "pedido de CANCELAR" aponta para ele', () => {
  const unidade = { id: 'u1', slug: 'teste', name: 'Clínica Teste', personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
  const com = composeSystemPrompt({ unit: unidade, historico: LILIANE });
  assert.match(com, /<paciente_desistiu>/);
  assert.match(com, /Cancelei\./);
  const sem = composeSystemPrompt({ unit: unidade, historico: [ia('Quer que eu veja um horário pra você?'), p('Sim')] });
  assert.doesNotMatch(sem, /<paciente_desistiu>/);
});

test('depois da oferta de horário, "pode cancelar mesmo" é a recusa: o bloco NÃO manda oferecer de novo', () => {
  const falas = [
    ia('Olá! Sua consulta é amanhã, 23/10, às 14:00. Posso confirmar?'),
    p('Cancelei.'),
    ia('Tudo bem! Se quiser, tenho sexta às 10h ou segunda às 14h. Qual fica melhor?'),
    p('não, pode cancelar mesmo'),
  ];
  const d = pacienteDesistiu(falas);
  assert.equal(d?.insistiu, true);
  const bloco = renderPacienteDesistiu(falas);
  assert.match(bloco, /JÁ tinha avisado/);
  assert.match(bloco, /NÃO ofereça horário de novo/);
  assert.match(bloco, /criar_tarefa/);
  assert.doesNotMatch(bloco, /DOIS horários reais/);
  // a primeira vez continua mandando remarcar
  assert.equal(pacienteDesistiu(LILIANE)?.insistiu, false);
  // uma desistência antiga, com outra conversa no meio, não conta como insistência
  const antiga = [p('Cancelei.'), ia('Tenho sexta às 10h'), p('sexta 10h'), ia('Remarcado!'), p('tive um imprevisto, não vou poder ir')];
  assert.equal(pacienteDesistiu(antiga)?.insistiu, false);
});
