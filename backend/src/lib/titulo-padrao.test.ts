import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dataBR, ehSemNome, ehTituloPadrao, montarTituloPadrao, tituloPadraoLiberado } from './titulo-padrao.js';

test('ehSemNome: só o padrão do Kommo e vazio contam como sem nome', () => {
  for (const n of ['Lead #22647811', 'Lead 22647811', 'lead #1', 'Lead', '', '   ', null, undefined]) assert.equal(ehSemNome(n), true, String(n));
  for (const n of ['Lead 23/09/2026', 'Lead 2 23/09/2026', 'Maria', 'Luiz Carlos 23/09/2026', 'Leandro 22/07/26']) assert.equal(ehSemNome(n), false, n);
});

test('ehTituloPadrao: reconhece o nosso provisório, não o nome de gente', () => {
  for (const n of ['Lead 23/09/2026', 'Lead 2 23/09/2026', 'lead 12 01/01/2027']) assert.equal(ehTituloPadrao(n), true, n);
  for (const n of ['Lead #22647811', 'Leandro 23/09/2026', 'Lead 23/09/26', 'Maria', '', null]) assert.equal(ehTituloPadrao(n), false, String(n));
});

test('montarTituloPadrao: primeiro do dia sem número, os seguintes pelo MAIOR já usado', () => {
  assert.equal(montarTituloPadrao('23/09/2026', []), 'Lead 23/09/2026');
  assert.equal(montarTituloPadrao('23/09/2026', ['Maria 23/09/2026', 'Lead #1']), 'Lead 23/09/2026', 'nomeados e padrão do Kommo não contam');
  assert.equal(montarTituloPadrao('23/09/2026', ['Lead 23/09/2026']), 'Lead 2 23/09/2026');
  assert.equal(montarTituloPadrao('23/09/2026', ['Lead 23/09/2026', 'Lead 2 23/09/2026', 'Rosa 23/09/2026']), 'Lead 3 23/09/2026');
  assert.equal(montarTituloPadrao('23/09/2026', ['Maria 23/09/2026', 'Lead 2 23/09/2026']), 'Lead 3 23/09/2026', 'SDR renomeou o 1º: não pode nascer outro "Lead 2"');
  assert.equal(montarTituloPadrao('23/09/2026', ['Lead 5 23/09/2026']), 'Lead 6 23/09/2026');
  assert.equal(montarTituloPadrao('23/09/2026', ['Lead 22/09/2026', 'Lead 2 22/09/2026']), 'Lead 23/09/2026', 'outro dia não conta');
});

test('dataBR usa o fuso da unidade', () => {
  // 2026-09-23T02:30Z = 22/09 23:30 em São Paulo
  assert.equal(dataBR(Date.parse('2026-09-23T02:30:00Z') / 1000, 'America/Sao_Paulo'), '22/09/2026');
  assert.equal(dataBR(Date.parse('2026-09-23T02:30:00Z') / 1000, 'UTC'), '23/09/2026');
});

test('tituloPadraoLiberado: csv, * e vazio', () => {
  assert.equal(tituloPadraoLiberado('doutor-hernia-serra', 'doutor-hernia-serra,laboratorio-kommo'), true);
  assert.equal(tituloPadraoLiberado('doutor-hernia-canaa', 'doutor-hernia-serra'), false);
  assert.equal(tituloPadraoLiberado('qualquer', '*'), true);
  assert.equal(tituloPadraoLiberado('qualquer', ''), false);
  assert.equal(tituloPadraoLiberado('qualquer', undefined), false);
});
