import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Unit } from '@prisma/client';
import { checkBusinessHours } from './prompt-composer.js';
import { descreverExpediente, interpretarExpediente, lerExpediente } from '../lib/expediente.js';

/**
 * Caxias e Petrópolis (promessa de 29/10): a Sofia atende «das 18h às 6h30 nos dias úteis e 24h
 * nos fins de semana e feriados». O expediente da clínica é seg–sex 06:30–18:00; a IA atende o
 * complemento. Este é EXATAMENTE o valor que vai para a coluna `business_hours_expediente`.
 */
const EXPEDIENTE_CAXIAS_PETROPOLIS = {
  mon: { start: '06:30', end: '18:00' },
  tue: { start: '06:30', end: '18:00' },
  wed: { start: '06:30', end: '18:00' },
  thu: { start: '06:30', end: '18:00' },
  fri: { start: '06:30', end: '18:00' },
};

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    slug: 'doutor-hernia-caxias',
    businessHoursEnabled: true,
    businessHoursTimezone: 'America/Sao_Paulo',
    // o estado de produção medido em 23/11: 18→6, todos os dias, sem mapa por dia
    businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    businessHoursStart: 18,
    businessHoursEnd: 6,
    businessHoursByDay: {},
    businessHoursExpediente: EXPEDIENTE_CAXIAS_PETROPOLIS,
    outOfHoursMessage: null,
    ...over,
  } as unknown as Unit;
}

