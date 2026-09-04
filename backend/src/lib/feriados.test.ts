import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dataLocalISO,
  dataPorExtenso,
  diaDaSemana,
  ehFeriadoNacional,
  feriadoNacional,
  feriadosDoAno,
  feriadosNoIntervalo,
  pascoa,
  renderCalendario,
} from './feriados.js';

/**
 * 04/09/2026: a Sofia de Porto Nacional tinha dito "teremos atendimento" em 07/09
 * (Independência) e a da Serra escreveu "segunda-feira, 08/09" — 08/09/2026 é terça;
 * em 2025 era segunda. Estes testes travam as duas coisas: o calendário de feriados
 * e o nome do dia da semana calculado por código.
 */

test('07/09 é feriado nacional em qualquer ano', () => {
  assert.equal(feriadoNacional('2026-09-07'), 'Independência do Brasil');
  assert.equal(feriadoNacional('2027-09-07'), 'Independência do Brasil');
  assert.equal(ehFeriadoNacional('2026-09-08'), false);
});

test('Páscoa e os móveis de 2026 (Carnaval 16-17/02, Sexta Santa 03/04, Corpus Christi 04/06)', () => {
  assert.equal(pascoa(2026).toISOString().slice(0, 10), '2026-04-05');
  assert.equal(feriadoNacional('2026-02-16'), 'Carnaval (segunda-feira)');
  assert.equal(feriadoNacional('2026-02-17'), 'Carnaval (terça-feira)');
  assert.equal(feriadoNacional('2026-04-03'), 'Sexta-feira Santa');
  assert.equal(feriadoNacional('2026-06-04'), 'Corpus Christi');
  // 2027: Páscoa 28/03 → Carnaval 08-09/02, Sexta Santa 26/03, Corpus Christi 27/05
  assert.equal(pascoa(2027).toISOString().slice(0, 10), '2027-03-28');
  assert.equal(feriadoNacional('2027-05-27'), 'Corpus Christi');
});

test('13 feriados nacionais por ano, em ordem', () => {
  const lista = feriadosDoAno(2026);
  assert.equal(lista.length, 13);
  assert.deepEqual(lista.map((f) => f.data), [...lista.map((f) => f.data)].sort());
});

test('intervalo atravessando o ano', () => {
  const fer = feriadosNoIntervalo('2026-12-20', '2027-01-05').map((f) => f.data);
  assert.deepEqual(fer, ['2026-12-25', '2027-01-01']);
});

test('dia da semana por código: 08/09/2026 é terça, 07/09 é segunda', () => {
  assert.equal(diaDaSemana('2026-09-08'), 'terça-feira');
  assert.equal(diaDaSemana('2026-09-07'), 'segunda-feira');
  assert.equal(dataPorExtenso('2026-09-08'), 'terça-feira, 08/09/2026');
});

test('data local respeita o fuso (23h30 em Boa Vista ainda é o dia anterior ao de Brasília)', () => {
  const t = new Date(Date.UTC(2026, 8, 7, 3, 30)); // 00:30 Brasília (07/09) · 23:30 Boa Vista (06/09)
  assert.equal(dataLocalISO(t, 'America/Sao_Paulo'), '2026-09-07');
  assert.equal(dataLocalISO(t, 'America/Boa_Vista'), '2026-09-06');
});

test('bloco <calendario>: hoje por extenso, feriado marcado e sem hora (não quebra o cache do prompt)', () => {
  const sexta = new Date(Date.UTC(2026, 8, 4, 15, 0)); // 04/09/2026 12:00 Brasília
  const txt = renderCalendario(sexta, 'America/Sao_Paulo', 7);
  assert.match(txt, /Hoje é sexta-feira, 04\/09\/2026/);
  assert.match(txt, /seg 07\/09 — FERIADO NACIONAL \(Independência do Brasil\), clínica fechada/);
  assert.match(txt, /ter 08\/09 ·/);
  assert.doesNotMatch(txt, /\d{2}:\d{2}/, 'hora do dia mudaria a cada chamada e invalidaria o cache');
});
