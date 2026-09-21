import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPO,
  MOTIVO_PERDA,
  decidirFalta,
  decidirParado,
  decisaoFollowUpEsgotado,
  follopUpEsgotadoDerruba,
  modoSeco,
  paradosLiberado,
  referenciaEpoch,
  textoDaNota,
} from './parados.js';

const AGORA = Date.parse('2026-09-21T15:00:00Z') / 1000;
const dias = (d: number) => AGORA - d * 86400;
const prazos = { esperaDias: 30, negociacaoDias: 45 };

test('parados: liga por slug ou *, e vazio é ninguém', () => {
  assert.equal(paradosLiberado('doutor-hernia-imperatriz', undefined), false);
  assert.equal(paradosLiberado('doutor-hernia-imperatriz', ''), false);
  assert.equal(paradosLiberado('doutor-hernia-imperatriz', '*'), true);
  assert.equal(paradosLiberado('laboratorio-kommo', '"laboratorio-kommo, doutor-hernia-imperatriz"'), true);
  assert.equal(paradosLiberado('doutor-hernia-serra', 'laboratorio-kommo'), false);
  assert.equal(modoSeco('1'), true);
  assert.equal(modoSeco('0'), false);
  assert.equal(modoSeco(undefined), false);
});

test('parados: o prazo conta da última fala do paciente; sem fala, da entrada na etapa; sem nada, da criação', () => {
  assert.equal(referenciaEpoch({ ultimaMsgPacienteEpoch: 10, entrouNaEtapaEpoch: 20, criadoEpoch: 30 }), 10);
  assert.equal(referenciaEpoch({ ultimaMsgPacienteEpoch: null, entrouNaEtapaEpoch: 20, criadoEpoch: 30 }), 20);
  assert.equal(referenciaEpoch({ ultimaMsgPacienteEpoch: null, entrouNaEtapaEpoch: null, criadoEpoch: 30 }), 30);
  assert.equal(referenciaEpoch({ ultimaMsgPacienteEpoch: null, entrouNaEtapaEpoch: null, criadoEpoch: null }), null);
});

test('parados: EM ESPERA cai em PERDIDO com 30 dias, não com 29', () => {
  const s = (d: number) => ({ ultimaMsgPacienteEpoch: dias(d), entrouNaEtapaEpoch: dias(d + 5), criadoEpoch: dias(d + 10) });
  assert.equal(decidirParado('EM ESPERA', s(29), AGORA, prazos), null);
  const d = decidirParado('EM ESPERA', s(30), AGORA, prazos);
  assert.equal(d?.para, 'PERDIDO');
  assert.equal(d?.motivoPerda, MOTIVO_PERDA.ESPERA);
  assert.deepEqual(d?.campo, { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.ESPERA });
  assert.equal(d?.dias, 30);
});

test('parados: EM NEGOCIAÇÃO cai em PERDIDO com 45 dias e leva o motivo de não fechamento', () => {
  const s = (d: number) => ({ ultimaMsgPacienteEpoch: null, entrouNaEtapaEpoch: dias(d), criadoEpoch: dias(d + 60) });
  assert.equal(decidirParado('EM NEGOCIAÇÃO', s(44), AGORA, prazos), null);
  const d = decidirParado('EM NEGOCIAÇÃO', s(45), AGORA, prazos);
  assert.equal(d?.para, 'PERDIDO');
  assert.equal(d?.motivoPerda, MOTIVO_PERDA.NEGOCIACAO);
  assert.equal(d?.campo?.nome, CAMPO.MOTIVO_NAO_FECHAMENTO);
});

test('parados: paciente que falou ontem não cai, mesmo com meses na etapa', () => {
  const s = { ultimaMsgPacienteEpoch: dias(1), entrouNaEtapaEpoch: dias(90), criadoEpoch: dias(120) };
  assert.equal(decidirParado('EM ESPERA', s, AGORA, prazos), null);
  assert.equal(decidirParado('EM NEGOCIAÇÃO', s, AGORA, prazos), null);
});

test('parados: outras etapas e cartão sem referência nunca são movidos por prazo', () => {
  const s = { ultimaMsgPacienteEpoch: dias(400), entrouNaEtapaEpoch: null, criadoEpoch: null };
  for (const etapa of ['AGENDADO', 'COMPARECEU', 'EM QUALIFICAÇÃO', 'PERDIDO', 'RETORNO PÓS-TRATAMENTO']) {
    assert.equal(decidirParado(etapa, s, AGORA, prazos), null, etapa);
  }
  assert.equal(decidirParado('EM ESPERA', { ultimaMsgPacienteEpoch: null, entrouNaEtapaEpoch: null, criadoEpoch: null }, AGORA, prazos), null);
});

test('parados: falta há 7 dias sem consulta futura vai pra EM ESPERA com retomada em +7', () => {
  assert.equal(decidirFalta(dias(6), false, AGORA, 7), null);
  assert.equal(decidirFalta(dias(10), true, AGORA, 7), null, 'remarcou na franquia: fica');
  assert.equal(decidirFalta(null, false, AGORA, 7), null, 'sem data da falta não inventa');
  const d = decidirFalta(dias(7), false, AGORA, 7);
  assert.equal(d?.para, 'EM ESPERA');
  assert.deepEqual(d?.campo, { nome: CAMPO.MOTIVO_ESPERA, opcao: 'Outro' });
  assert.equal(d?.retomarEmEpoch, AGORA + 7 * 86400);
});

test('parados: régua esgotada só derruba quem está na entrada, em qualificação ou em espera', () => {
  for (const e of ['Incoming leads', 'Etapa de leads de entrada', 'EM QUALIFICAÇÃO', 'EM ESPERA']) {
    assert.equal(follopUpEsgotadoDerruba(e), true, e);
  }
  for (const e of ['AGENDADO', 'EM NEGOCIAÇÃO', 'COMPARECEU', 'NÃO COMPARECEU']) {
    assert.equal(follopUpEsgotadoDerruba(e), false, e);
  }
  const d = decisaoFollowUpEsgotado();
  assert.equal(d.motivoPerda, MOTIVO_PERDA.FOLLOW_UP);
  assert.equal(d.campo?.opcao, 'Não interagiu');
});

test('parados: a nota diz de onde veio, por que e o que acontece se o paciente voltar', () => {
  const perdido = decidirParado('EM ESPERA', { ultimaMsgPacienteEpoch: dias(31), entrouNaEtapaEpoch: null, criadoEpoch: null }, AGORA, prazos)!;
  const t = textoDaNota(perdido, 'EM ESPERA');
  assert.match(t, /EM ESPERA para PERDIDO/);
  assert.match(t, /31 dias/);
  assert.match(t, /Não deu continuidade ao atendimento/);
  const espera = decidirFalta(dias(8), false, AGORA, 7)!;
  assert.match(textoDaNota(espera, 'NÃO COMPARECEU'), /NÃO COMPARECEU para EM ESPERA/);
});