/** Instante local (São Paulo, sem horário de verão desde 2019): '2026-11-23', '06:30'. */
const em = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00-03:00`);
const iaAtende = (u: Unit, dia: string, hhmm: string) => checkBusinessHours(u, em(dia, hhmm)).isOpen;

// 2026-11-23 segunda · 24 terça · 25 quarta · 26 quinta · 27 sexta · 28 sábado · 29 domingo · 30 segunda
test('segunda: 06:29 a IA atende (a equipe ainda não abriu), 06:30 a equipe abre e a IA cala', () => {
  const u = unidade();
  assert.equal(iaAtende(u, '2026-11-23', '06:29'), true);
  assert.equal(iaAtende(u, '2026-11-23', '06:30'), false);
});

test('segunda: 17:59 a IA cala, 18:00 a IA assume', () => {
  const u = unidade();
  assert.equal(iaAtende(u, '2026-11-23', '17:59'), false);
  assert.equal(iaAtende(u, '2026-11-23', '18:00'), true);
});

test('dia útil: meio do expediente calada, noite e madrugada atendendo', () => {
  const u = unidade();
  for (const dia of ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']) {
    assert.equal(iaAtende(u, dia, '10:00'), false, `${dia} 10:00`);
    assert.equal(iaAtende(u, dia, '12:00'), false, `${dia} 12:00`);
    assert.equal(iaAtende(u, dia, '19:00'), true, `${dia} 19:00`);
    assert.equal(iaAtende(u, dia, '00:00'), true, `${dia} 00:00`);
    assert.equal(iaAtende(u, dia, '03:00'), true, `${dia} 03:00`);
  }
});

test('os dois casos que caíram em __out_of_hours__: sábado 15:39 e domingo 07:34 — a IA atende', () => {
  const u = unidade();
  assert.equal(iaAtende(u, '2026-11-28', '15:39'), true);
  assert.equal(iaAtende(u, '2026-11-29', '07:34'), true);
});

test('sexta 18:00 até segunda 06:30 é contínuo: sexta 23:00, sábado e domingo inteiros, segunda 03:00', () => {
  const u = unidade();
  assert.equal(iaAtende(u, '2026-11-27', '23:00'), true);
  assert.equal(iaAtende(u, '2026-11-27', '23:59'), true);
  for (const dia of ['2026-11-28', '2026-11-29']) {
    for (const h of ['00:00', '00:01', '06:29', '06:30', '09:00', '12:00', '17:59', '18:00', '23:59']) {
      assert.equal(iaAtende(u, dia, h), true, `${dia} ${h}`);
    }
  }
  assert.equal(iaAtende(u, '2026-11-30', '00:00'), true);
  assert.equal(iaAtende(u, '2026-11-30', '03:00'), true);
  assert.equal(iaAtende(u, '2026-11-30', '06:29'), true);
  assert.equal(iaAtende(u, '2026-11-30', '06:30'), false);
});

test('feriado numa quarta (21/04/2027, Tiradentes): terça 18:00 até quinta 06:30, sem buraco', () => {
  const u = unidade();
  assert.equal(iaAtende(u, '2027-04-20', '17:59'), false, 'terça, ainda expediente');
  assert.equal(iaAtende(u, '2027-04-20', '18:00'), true);
  assert.equal(iaAtende(u, '2027-04-21', '00:00'), true);
  assert.equal(iaAtende(u, '2027-04-21', '06:30'), true, 'o feriado não tem expediente');
  assert.equal(iaAtende(u, '2027-04-21', '12:00'), true);
  assert.equal(iaAtende(u, '2027-04-21', '17:59'), true);
  assert.equal(iaAtende(u, '2027-04-21', '23:59'), true);
  assert.equal(iaAtende(u, '2027-04-22', '00:00'), true);
  assert.equal(iaAtende(u, '2027-04-22', '06:29'), true);
  assert.equal(iaAtende(u, '2027-04-22', '06:30'), false, 'quinta volta o expediente');
});

test('feriado numa sexta (20/11/2026, Consciência Negra): véspera, o dia e o fim de semana viram um bloco só', () => {
  const u = unidade();
  // quinta 19/11: expediente normal até 18:00
  assert.equal(iaAtende(u, '2026-11-19', '10:00'), false);
  assert.equal(iaAtende(u, '2026-11-19', '17:59'), false);
  assert.equal(iaAtende(u, '2026-11-19', '18:00'), true);
  // sexta 20/11, feriado: o dia inteiro
  for (const h of ['00:00', '06:29', '06:30', '10:00', '17:59', '18:00', '23:59']) {
    assert.equal(iaAtende(u, '2026-11-20', h), true, `20/11 ${h}`);
  }
  // sábado, domingo e segunda até 06:30
  assert.equal(iaAtende(u, '2026-11-21', '15:39'), true);
  assert.equal(iaAtende(u, '2026-11-22', '07:34'), true);
  assert.equal(iaAtende(u, '2026-11-23', '06:29'), true);
  assert.equal(iaAtende(u, '2026-11-23', '06:30'), false);
});

test('feriado numa segunda (07/09/2026): domingo à noite emenda com o dia inteiro; terça 06:30 a equipe volta', () => {
  const u = unidade();
  assert.equal(iaAtende(u, '2026-09-06', '23:00'), true);
  assert.equal(iaAtende(u, '2026-09-07', '09:00'), true);
  assert.equal(iaAtende(u, '2026-09-07', '17:59'), true);
  assert.equal(iaAtende(u, '2026-09-08', '06:29'), true);
  assert.equal(iaAtende(u, '2026-09-08', '06:30'), false);
});

test('o fuso é o da unidade: 06:30 em Brasília são 05:30 em Manaus (IA ainda atende lá)', () => {
  const instante = new Date('2026-11-23T09:30:00Z'); // 06:30 em Brasília, 05:30 em Manaus
  const sp = checkBusinessHours(unidade({ businessHoursTimezone: 'America/Sao_Paulo' }), instante);
  const mao = checkBusinessHours(unidade({ businessHoursTimezone: 'America/Manaus' }), instante);
  assert.equal(sp.isOpen, false);
  assert.equal(mao.isOpen, true);
});

test('com expediente, a janela antiga (18→6, dias, mapa por dia) não é lida: a mesma resposta com qualquer valor nela', () => {
  const a = unidade();
  const b = unidade({ businessHoursStart: 9, businessHoursEnd: 12, businessHoursDays: ['mon'], businessHoursByDay: { tue: { start: 1, end: 2 } } as never });
  for (const [dia, h] of [['2026-11-23', '10:00'], ['2026-11-24', '03:00'], ['2026-11-28', '15:39'], ['2026-11-29', '07:34'], ['2026-11-27', '23:00']] as const) {
    assert.equal(iaAtende(a, dia, h), iaAtende(b, dia, h), `${dia} ${h}`);
  }
});

test('trava desligada continua atendendo sempre, expediente ou não', () => {
  const u = unidade({ businessHoursEnabled: false });
  const r = checkBusinessHours(u, em('2026-11-23', '10:00'));
  assert.equal(r.enabled, false);
  assert.equal(r.isOpen, true);
});

test('a mensagem de fora do horário continua sendo devolvida', () => {
  const r = checkBusinessHours(unidade({ outOfHoursMessage: 'Voltamos já.' }), em('2026-11-23', '10:00'));
  assert.equal(r.isOpen, false);
  assert.equal(r.outOfHoursMessage, 'Voltamos já.');
});

// ── Regressão: quem não tem expediente fica IDÊNTICO ───────────────────────

test('sem expediente (null, ausente ou JSON null) a unidade segue a janela antiga: 18→6, como em produção', () => {
  for (const valor of [null, undefined]) {
    const u = unidade({ businessHoursExpediente: valor as never });
    assert.equal(iaAtende(u, '2026-11-24', '10:00'), false);
    assert.equal(iaAtende(u, '2026-11-24', '19:00'), true);
    assert.equal(iaAtende(u, '2026-11-24', '03:00'), true);
    // a janela antiga só tem hora cheia: 06:00 já fecha (o defeito que o expediente resolve)
    assert.equal(iaAtende(u, '2026-11-24', '06:00'), false);
    assert.equal(iaAtende(u, '2026-11-24', '06:29'), false);
  }
});

test('sem expediente, janela normal 9→18 de segunda a sexta é a mesma de sempre', () => {
  const u = unidade({
    businessHoursStart: 9,
    businessHoursEnd: 18,
    businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    businessHoursExpediente: null as never,
  });
  assert.equal(iaAtende(u, '2026-11-23', '10:00'), true);
  assert.equal(iaAtende(u, '2026-11-23', '08:59'), false);
  assert.equal(iaAtende(u, '2026-11-23', '18:00'), false);
  assert.equal(iaAtende(u, '2026-11-28', '10:00'), false);
  assert.equal(iaAtende(u, '2026-11-20', '10:00'), false, 'feriado fecha a janela normal');
});

test('sem expediente, Taubaté (20→8 + sáb/dom 8→20) continua igual', () => {
  const u = unidade({
    slug: 'doutor-hernia-taubate',
    businessHoursStart: 20,
    businessHoursEnd: 8,
    businessHoursByDay: { sat: { start: 8, end: 20 }, sun: { start: 8, end: 20 } } as never,
    businessHoursExpediente: null as never,
  });
  assert.equal(iaAtende(u, '2026-11-24', '10:00'), false);
  assert.equal(iaAtende(u, '2026-11-24', '21:00'), true);
  assert.equal(iaAtende(u, '2026-11-25', '03:00'), true);
  assert.equal(iaAtende(u, '2026-11-28', '09:00'), true);
  assert.equal(iaAtende(u, '2026-11-28', '21:00'), false);
});

test('expediente torto cai na janela antiga (que já funciona) em vez de calar ou liberar a IA', () => {
  const tortos: unknown[] = [
    'texto',
    [],
    {},
    { mon: { start: '6:30', end: '18:00' } }, // sem zero à esquerda
    { mon: { start: '06:30', end: '06:30' } }, // fim = início
    { mon: { start: '18:00', end: '06:30' } }, // atravessa a meia-noite: não é expediente
    { mon: { start: '06:60', end: '18:00' } },
    { mon: { start: 6.5, end: 18 } },
    { monday: { start: '06:30', end: '18:00' } }, // dia que não existe
    { mon: { start: '06:30', end: '18:00' }, fri: { start: 'x', end: '18:00' } }, // um dia torto invalida tudo
  ];
  for (const t of tortos) {
    const u = unidade({ businessHoursExpediente: t as never });
    assert.doesNotThrow(() => checkBusinessHours(u, em('2026-11-24', '10:00')));
    // 18→6 antigo: terça 10:00 fecha, 19:00 abre
    assert.equal(iaAtende(u, '2026-11-24', '10:00'), false, JSON.stringify(t));
    assert.equal(iaAtende(u, '2026-11-24', '19:00'), true, JSON.stringify(t));
  }
});

test('lerExpediente: dia null = sem expediente naquele dia; o resto vira minutos', () => {
  const e = lerExpediente({ mon: { start: '06:30', end: '18:00' }, tue: null });
  assert.deepEqual(e, { mon: { inicio: 390, fim: 1080 } });
  assert.equal(lerExpediente(null), null);
  assert.equal(lerExpediente(undefined), null);
});

test('descreverExpediente agrupa os dias seguidos: «seg–sex, das 6h30 às 18h»', () => {
  const e = lerExpediente(EXPEDIENTE_CAXIAS_PETROPOLIS);
  assert.ok(e);
  assert.equal(descreverExpediente(e), 'seg–sex, das 6h30 às 18h');
  const f = lerExpediente({ mon: { start: '08:00', end: '18:00' }, wed: { start: '08:00', end: '18:00' }, sat: { start: '08:00', end: '12:00' } });
  assert.ok(f);
  assert.equal(descreverExpediente(f), 'seg, das 8h às 18h; qua, das 8h às 18h; sáb, das 8h às 12h');
});

test('«24:00» vale como fim (clínica que fecha à meia-noite) e nunca como início', () => {
  const e = lerExpediente({ mon: { start: '06:30', end: '24:00' } });
  assert.deepEqual(e, { mon: { inicio: 390, fim: 1440 } });
  const u = unidade({ businessHoursExpediente: { mon: { start: '06:30', end: '24:00' } } as never });
  assert.equal(iaAtende(u, '2026-11-23', '23:59'), false);
  assert.equal(iaAtende(u, '2026-11-24', '00:00'), true);
  assert.equal(interpretarExpediente({ mon: { start: '24:00', end: '24:00' } }).ok, false);
});

test('interpretarExpediente: a mesma validação serve à gravação (ok/motivo) e o valor de produção é aceito', () => {
  const certo = interpretarExpediente(EXPEDIENTE_CAXIAS_PETROPOLIS);
  assert.equal(certo.ok, true);
  assert.equal(interpretarExpediente(null).ok, true);
  const torto = interpretarExpediente({ mon: { start: '6:30', end: '18:00' } });
  assert.equal(torto.ok, false);
  assert.match(torto.ok ? '' : torto.motivo, /horário inválido/);
});
