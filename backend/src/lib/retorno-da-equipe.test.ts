/**
 * "A equipe vai te chamar em instantes" e ninguém chama (prioridades da IA, 21/10/2026, item 2).
 *
 * 89 conversas com a promessa; só 19% tiveram humano em 60 minutos. O que estes testes prendem:
 *  - o horário da equipe sai da agenda da unidade (dia a dia, sábado menor, feriado fechado, fuso da unidade);
 *  - sem agenda ligada não há horário confiável — e aí a IA não inventa um;
 *  - nenhum texto que a IA recebe para falar com o paciente promete prazo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { horaFalada, orientacaoAoTransferir, retornoDaEquipe, semEquipeAteOutroDia } from './retorno-da-equipe.js';
import { FALLBACK_TETO, textoDoTeto } from '../agent/llm-policy.js';

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    slug: 'doutor-hernia-teste',
    spineEnabled: true,
    spineAgendaDays: [1, 2, 3, 4, 5],
    spineAgendaStart: '08:00',
    spineAgendaEnd: '18:00',
    spineDayHours: null,
    spineTimezone: 'America/Sao_Paulo',
    businessHoursTimezone: 'America/Sao_Paulo',
    businessHoursEnabled: false,
    ...over,
  } as unknown as Unit;
}

/** Hora de Brasília (UTC−3) — 21/10/2026 é uma quarta-feira. */
const brt = (iso: string) => new Date(`${iso}-03:00`);

test('sem agenda ligada o horário não é confiável: não inventa', () => {
  assert.deepEqual(retornoDaEquipe(unidade({ spineEnabled: false }), brt('2026-10-21T22:00:00')), { tipo: 'desconhecido' });
  assert.deepEqual(retornoDaEquipe(unidade({ spineAgendaDays: [] }), brt('2026-10-21T22:00:00')), { tipo: 'desconhecido' });
});

test('dentro do horário da agenda: aberta', () => {
  assert.deepEqual(retornoDaEquipe(unidade(), brt('2026-10-21T10:00:00')), { tipo: 'aberta' });
  assert.deepEqual(retornoDaEquipe(unidade(), brt('2026-10-21T17:59:00')), { tipo: 'aberta' });
});

test('quarta à noite: volta amanhã (quinta) às 8h', () => {
  assert.deepEqual(retornoDaEquipe(unidade(), brt('2026-10-21T20:00:00')), {
    tipo: 'fechada',
    quando: 'amanhã (quinta-feira) às 8h',
    hoje: false,
    dias: 1,
  });
});

test('de madrugada, antes de abrir: volta hoje', () => {
  assert.deepEqual(retornoDaEquipe(unidade(), brt('2026-10-21T06:30:00')), { tipo: 'fechada', quando: 'hoje às 8h', hoje: true, dias: 0 });
});

test('sexta à noite: sábado com horário próprio, ou segunda quando não atende sábado', () => {
  const comSabado = unidade({ spineAgendaDays: [1, 2, 3, 4, 5, 6], spineDayHours: { 6: { start: '07:30', end: '12:00' } } as never });
  assert.deepEqual(retornoDaEquipe(comSabado, brt('2026-10-23T19:00:00')), {
    tipo: 'fechada',
    quando: 'amanhã (sábado) às 7h30',
    hoje: false,
    dias: 1,
  });
  // Sábado depois do meio-dia: o sábado já fechou, volta segunda.
  assert.deepEqual(retornoDaEquipe(comSabado, brt('2026-10-24T12:30:00')).tipo, 'fechada');
  assert.match(JSON.stringify(retornoDaEquipe(comSabado, brt('2026-10-24T12:30:00'))), /segunda-feira, 26\/10, às 8h/);

  assert.deepEqual(retornoDaEquipe(unidade(), brt('2026-10-23T19:00:00')), {
    tipo: 'fechada',
    quando: 'segunda-feira, 26/10, às 8h',
    hoje: false,
    dias: 3,
  });
});

