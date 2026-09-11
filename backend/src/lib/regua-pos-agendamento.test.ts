import test from 'node:test';
import assert from 'node:assert/strict';
import { foraDaJanelaDeCobranca, COBRANCA_INICIO_MIN, COBRANCA_FIM_MIN } from './follow-up-worker.js';
import { PRESETS, ETAPAS } from './follow-up-presets.js';
import { porQueNaoReservar, orientacaoDePagamento } from '../agent/agenda-tools.js';

test('régua de pagamento não sai de madrugada nem depois das 21h', () => {
  assert.equal(foraDaJanelaDeCobranca(2 * 60 + 10), true, '02:10');
  assert.equal(foraDaJanelaDeCobranca(7 * 60 + 59), true, '07:59');
  assert.equal(foraDaJanelaDeCobranca(COBRANCA_INICIO_MIN), false, '08:00');
  assert.equal(foraDaJanelaDeCobranca(13 * 60), false, '13:00');
  assert.equal(foraDaJanelaDeCobranca(COBRANCA_FIM_MIN - 1), false, '20:59');
  assert.equal(foraDaJanelaDeCobranca(COBRANCA_FIM_MIN), true, '21:00');
  assert.equal(foraDaJanelaDeCobranca(23 * 60 + 30), true, '23:30');
});

test('preset AGENDADO: no máximo 2 degraus, todos só para quem escolheu Pix e ainda não pagou', () => {
  const agendado = PRESETS.find((p) => p.statusId === ETAPAS.AGENDADO);
  assert.ok(agendado);
  assert.ok(agendado.steps.length <= 2, `tem ${agendado.steps.length} degraus`);
  for (const d of agendado.steps) {
    assert.equal(d.pularSePagou, true);
    assert.equal(d.soPix, true);
    assert.doesNotMatch(d.intencao, /vagas s[ãa]o concorridas/i);
    assert.doesNotMatch(d.intencao, /pe[çc]a o COMPROVANTE/i);
  }
  assert.ok(agendado.steps[1].aposMin >= 24 * 60, 'segundo degrau só no dia seguinte');
});

test('porQueNaoReservar: sem dia confirmado e sem forma de pagamento, recusa e lista as duas pendências', () => {
  const r = porQueNaoReservar({});
  assert.ok(r);
  assert.match(r, /NÃO marcada/);
  assert.match(r, /1\) confirmar com o paciente/);
  assert.match(r, /2\) perguntar como ele prefere pagar/);
});

test('porQueNaoReservar: só uma pendência quando falta uma coisa', () => {
  const soPg = porQueNaoReservar({ diaConfirmado: true });
  assert.ok(soPg);
  assert.match(soPg, /1\) perguntar como ele prefere pagar/);
  assert.doesNotMatch(soPg, /2\)/);
  const soDia = porQueNaoReservar({ formaPagamento: 'na_clinica' });
  assert.ok(soDia);
  assert.match(soDia, /1\) confirmar com o paciente/);
  assert.doesNotMatch(soDia, /2\)/);
});

test('porQueNaoReservar: libera com as duas respostas e sempre em remarcação', () => {
  assert.equal(porQueNaoReservar({ diaConfirmado: true, formaPagamento: 'pix_antecipado' }), null);
  assert.equal(porQueNaoReservar({ diaConfirmado: true, formaPagamento: 'na_clinica' }), null);
  assert.equal(porQueNaoReservar({ remarcando: true }), null);
  assert.ok(porQueNaoReservar({ diaConfirmado: true, formaPagamento: 'cartao' }), 'forma desconhecida não libera');
});

test('orientacaoDePagamento: Pix manda chave e prazo; na clínica proíbe falar de Pix', () => {
  assert.match(orientacaoDePagamento('pix_antecipado'), /chave Pix/);
  assert.match(orientacaoDePagamento('pix_antecipado'), /véspera/);
  assert.match(orientacaoDePagamento('pix_antecipado'), /NÃO peça comprovante/);
  assert.match(orientacaoDePagamento('na_clinica'), /NÃO mencione Pix/);
  assert.equal(orientacaoDePagamento(undefined), '');
});
