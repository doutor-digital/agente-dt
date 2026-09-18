import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agendamentoDeuCerto,
  desfechoDaRemarcacao,
  escolherAlvo,
  recadoDaRemarcacao,
  recadoSemAlvo,
  tarefaDaVagaPresa,
} from './remarcacao.js';

const AGORA = '2026-09-18T10:00:00';

// As frases são as de agendar_consulta, copiadas literalmente. Se alguém mudar o
// texto de lá, é aqui que quebra — e é melhor quebrar no teste do que em produção
// cancelando a consulta de um paciente.
test('"NÃO foi marcada" nunca conta como sucesso', () => {
  for (const recusa of [
    'AGENDAMENTO PAUSADO pela recepção. A consulta NÃO foi marcada. Explique que a equipe retorna.',
    '14:00 não está mais disponível (ocupado). A consulta NÃO foi marcada. Peça desculpas.',
    'O paciente escolheu Pix antecipado, e ainda não há prova dele. A consulta NÃO foi marcada.',
  ]) {
    assert.equal(agendamentoDeuCerto(recusa), false, recusa.slice(0, 40));
  }
});

test('só a frase de sucesso conta como sucesso', () => {
  assert.equal(
    agendamentoDeuCerto('Consulta marcada para quinta-feira, 25 de setembro às 14:30. Confirme ao paciente.'),
    true,
  );
  // recusas que nem citam "marcada"
  assert.equal(agendamentoDeuCerto('Agenda não conectada. NÃO confirme nada.'), false);
  assert.equal(agendamentoDeuCerto('Não consegui confirmar a agenda (500). NÃO diga que está marcado.'), false);
});

test('cancelou a antiga: remarcação limpa', () => {
  const d = desfechoDaRemarcacao({
    cancelou: true,
    idScheduleAntiga: 111,
    quandoAntiga: '2026-09-20T14:30',
    agoraNaClinica: AGORA,
  });
  assert.equal(d.tipo, 'trocada');
});

test('não cancelou e a antiga já passou: não prende vaga', () => {
  // Os dois casos reais de produção. A franquia recusa cancelar horário no
  // passado (400: Agendamento não pode ser cancelado) e isso é inofensivo.
  const d = desfechoDaRemarcacao({
    cancelou: false,
    idScheduleAntiga: 3619159,
    quandoAntiga: '2026-09-02T09:00',
    agoraNaClinica: AGORA,
  });
  assert.equal(d.tipo, 'sobra_no_passado');
});

test('não cancelou e a antiga é futura: vaga presa de verdade', () => {
  const d = desfechoDaRemarcacao({
    cancelou: false,
    idScheduleAntiga: 222,
    quandoAntiga: '2026-09-25T08:00',
    agoraNaClinica: AGORA,
  });
  assert.equal(d.tipo, 'vaga_presa');
  assert.equal(d.tipo === 'vaga_presa' && d.idSchedule, 222);
});

test('sem saber quando era a antiga, trata como futura — o lado seguro', () => {
  const d = desfechoDaRemarcacao({
    cancelou: false,
    idScheduleAntiga: 333,
    quandoAntiga: null,
    agoraNaClinica: AGORA,
  });
  assert.equal(d.tipo, 'vaga_presa');
});

test('mesmo dia, hora anterior, conta como passado', () => {
  const d = desfechoDaRemarcacao({
    cancelou: false,
    idScheduleAntiga: 444,
    quandoAntiga: '2026-09-18T08:30',
    agoraNaClinica: AGORA,
  });
  assert.equal(d.tipo, 'sobra_no_passado');
});

test('vaga presa: a IA é proibida de dizer que cancelou', () => {
  const txt = recadoDaRemarcacao({
    desfecho: { tipo: 'vaga_presa', idSchedule: 222, quando: '2026-09-25T08:00' },
    antigaPorExtenso: 'sexta-feira, 25 de setembro, às 08:00',
    novaPorExtenso: 'segunda-feira, 28 de setembro, às 14:30',
    daNova: 'Confirme ao paciente.',
  });
  assert.match(txt, /NÃO consegui cancelar a anterior/);
  assert.match(txt, /NÃO diga que a anterior foi cancelada/);
  // mas a consulta nova existe e ele precisa saber
  assert.match(txt, /CONSULTA NOVA ESTÁ MARCADA/);
});

