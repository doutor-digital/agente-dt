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
