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
import { recusouRemarcarExplicitamente } from '../lib/desistencia-frases.js';

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
  assert.match(bloco, /NÃO chame cancelar_consulta agora/);
  assert.match(bloco, /Se não tem/, 'sem consulta marcada o bloco manda ignorar');
});

test('as mensagens seguidas do turno contam; a de antes da última fala da Sofia só como o par da oferta', () => {
  assert.equal(pacienteDesistiu([ia('Quer horário?'), p('oi'), p('tive um imprevisto, não vou poder ir')])?.trecho, 'tive um imprevisto, não vou poder ir');
  // ele escolheu um horário da oferta: ainda é o par "avisou → ofereceu → respondeu", e o bloco manda remarcar
  assert.equal(pacienteDesistiu([p('Cancelei.'), ia('Sem problema! Posso te oferecer sexta às 14h ou segunda às 9h?'), p('segunda às 9h')])?.momento, 'respondeu_a_oferta');
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

const OFERTA = 'Tudo bem! Se quiser, tenho sexta às 10h ou segunda às 14h. Qual fica melhor?';

test('depois da oferta, "pode cancelar mesmo" é a recusa: o bloco NÃO manda oferecer de novo', () => {
  const falas = [ia('Olá! Sua consulta é amanhã, 23/10, às 14:00. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p('não, pode cancelar mesmo')];
  assert.equal(pacienteDesistiu(falas)?.momento, 'insistiu');
  const bloco = renderPacienteDesistiu(falas, { slug: 'doutor-hernia-araguaina' });
  assert.match(bloco, /JÁ tinha avisado/);
  assert.match(bloco, /NÃO ofereça os mesmos horários/);
  assert.match(bloco, /cancelar_consulta com confirmado=true/);
  assert.match(bloco, /criar_tarefa/);
  assert.doesNotMatch(bloco, /DOIS horários reais/);
  // a primeira vez continua mandando remarcar
  assert.equal(pacienteDesistiu(LILIANE)?.momento, 'avisou');
});

test('a recusa que NÃO parece desistência ("não quero remarcar", "depois eu vejo") ainda recebe o bloco certo, explícita ou não', () => {
  for (const resposta of ['não quero remarcar', 'não, obrigado', 'depois eu vejo e te aviso', 'deixa pra lá']) {
    const falas = [ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p(resposta)];
    assert.equal(pacienteDesistiu(falas)?.momento, 'respondeu_a_oferta', resposta);
    const bloco = renderPacienteDesistiu(falas, { slug: 'doutor-hernia-araguaina' });
    assert.match(bloco, /RESPOSTA dele à oferta/);
    assert.match(bloco, /remarcar_consulta/, 'escolheu horário → remarca');
    assert.match(bloco, /OUTRA coisa/, 'pergunta de outro assunto não ganha o fecho');
  }
  assert.match(renderPacienteDesistiu([ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p('não quero remarcar')], { slug: 'doutor-hernia-araguaina' }), /ALERTA · doutor-hernia-araguaina/);
});

test('só vale se a Sofia de fato ofereceu horário e se a desistência foi o turno logo antes', () => {
  // a Sofia respondeu outra coisa (preço), não ofereceu horário → o "de novo" é um aviso novo, não recusa
  const semOferta = [p('Cancelei.'), ia('Entendi. O valor da consulta é R$ 250.'), p('não vou poder ir')];
  assert.equal(pacienteDesistiu(semOferta)?.momento, 'avisou');
  // desistência antiga, remarcada, e depois uma conversa qualquer: sem bloco
  const antiga = [p('Cancelei.'), ia(OFERTA), p('sexta 10h'), ia('Remarcado para sexta às 10h!'), p('obrigada')];
  assert.equal(pacienteDesistiu(antiga), null);
  assert.equal(renderPacienteDesistiu(antiga), '');
});

test('horário no formato "14h30" também é oferta; "nosso horário de atendimento" não é', () => {
  const oferta30 = [ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia('Tudo bem! Tenho sexta às 14h30 ou segunda às 10h30. Qual fica melhor?'), p('não quero remarcar')];
  assert.equal(pacienteDesistiu(oferta30)?.momento, 'respondeu_a_oferta');
  // depois do fecho, a despedida fala do "horário de atendimento" — o próximo "obrigada" não reabre o bloco
  const depoisDoFecho = [p('Cancelei.'), ia('Tenho sexta às 10h ou segunda às 14h'), p('pode cancelar mesmo'), ia('Tudo bem! Nosso horário de atendimento é das 8h às 18h; qualquer coisa é só chamar.'), p('obrigada')];
  assert.equal(pacienteDesistiu(depoisDoFecho), null);
});

// ── a decisão de 26/10: recusa EXPLÍCITA cancela na franquia; hesitação não; sem vínculo/erro → tarefa ───────────────

const COM_OFERTA = (resposta: string): Fala[] => [ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p(resposta)];

test('o classificador: recusa explícita × hesitação × negação', () => {
  for (const t of ['não quero remarcar', 'pode cancelar mesmo', 'cancela por favor', 'desisti', 'não quero mais', 'não vou remarcar']) {
    assert.equal(recusouRemarcarExplicitamente(t), true, t);
  }
  for (const t of ['acho que não vou conseguir', 'vou ver', 'depois eu aviso', 'talvez outro dia', 'não cancele', 'posso cancelar?', 'obrigada', 'sexta às 10h', '']) {
    assert.equal(recusouRemarcarExplicitamente(t), false, t);
  }
});

test('CAMINHO 1 — recusa explícita: manda cancelar_consulta com confirmado=true, sem perguntar de novo', () => {
  for (const r of ['não quero remarcar', 'pode cancelar mesmo']) {
    const bloco = renderPacienteDesistiu(COM_OFERTA(r), { slug: 'doutor-hernia-araguaina' });
    assert.match(bloco, /RECUSA EXPLÍCITA: chame cancelar_consulta com confirmado=true/, r);
    assert.match(bloco, /NÃO pergunte de novo/);
    assert.doesNotMatch(bloco, /NÃO cancele a consulta/);
  }
});

test('CAMINHO 2 — sem vínculo na franquia ou cancelamento que falhou: o mesmo bloco manda NÃO dizer que cancelou e abrir tarefa ALERTA', () => {
  const bloco = renderPacienteDesistiu(COM_OFERTA('pode cancelar mesmo'), { slug: 'doutor-hernia-araguaina' });
  assert.match(bloco, /não há consulta marcada por aqui, que não conseguiu confirmar na clínica ou devolver erro: NÃO diga que cancelou/);
  assert.match(bloco, /ALERTA · doutor-hernia-araguaina · \[Contato: primeiro nome\] Desistiu da consulta de DD\/MM: cancelar na franquia/);
  assert.match(bloco, /NO_FOLLOW_UP/);
  // e no caso de sucesso, a Sofia confirma o cancelamento em uma frase
  assert.match(bloco, /Se a ferramenta confirmar o cancelamento: diga em UMA frase/);
});

test('CAMINHO 3 — hesitação ("acho que não vou conseguir", "vou ver"): NÃO cancela, oferece remarcar', () => {
  for (const r of ['acho que não vou conseguir', 'vou ver', 'depois eu aviso']) {
    const bloco = renderPacienteDesistiu(COM_OFERTA(r), { slug: 'x' });
    assert.match(bloco, /NÃO cancele a consulta/, r);
    assert.doesNotMatch(bloco, /RECUSA EXPLÍCITA/, r);
    assert.doesNotMatch(bloco, /cancelar_consulta com confirmado=true/, r);
  }
});

test('no PRIMEIRO aviso ("Cancelei"/"pode cancelar") a Sofia nunca cancela: primeiro a oferta de horário', () => {
  for (const t of ['Cancelei.', 'pode cancelar']) {
    const bloco = renderPacienteDesistiu([ia('Posso confirmar?'), p(t)], { slug: 'x' });
    assert.match(bloco, /NÃO chame cancelar_consulta agora/, t);
    assert.doesNotMatch(bloco, /RECUSA EXPLÍCITA/, t);
  }
});
