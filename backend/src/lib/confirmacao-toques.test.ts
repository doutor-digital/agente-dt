import { test } from 'node:test';
import assert from 'node:assert/strict';

import { botsDeConfirmacao, reforcoLiberado, toqueDoDia } from './reminder-worker.js';
import { diaCurto, textoConfirmacaoD1 } from './confirmacao-d1.js';

test('toque do dia: véspera é D-1, reforço é D-2, o resto é nenhum', () => {
  assert.equal(toqueDoDia('2026-09-23', '2026-09-22'), 'd1');
  assert.equal(toqueDoDia('2026-09-24', '2026-09-22'), 'd2');
  assert.equal(toqueDoDia('2026-09-22', '2026-09-22'), null, 'hoje não recebe');
  assert.equal(toqueDoDia('2026-09-25', '2026-09-22'), null, 'três dias antes ainda não');
  assert.equal(toqueDoDia('2026-09-21', '2026-09-22'), null, 'ontem não');
});

test('toque do dia: a virada de mês e de ano não engana', () => {
  assert.equal(toqueDoDia('2026-10-01', '2026-09-30'), 'd1');
  assert.equal(toqueDoDia('2026-10-01', '2026-09-29'), 'd2');
  assert.equal(toqueDoDia('2027-01-01', '2026-12-31'), 'd1');
  assert.equal(toqueDoDia('2027-01-01', '2026-12-30'), 'd2');
});

test('reforço D-2 entra unidade por unidade; vazio é ninguém', () => {
  assert.equal(reforcoLiberado('doutor-hernia-serra', undefined), false);
  assert.equal(reforcoLiberado('doutor-hernia-serra', ''), false);
  assert.equal(reforcoLiberado('doutor-hernia-serra', 'doutor-hernia-serra'), true);
  assert.equal(reforcoLiberado('doutor-hernia-serra', '"doutor-hernia-serra, laboratorio-kommo"'), true);
  assert.equal(reforcoLiberado('doutor-hernia-porto', 'doutor-hernia-serra'), false);
  assert.equal(reforcoLiberado('qualquer-uma', '*'), true);
});

test('ids dos bots saem do pipeline_intents e ignoram lixo', () => {
  assert.deepEqual(botsDeConfirmacao({ pipelineIntents: { confirmacao_salesbot_id: 918, reforco_salesbot_id: 920 } }), { d1: 918, d2: 920 });
  assert.deepEqual(botsDeConfirmacao({ pipelineIntents: {} }), { d1: null, d2: null });
  assert.deepEqual(botsDeConfirmacao({ pipelineIntents: null }), { d1: null, d2: null });
  assert.deepEqual(botsDeConfirmacao({ pipelineIntents: { confirmacao_salesbot_id: '918' } }), { d1: null, d2: null }, 'texto não vira id');
  assert.deepEqual(botsDeConfirmacao({ pipelineIntents: { confirmacao_salesbot_id: 0 } }), { d1: null, d2: null });
});

test('o texto do reforço não diz "amanhã"; o da véspera diz', () => {
  const base = { nome: 'Maria Helena', quando: '2026-09-24T15:00', especialista: null, endereco: null };
  const d1 = textoConfirmacaoD1({ ...base, antecedencia: 'd1' });
  const d2 = textoConfirmacaoD1({ ...base, antecedencia: 'd2' });
  assert.match(d1, /consulta de amanhã/);
  assert.doesNotMatch(d2, /amanhã/);
  for (const t of [d1, d2]) {
    assert.match(t, /24\/09 às 15:00/, 'sempre com dia e hora');
    assert.match(t, /Oi, Maria!/, 'só o primeiro nome');
    assert.doesNotMatch(t, /\[|\]/, 'nunca colchete — o paciente não pode receber lacuna');
  }
});

test('dia curto traz o dia da semana da própria data', () => {
  assert.equal(diaCurto('2026-09-24T15:00'), 'quinta, 24/09');
  assert.equal(diaCurto('2026-09-21T09:30'), 'segunda, 21/09');
  assert.equal(diaCurto('data-ruim'), 'data-ruim');
});