test('sobra no passado: fala normal, sem assustar ninguém à toa', () => {
  const txt = recadoDaRemarcacao({
    desfecho: { tipo: 'sobra_no_passado', idSchedule: 1 },
    antigaPorExtenso: 'quarta-feira, 2 de setembro, às 09:00',
    novaPorExtenso: 'segunda-feira, 28 de setembro, às 14:30',
    daNova: 'Confirme ao paciente.',
  });
  assert.match(txt, /Remarcada para segunda-feira/);
  assert.doesNotMatch(txt, /NÃO consegui/);
});

test('a tarefa da recepção diz o idSchedule e por que importa', () => {
  const t = tarefaDaVagaPresa({
    slug: 'doutor-hernia-rioverde',
    antigaPorExtenso: 'sexta, 25/09 às 08:00',
    novaPorExtenso: 'segunda, 28/09 às 14:30',
    idSchedule: 3662621,
    erro: '400: Agendamento não pode ser cancelado',
  });
  assert.match(t, /3662621/);
  assert.match(t, /400: Agendamento não pode ser cancelado/);
  assert.match(t, /ninguém consegue marcar nela/);
});

test('uma consulta futura: é essa', () => {
  const e = escolherAlvo([{ idSchedule: 900 }]);
  assert.equal(e.tipo, 'achei');
  assert.equal(e.tipo === 'achei' && e.consulta.idSchedule, 900);
});

test('nenhuma consulta: não é remarcação, é agendamento novo', () => {
  const e = escolherAlvo([]);
  assert.equal(e.tipo, 'nenhuma');
  assert.match(recadoSemAlvo(e), /agendar_consulta/);
  assert.match(recadoSemAlvo(e), /Não invente/);
});

test('duas consultas: recusa em vez de chutar', () => {
  // chutar aqui significa cancelar a consulta errada de alguém
  const e = escolherAlvo([{ idSchedule: 900 }, { idSchedule: 901 }]);
  assert.equal(e.tipo, 'varias');
  const txt = recadoSemAlvo(e);
  assert.match(txt, /NÃO REMARQUEI/);
  assert.match(txt, /NÃO cite dia nem hora/);
});

test('franquia fora do ar não vira "não tem consulta"', () => {
  // colapsar as duas fazia a IA marcar uma SEGUNDA consulta para quem já tinha uma
  const txt = recadoSemAlvo({ tipo: 'nao_sei' });
  assert.match(txt, /NÃO REMARQUEI/);
  assert.match(txt, /NÃO cite dia nem hora/);
  assert.doesNotMatch(txt, /agendar_consulta/);
});

test('a tarefa da vaga presa leva o prefixo que o roteador de alertas procura', () => {
  const t = tarefaDaVagaPresa({
    slug: 'doutor-hernia-mossoro',
    antigaPorExtenso: 'sexta, 25/09 às 08:00',
    novaPorExtenso: 'segunda, 28/09 às 14:30',
    idSchedule: 1,
    erro: null,
  });
  assert.match(t, /^ALERTA · doutor-hernia-mossoro · /);
});

test('vaga presa não engole a régua de pagamento da consulta nova', () => {
  const txt = recadoDaRemarcacao({
    desfecho: { tipo: 'vaga_presa', idSchedule: 1, quando: '2026-09-25T08:00' },
    antigaPorExtenso: 'sexta, 25/09 às 08:00',
    novaPorExtenso: 'segunda, 28/09 às 14:30',
    daNova: 'Chave Pix: 56.267.421/0001-38. Valor R$ 220.',
  });
  assert.match(txt, /Chave Pix/);
});

test('agendamento sem idSchedule não conta como alvo', () => {
  const e = escolherAlvo([{ idSchedule: null }, { idSchedule: 777 }]);
  assert.equal(e.tipo, 'achei');
  assert.equal(e.tipo === 'achei' && e.consulta.idSchedule, 777);
});
