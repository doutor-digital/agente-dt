import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMPOS_CARIMBO, carimboEtapaLiberado, carimbosDaEtapa } from './carimbo-etapa.js';
import { montarEsquema } from './kommo-schema.js';

const AGORA = 1_789_000_000;

test('EM TRATAMENTO carimba o início, só se vazio', () => {
  const c = carimbosDaEtapa('EM TRATAMENTO', AGORA);
  assert.equal(c.length, 1);
  assert.equal(c[0].campo, CAMPOS_CARIMBO.INICIO_TRAT);
  assert.equal(c[0].tipo, 'date');
  assert.equal(c[0].valor, AGORA);
  assert.equal(c[0].soSeVazio, true);
});

test('ALTA e TRATAMENTO CANCELADO carimbam o fim do tratamento', () => {
  for (const etapa of ['ALTA', 'Alta', 'TRATAMENTO CANCELADO', 'Tratamento cancelado']) {
    const c = carimbosDaEtapa(etapa, AGORA);
    assert.equal(c.length, 1, etapa);
    assert.equal(c[0].campo, CAMPOS_CARIMBO.FIM_TRAT, etapa);
    assert.equal(c[0].soSeVazio, true, etapa);
  }
});

test('GANHO / CONCLUÍDO e PERDIDO encerram a conversa (sobrescrevendo)', () => {
  for (const etapa of ['GANHO / CONCLUÍDO', 'GANHO', 'Ganho/Concluído', 'PERDIDO']) {
    const c = carimbosDaEtapa(etapa, AGORA);
    assert.equal(c.length, 1, etapa);
    assert.equal(c[0].campo, CAMPOS_CARIMBO.STATUS_CONVERSA, etapa);
    assert.equal(c[0].valor, 'Encerrada', etapa);
    assert.equal(c[0].soSeVazio, false, etapa);
  }
});

test('etapas intermediárias não carimbam nada', () => {
  for (const etapa of ['EM QUALIFICAÇÃO', 'EM ESPERA', 'AGENDADO', 'NÃO COMPARECEU', 'COMPARECEU', 'EM NEGOCIAÇÃO', 'RETORNO PÓS-TRATAMENTO', 'Incoming leads', '']) {
    assert.deepEqual(carimbosDaEtapa(etapa, AGORA), [], etapa);
  }
});

test('142/143 resolvem pelo nome do funil certo (COMERCIAL × TRATAMENTO)', () => {
  const esquema = montarEsquema([], [
    { id: 1, name: 'COMERCIAL', statuses: [{ id: 142, name: 'GANHO / CONCLUÍDO' }, { id: 143, name: 'PERDIDO' }] },
    { id: 2, name: 'TRATAMENTO', statuses: [{ id: 10, name: 'EM TRATAMENTO' }, { id: 142, name: 'ALTA' }, { id: 143, name: 'TRATAMENTO CANCELADO' }] },
  ]);
  assert.equal(esquema.nomeDoStatus(2, 142)?.status, 'ALTA');
  assert.equal(esquema.nomeDoStatus(1, 142)?.status, 'GANHO / CONCLUÍDO');
  assert.equal(esquema.nomeDoStatus(1, 999), null);
  assert.equal(carimbosDaEtapa(esquema.nomeDoStatus(2, 143)!.status, AGORA)[0].campo, CAMPOS_CARIMBO.FIM_TRAT);
  assert.equal(carimbosDaEtapa(esquema.nomeDoStatus(1, 143)!.status, AGORA)[0].campo, CAMPOS_CARIMBO.STATUS_CONVERSA);
});

test('flag por unidade: vazio = desligado, * = todas, csv com aspas do .env', () => {
  assert.equal(carimboEtapaLiberado('laboratorio-kommo', undefined), false);
  assert.equal(carimboEtapaLiberado('laboratorio-kommo', ''), false);
  assert.equal(carimboEtapaLiberado('laboratorio-kommo', '*'), true);
  assert.equal(carimboEtapaLiberado('laboratorio-kommo', 'doutor-hernia-imperatriz, laboratorio-kommo'), true);
  assert.equal(carimboEtapaLiberado('laboratorio-kommo', "'laboratorio-kommo'"), true);
  assert.equal(carimboEtapaLiberado('doutor-hernia-serra', 'laboratorio-kommo'), false);
});
