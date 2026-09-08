import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkBusinessHours, fusoSeguro } from './prompt-composer.js';
import type { Unit } from '@prisma/client';

/**
 * A trava de horário decide se a IA responde. Ligada errado, o paciente que
 * escreve à noite ou no fim de semana não recebe nada — e é justamente quando
 * não há ninguém na clínica para atender no lugar dela.
 */
function unidade(over: Partial<Unit>): Unit {
  return {
    businessHoursEnabled: true,
    businessHoursTimezone: 'America/Sao_Paulo',
    businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    businessHoursStart: 9,
    businessHoursEnd: 18,
    outOfHoursMessage: 'Estamos fechados.',
    ...over,
  } as Unit;
}

// 31/08/2026 é segunda-feira; 29/08 é sábado.
const seg = (h: number) => new Date(`2026-08-31T${String(h).padStart(2, '0')}:00:00-03:00`);
const sab = (h: number) => new Date(`2026-08-29T${String(h).padStart(2, '0')}:00:00-03:00`);

test('desligada, atende sempre — inclusive de madrugada', () => {
  const r = checkBusinessHours(unidade({ businessHoursEnabled: false }), seg(3));
  assert.equal(r.enabled, false);
  assert.equal(r.isOpen, true);
});

test('segunda às 10h, dentro da janela: aberto', () => {
  assert.equal(checkBusinessHours(unidade({}), seg(10)).isOpen, true);
});

test('segunda às 8h, antes de abrir: fechado', () => {
  assert.equal(checkBusinessHours(unidade({}), seg(8)).isOpen, false);
});

test('o fim da janela é exclusivo: às 18h já fechou', () => {
  assert.equal(checkBusinessHours(unidade({}), seg(18)).isOpen, false);
  assert.equal(checkBusinessHours(unidade({}), seg(17)).isOpen, true);
});

test('o início é inclusivo: às 9h já abriu', () => {
  assert.equal(checkBusinessHours(unidade({}), seg(9)).isOpen, true);
});

test('sábado fora da lista de dias: fechado mesmo em horário comercial', () => {
  assert.equal(checkBusinessHours(unidade({}), sab(10)).isOpen, false);
});

test('sábado incluído na lista: abre', () => {
  const u = unidade({ businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] });
  assert.equal(checkBusinessHours(u, sab(10)).isOpen, true);
});

test('o fuso é o da unidade, não o do servidor', () => {
  // 08:00 em Boa Vista (UTC-4) são 09:00 em Brasília: só a de Brasília abriu.
  const instante = new Date('2026-08-31T12:00:00Z');
  const rr = checkBusinessHours(unidade({ businessHoursTimezone: 'America/Boa_Vista' }), instante);
  const sp = checkBusinessHours(unidade({ businessHoursTimezone: 'America/Sao_Paulo' }), instante);
  assert.equal(rr.isOpen, false, 'em Boa Vista ainda são 08:00');
  assert.equal(sp.isOpen, true, 'em Brasília já são 09:00');
});

test('a mensagem de fora do horário é devolvida pra quem chamar', () => {
  const r = checkBusinessHours(unidade({ outOfHoursMessage: 'Voltamos amanhã.' }), seg(22));
  assert.equal(r.isOpen, false);
  assert.equal(r.outOfHoursMessage, 'Voltamos amanhã.');
});

test('fuso vazio cai no padrão', () => {
  assert.equal(checkBusinessHours(unidade({ businessHoursTimezone: '' }), seg(10)).isOpen, true);
});

test('fuso INVÁLIDO não derruba o atendimento', () => {
  // Antes o Intl lançava RangeError aqui e a IA morria para a unidade inteira.
  // "America/Sao Paulo", com espaço no lugar do underscore, é o erro de
  // digitação mais provável de quem edita a unidade no console.
  for (const ruim of ['Marte/Olimpo', 'xxx', 'America/Sao Paulo']) {
    assert.doesNotThrow(
      () => checkBusinessHours(unidade({ businessHoursTimezone: ruim }), seg(10)),
      `fuso "${ruim}" derrubou o atendimento`,
    );
  }
});

test('com fuso inválido, responde como se fosse o padrão', () => {
  const bom = checkBusinessHours(unidade({}), seg(10));
  const ruim = checkBusinessHours(unidade({ businessHoursTimezone: 'xxx' }), seg(10));
  assert.equal(ruim.isOpen, bom.isOpen);
});

