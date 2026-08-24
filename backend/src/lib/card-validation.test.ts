import { test } from 'node:test';
import assert from 'node:assert/strict';

import { montarContexto, avaliarLead, NOMES_CAMPO } from './card-validation-worker.js';

const ITZ = { comercial: 14091100, tratamento: 14091116, agendado: 108773008 };
const OUTRA = { comercial: 13789563, tratamento: 99000001, agendado: 106518979 };

const CAMPOS_ITZ = [
  { id: 2442703, name: NOMES_CAMPO.AGENDOU },
  { id: 2443059, name: NOMES_CAMPO.TIPO_AGENDAMENTO },
  { id: 2444779, name: NOMES_CAMPO.SITUACAO_CONSULTA },
  { id: 2440909, name: NOMES_CAMPO.AGENDADO_SDR_EM },
  { id: 2444497, name: NOMES_CAMPO.DATA_CONSULTA },
  { id: 2442715, name: NOMES_CAMPO.FORMA_PAGAMENTO },
  { id: 2442951, name: NOMES_CAMPO.FORMA_PAGAMENTO },
];

const CAMPOS_OUTRA = CAMPOS_ITZ.map((c, i) => ({ id: 700000 + i, name: c.name }));

const pipes = (p: typeof ITZ) => [
  { id: p.comercial, name: 'COMERCIAL', statuses: [{ id: p.agendado, name: 'AGENDADO' }] },
  { id: p.tratamento, name: 'TRATAMENTO', statuses: [{ id: 143, name: 'TRATAMENTO CANCELADO' }] },
];

const ctxItz = montarContexto(CAMPOS_ITZ, pipes(ITZ));
const ctxOutra = montarContexto(CAMPOS_OUTRA, pipes(OUTRA));

const agora = Math.floor(Date.now() / 1000);
const futuro = agora + 7 * 86_400;

function lead(pipelineId: number, statusId: number, campos: Array<[number, string | number]>) {
  return {
    id: 1,
    name: 'Teste',
    pipeline_id: pipelineId,
    status_id: statusId,
    custom_fields_values: campos.map(([id, value]) => ({ field_id: id, values: [{ value }] })),
  } as never;
}

const okItz: Array<[number, string | number]> = [
  [2442703, 'Sim'],
  [2443059, 'Cadastro'],
  [2444779, 'Agendado'],
];

test('resolve os campos por nome em qualquer conta', () => {
  assert.deepEqual(ctxItz.campos.AGENDADO_SDR_EM, [2440909]);
  assert.equal(ctxItz.pipeComercial, ITZ.comercial);
  assert.equal(ctxItz.stAgendado, ITZ.agendado);
  assert.equal(ctxOutra.pipeComercial, OUTRA.comercial);
  assert.equal(ctxOutra.stAgendado, OUTRA.agendado);
  assert.notDeepEqual(ctxOutra.campos.AGENDADO_SDR_EM, ctxItz.campos.AGENDADO_SDR_EM);
});

test('campo com nome repetido resolve para os dois ids', () => {
  assert.deepEqual(ctxItz.campos.FORMA_PAGAMENTO, [2442715, 2442951]);
});

test('pega "Agendado pela SDR em" vazio', () => {
  const achados = avaliarLead(lead(ITZ.comercial, ITZ.agendado, [...okItz, [2444497, futuro]]), ctxItz);
  const a2 = achados.find((x) => x.key === 'A2_data_agendamento_invalida');
  assert.ok(a2);
  assert.match(a2.erro, /vazio/);
});

test('pega data de agendamento no futuro', () => {
  const achados = avaliarLead(
    lead(ITZ.comercial, ITZ.agendado, [...okItz, [2440909, futuro], [2444497, futuro]]),
    ctxItz,
  );
  assert.ok(achados.some((x) => /FUTURA|igual/.test(x.erro)));
});

test('cartão certo não gera achado', () => {
  const achados = avaliarLead(
    lead(ITZ.comercial, ITZ.agendado, [...okItz, [2440909, agora - 1800], [2444497, futuro]]),
    ctxItz,
  );
  assert.deepEqual(achados, []);
});

test('lead de OUTRA conta é avaliado com os ids DELA', () => {
  const idsOutra = Object.fromEntries(CAMPOS_OUTRA.map((c) => [c.name, c.id]));
  const bom = avaliarLead(
    lead(OUTRA.comercial, OUTRA.agendado, [
      [idsOutra[NOMES_CAMPO.AGENDOU], 'Sim'],
      [idsOutra[NOMES_CAMPO.TIPO_AGENDAMENTO], 'Cadastro'],
      [idsOutra[NOMES_CAMPO.SITUACAO_CONSULTA], 'Agendado'],
      [idsOutra[NOMES_CAMPO.AGENDADO_SDR_EM], agora - 1800],
      [idsOutra[NOMES_CAMPO.DATA_CONSULTA], futuro],
    ]),
    ctxOutra,
  );
  assert.deepEqual(bom, []);
});

test('lead da Imperatriz não é avaliado com o contexto de outra conta', () => {
  const l = lead(ITZ.comercial, ITZ.agendado, [...okItz, [2440909, agora - 1800], [2444497, futuro]]);
  assert.deepEqual(avaliarLead(l, ctxOutra), []);
});

test('conta sem funil COMERCIAL não quebra', () => {
  const vazio = montarContexto([], []);
  assert.equal(vazio.pipeComercial, null);
  assert.equal(vazio.stAgendado, null);
  assert.deepEqual(avaliarLead(lead(1, 2, []), vazio), []);
});
