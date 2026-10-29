import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _esperandoParaTeste,
  _limparTurnosParaTeste,
  aguardarMarcacaoDaIa,
  comMarcacaoEmCurso,
  ehCarimboDeMarcacaoDaIa,
  registrarMarcacaoDaIa,
} from './marcacao-da-ia-no-turno.js';

beforeEach(() => _limparTurnosParaTeste());
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('ehCarimboDeMarcacaoDaIa: SÓ "feito por = IA" (quem marcou); "Situação = Agendado" é estado da consulta e não é travado', () => {
  assert.equal(ehCarimboDeMarcacaoDaIa('⬢ Agendamento feito por', 'IA'), true);
  assert.equal(ehCarimboDeMarcacaoDaIa('⬢ Agendamento feito por', ' ia '), true);
  assert.equal(ehCarimboDeMarcacaoDaIa('⬢ Agendamento feito por', ['IA']), true);
  assert.equal(ehCarimboDeMarcacaoDaIa('⬢ Agendamento feito por', 'Humano'), false);
  assert.equal(ehCarimboDeMarcacaoDaIa('✓ Situação da consulta', 'Agendado'), false);
  assert.equal(ehCarimboDeMarcacaoDaIa('✓ Situação da consulta', 'Confirmado'), false);
  assert.equal(ehCarimboDeMarcacaoDaIa('◷ Data da Consulta', 'IA'), false);
});

test('ehCarimboDeMarcacaoDaIa: o nome do campo casa pela normalização do Kommo (símbolo, acento, caixa), e cabeçalho de grupo nunca', () => {
  assert.equal(ehCarimboDeMarcacaoDaIa('Agendamento feito por', 'IA'), true);
  assert.equal(ehCarimboDeMarcacaoDaIa('⬢ AGENDAMENTO  FEITO POR', 'IA'), true);
  assert.equal(ehCarimboDeMarcacaoDaIa('## Agendamento feito por', 'IA'), false);
});

test('sem tentativa nenhuma no turno: falso (depois da folga curta)', async () => {
  assert.equal(await aguardarMarcacaoDaIa('t1', { gracaMs: 5 }), false);
  assert.equal(await aguardarMarcacaoDaIa(undefined, { gracaMs: 5 }), false);
});

test('marcação já registrada: verdadeiro na hora, sem folga', async () => {
  registrarMarcacaoDaIa('t2');
  const t0 = Date.now();
  assert.equal(await aguardarMarcacaoDaIa('t2', { gracaMs: 5_000 }), true);
  assert.ok(Date.now() - t0 < 500);
});

test('tentativa em andamento: espera o desfecho — deu certo = verdadeiro, falhou = falso', async () => {
  const ok = comMarcacaoEmCurso('t3', async () => {
    await dormir(40);
    registrarMarcacaoDaIa('t3');
  });
  assert.equal(await aguardarMarcacaoDaIa('t3', { gracaMs: 5 }), true);
  await ok;

  const falha = comMarcacaoEmCurso('t4', async () => {
    await dormir(40);
  });
  assert.equal(await aguardarMarcacaoDaIa('t4', { gracaMs: 5 }), false);
  await falha;
});

test('tentativa que começa DEPOIS do pedido, dentro da folga, também é esperada', async () => {
  const espera = aguardarMarcacaoDaIa('t5', { gracaMs: 100 });
  await dormir(10);
  await comMarcacaoEmCurso('t5', async () => {
    await dormir(20);
    registrarMarcacaoDaIa('t5');
  });
  assert.equal(await espera, true);
});

test('tentativa travada: a espera tem teto e responde falso', async () => {
  let solta: () => void = () => undefined;
  const presa = comMarcacaoEmCurso('t6', () => new Promise<void>((r) => (solta = r)));
  const t0 = Date.now();
  assert.equal(await aguardarMarcacaoDaIa('t6', { gracaMs: 5, limiteMs: 60 }), false);
  assert.equal(_esperandoParaTeste('t6'), 0, 'o pedido que estourou o teto não fica preso na lista');
  assert.ok(Date.now() - t0 < 1_000);
  solta();
  await presa;
});

test('a tentativa lança erro: o turno não fica preso esperando', async () => {
  const quebra = comMarcacaoEmCurso('t7', async () => {
    await dormir(10);
    throw new Error('boom');
  }).catch(() => undefined);
  assert.equal(await aguardarMarcacaoDaIa('t7', { gracaMs: 5 }), false);
  await quebra;
});