test('fusoSeguro devolve o fuso quando ele é válido', () => {
  assert.equal(fusoSeguro('America/Boa_Vista'), 'America/Boa_Vista');
  assert.equal(fusoSeguro('xxx'), 'America/Sao_Paulo');
  assert.equal(fusoSeguro(null), 'America/Sao_Paulo');
  assert.equal(fusoSeguro('  '), 'America/Sao_Paulo');
});


// 07/09/2026 é segunda-feira e feriado nacional (Independência); 08/09 é terça, dia normal.
test('feriado nacional fecha mesmo em dia e hora de atendimento (Porto Nacional disse "teremos atendimento" em 07/09)', () => {
  const feriado10h = new Date('2026-09-07T10:00:00-03:00');
  const r = checkBusinessHours(unidade({}), feriado10h);
  assert.equal(r.enabled, true);
  assert.equal(r.isOpen, false);
  assert.equal(r.outOfHoursMessage, 'Estamos fechados.');
  assert.equal(checkBusinessHours(unidade({}), new Date('2026-09-08T10:00:00-03:00')).isOpen, true);
});

// ── Janela por dia da semana ────────────────────────────────────────────────
// Taubaté (08/09/2026): a equipe humana atende o comercial e a IA cobre o resto
// — 20h às 08h de segunda a sexta (a janela ATRAVESSA a meia-noite) e 8h às 20h
// no sábado e no domingo. Nenhuma outra unidade usa isto.
const TAUBATE: Partial<Unit> = {
  businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  businessHoursStart: 20,
  businessHoursEnd: 8, // fim menor que início = vira a noite
  businessHoursByDay: { sat: { start: 8, end: 20 }, sun: { start: 8, end: 20 } } as never,
};
const dom = (h: number) => new Date(`2026-08-30T${String(h).padStart(2, '0')}:00:00-03:00`);
const ter = (h: number) => new Date(`2026-09-01T${String(h).padStart(2, '0')}:00:00-03:00`);

test('Taubaté: terça às 10h é hora da equipe — a IA fica calada', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), ter(10)).isOpen, false);
});

test('Taubaté: segunda às 20h a IA assume', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), seg(20)).isOpen, true);
});

test('Taubaté: segunda às 23h continua com a IA', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), seg(23)).isOpen, true);
});

test('Taubaté: 3h da manhã de terça ainda é a noite de segunda — responde', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), ter(3)).isOpen, true);
});

test('Taubaté: terça às 7h ainda responde; às 8h a equipe assume', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), ter(7)).isOpen, true);
  assert.equal(checkBusinessHours(unidade(TAUBATE), ter(8)).isOpen, false);
});

test('Taubaté: sábado às 9h responde, mesmo com a janela geral começando 20h', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), sab(9)).isOpen, true);
});

test('Taubaté: sábado às 3h é a noite de sexta — responde', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), sab(3)).isOpen, true);
});

test('Taubaté: sábado às 21h já fechou — o dia dele acaba às 20h', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), sab(21)).isOpen, false);
});

test('Taubaté: domingo às 10h responde', () => {
  assert.equal(checkBusinessHours(unidade(TAUBATE), dom(10)).isOpen, true);
});

test('dia fora de businessHoursDays continua fechado, mesmo com janela própria', () => {
  const u = unidade({
    businessHoursDays: ['mon'],
    businessHoursByDay: { sat: { start: 8, end: 20 } } as never,
  });
  assert.equal(checkBusinessHours(u, sab(10)).isOpen, false);
});

test('hora inválida no mapa é ignorada e vale a janela geral', () => {
  const u = unidade({ businessHoursByDay: { mon: { start: 99, end: 'x' } } as never });
  assert.equal(checkBusinessHours(u, seg(10)).isOpen, true);
});

test('início igual ao fim cai na janela geral em vez de calar a IA', () => {
  const u = unidade({ businessHoursByDay: { mon: { start: 9, end: 9 } } as never });
  assert.equal(checkBusinessHours(u, seg(10)).isOpen, true);
});

test('sem mapa por dia, nada muda para as outras unidades', () => {
  const u = unidade({ businessHoursByDay: null as never });
  assert.equal(checkBusinessHours(u, seg(10)).isOpen, true);
  assert.equal(checkBusinessHours(u, seg(20)).isOpen, false);
  assert.equal(checkBusinessHours(u, sab(10)).isOpen, false);
});