test('feriado nacional é dia fechado (Finados, segunda 02/11/2026)', () => {
  assert.deepEqual(retornoDaEquipe(unidade(), brt('2026-10-30T19:00:00')), {
    tipo: 'fechada',
    quando: 'terça-feira, 03/11, às 8h',
    hoje: false,
    dias: 4, // sexta à noite → terça: o caso de Mossoró (30/10). A clínica só reabre 4 dias depois.
  });
  assert.equal(retornoDaEquipe(unidade(), brt('2026-11-02T10:00:00')).tipo, 'fechada');
  assert.equal(semEquipeAteOutroDia(retornoDaEquipe(unidade(), brt('2026-10-30T19:00:00'))), true);
  assert.equal(semEquipeAteOutroDia(retornoDaEquipe(unidade(), brt('2026-10-21T20:00:00'))), false, 'a noite comum não conta');
});

test('usa o fuso da unidade (Boa Vista, UTC−4)', () => {
  const bv = unidade({ spineTimezone: 'America/Boa_Vista', businessHoursTimezone: 'America/Boa_Vista' });
  // 18:30 em Brasília = 17:30 em Boa Vista: lá ainda está aberto.
  assert.deepEqual(retornoDaEquipe(bv, brt('2026-10-21T18:30:00')), { tipo: 'aberta' });
  assert.equal(retornoDaEquipe(unidade(), brt('2026-10-21T18:30:00')).tipo, 'fechada');
});

test('janela torta no cadastro não vira horário inventado', () => {
  const torta = unidade({ spineAgendaStart: '18:00', spineAgendaEnd: '08:00' });
  assert.deepEqual(retornoDaEquipe(torta, brt('2026-10-21T20:00:00')), { tipo: 'desconhecido' });
  // 24:30 não é hora: não pode deixar a clínica "aberta" até meia-noite e meia.
  const passou = unidade({ spineAgendaStart: '08:00', spineAgendaEnd: '24:30' });
  assert.deepEqual(retornoDaEquipe(passou, brt('2026-10-21T23:00:00')), { tipo: 'desconhecido' });
  // 24:00 é o fim do dia e vale.
  assert.deepEqual(retornoDaEquipe(unidade({ spineAgendaEnd: '24:00' }), brt('2026-10-21T23:00:00')), { tipo: 'aberta' });
});

test('hora como se fala', () => {
  assert.equal(horaFalada('08:00'), '8h');
  assert.equal(horaFalada('07:30'), '7h30');
  assert.equal(horaFalada('13:00'), '13h');
});

test('o que a IA recebe ao transferir nunca manda prometer prazo', () => {
  const casos = [
    orientacaoAoTransferir({ tipo: 'aberta' }),
    orientacaoAoTransferir({ tipo: 'aberta' }, true),
    orientacaoAoTransferir({ tipo: 'fechada', quando: 'amanhã (quinta-feira) às 8h', hoje: false }),
    orientacaoAoTransferir({ tipo: 'fechada', quando: 'hoje às 8h', hoje: true }, true),
    orientacaoAoTransferir({ tipo: 'desconhecido' }),
  ];
  for (const t of casos) {
    assert.match(t, /NÃO prometa prazo/);
    assert.match(t, /UMA frase/);
  }
  assert.match(casos[1], /com prioridade/);
  assert.match(casos[2], /volta amanhã \(quinta-feira\) às 8h/);
  assert.match(casos[4], /próximo horário de atendimento/);
  assert.match(casos[4], /não invente/);
});

test('sinal de alerta nunca manda ao pronto-socorro, nem fora do horário (decisão de 26/10)', () => {
  const amanha = orientacaoAoTransferir({ tipo: 'fechada', quando: 'amanhã (quinta-feira) às 8h', hoje: false }, true);
  assert.doesNotMatch(amanha, /insuportável/);
  assert.match(amanha, /NÃO sugira pronto-socorro/);
  assert.match(amanha, /PRÓPRIO paciente perguntou/);
  assert.match(amanha, /pode ir/);
  // Transferência comum nunca fala de pronto-socorro.
  assert.doesNotMatch(orientacaoAoTransferir({ tipo: 'fechada', quando: 'amanhã (quinta-feira) às 8h', hoje: false }), /pronto-socorro/);
});

