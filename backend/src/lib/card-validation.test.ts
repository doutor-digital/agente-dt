import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REGRAS_CARD } from './card-validation-worker.js';

const PIPE_COMERCIAL = 14091100;
const AGENDADO = 108773008;
const F_AGENDOU = 2442703;
const F_TIPO = 2443059;
const F_SITUACAO = 2444779;
const F_AGENDADO_SDR = 2440909;
const F_DATA_CONSULTA = 2444497;

const agora = Math.floor(Date.now() / 1000);
const futuro = agora + 7 * 86_400;

function lead(campos: Record<number, string | number>) {
  return {
    id: 1,
    name: 'Teste',
    pipeline_id: PIPE_COMERCIAL,
    status_id: AGENDADO,
    custom_fields_values: Object.entries(campos).map(([id, value]) => ({
      field_id: Number(id),
      values: [{ value }],
    })),
  } as never;
}

const regraData = REGRAS_CARD.find((r) => r.key === 'A2_data_agendamento_invalida')!;

const completos = {
  [F_AGENDOU]: 'Sim',
  [F_TIPO]: 'Cadastro',
  [F_SITUACAO]: 'Agendado',
};

test('pega o caso real: "Agendado pela SDR em" vazio', () => {
  const l = lead({ ...completos, [F_DATA_CONSULTA]: futuro });
  const erro = regraData.erro(l);
  assert.ok(erro);
  assert.match(erro, /vazio/);
});

test('pega o caso real: data de agendamento no futuro (data da consulta no campo errado)', () => {
  const l = lead({ ...completos, [F_AGENDADO_SDR]: futuro, [F_DATA_CONSULTA]: futuro });
  const erro = regraData.erro(l);
  assert.ok(erro);
  assert.match(erro, /FUTURA|igual/);
});

test('pega quando os dois campos têm o mesmo valor', () => {
  const mesmo = agora - 3600;
  const l = lead({ ...completos, [F_AGENDADO_SDR]: mesmo, [F_DATA_CONSULTA]: mesmo });
  const erro = regraData.erro(l);
  assert.ok(erro);
  assert.match(erro, /igual/);
});

test('cartão preenchido certo não gera alerta', () => {
  const l = lead({ ...completos, [F_AGENDADO_SDR]: agora - 1800, [F_DATA_CONSULTA]: futuro });
  assert.equal(regraData.erro(l), null);
});

test('só vale para lead em AGENDADO no funil comercial', () => {
  const l = lead(completos) as unknown as { status_id: number };
  l.status_id = 142;
  assert.equal(regraData.aplica(l as never), false);
});