test('mensagem do teto de gasto não promete "em instantes"', () => {
  assert.doesNotMatch(FALLBACK_TETO, /instante|já já/i);
  assert.match(FALLBACK_TETO, /próximo horário de atendimento/);
  assert.match(textoDoTeto({ tipo: 'fechada', quando: 'amanhã (quinta-feira) às 8h', hoje: false }), /amanhã \(quinta-feira\) às 8h/);
  for (const r of [{ tipo: 'aberta' } as const, { tipo: 'fechada', quando: 'hoje às 8h', hoje: true } as const]) {
    assert.doesNotMatch(textoDoTeto(r), /instante|já já/i);
  }
});

test('sinal de alerta com a clínica fechada até outro dia: a orientação NÃO manda prometer retorno da equipe', () => {
  const r = { tipo: 'fechada' as const, quando: 'terça-feira, 03/11, às 7h30', hoje: false, dias: 4 };
  const o = orientacaoAoTransferir(r, true, true);
  assert.match(o, /FECHADA e só reabre terça-feira, 03\/11, às 7h30/);
  assert.match(o, /NÃO diga que a equipe "retorna", "te responde", "te chama" nem "continua o atendimento por aqui"/);
  assert.match(o, /pode procurar atendimento antes/);
  assert.match(o, /NÃO prometa prazo/);
  assert.match(o, /NÃO sugira pronto-socorro/);
  // o que não é sinal de alerta, ou fecha só até daqui a pouco, segue como sempre
  assert.match(orientacaoAoTransferir(r, false, true), /a equipe continua o atendimento por aqui terça-feira/);
  assert.match(orientacaoAoTransferir({ tipo: 'fechada', quando: 'hoje às 14h', hoje: true, dias: 0 }, true, true), /a equipe continua o atendimento por aqui hoje às 14h/);
  // a noite comum: reabre amanhã, a promessa se cumpre
  assert.match(orientacaoAoTransferir({ tipo: 'fechada', quando: 'amanhã (quarta-feira) às 8h', hoje: false, dias: 1 }, true, true), /a equipe continua o atendimento por aqui amanhã/);
  assert.equal(semEquipeAteOutroDia({ tipo: 'fechada', quando: 'x', hoje: false, dias: 1 }), false);
  assert.equal(semEquipeAteOutroDia({ tipo: 'fechada', quando: 'x', hoje: false }), false);
  assert.equal(semEquipeAteOutroDia({ tipo: 'fechada', quando: 'x', hoje: false, dias: 2 }), true);
});

test('«pode procurar atendimento antes» sai quando a chave estiver desligada (decisão do João pendente), sem frase solta', async () => {
  const { fraseDoPasse } = await import('../agent/sinal-de-alerta.js');
  const r = { tipo: 'fechada' as const, quando: 'terça-feira, 03/11, às 7h30', hoje: false, dias: 4 };
  const sem = orientacaoAoTransferir(r, true, true, false);
  assert.doesNotMatch(sem, /procurar atendimento/);
  assert.match(sem, /a clínica reabre terça-feira, 03\/11, às 7h30\. NÃO prometa prazo/);
  const frase = fraseDoPasse(r, false, true, false);
  assert.doesNotMatch(frase, /procurar atendimento/);
  assert.match(frase, /a clínica reabre terça-feira, 03\/11, às 7h30\.$/);
  assert.match(orientacaoAoTransferir(r, true, true, true), /pode procurar atendimento antes/);
  assert.match(fraseDoPasse(r, false, true, true), /pode procurar atendimento antes/);
});
