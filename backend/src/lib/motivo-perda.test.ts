import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REGRAS_CARD, montarContexto } from './card-validation-worker.js';

const CAMPOS = [
  { id: 900, name: '⊘ Motivo do não agendamento' },
  { id: 901, name: '⊘ Motivo de não fechamento do tratamento' },
];
const PIPELINES = [
  { id: 10, name: 'COMERCIAL', statuses: [{ id: 143, name: 'PERDIDO' }, { id: 20, name: 'AGENDADO' }] },
  { id: 11, name: 'TRATAMENTO', statuses: [{ id: 143, name: 'TRATAMENTO CANCELADO' }] },
];
const ctx = montarContexto(CAMPOS, PIPELINES);
const regra = REGRAS_CARD.find((r) => r.key === 'C_perdido_sem_motivo')!;

function avaliar(lead: Record<string, unknown>) {
  const l = { id: 1, name: 'Teste', pipeline_id: 10, status_id: 143, ...lead } as never;
  if (!regra.aplica(l, ctx)) return null;
  const ler = {
    vazio: (c: 'MOTIVO_NAO_AGEND' | 'MOTIVO_NAO_FECH') => {
      const ids = ctx.campos[c];
      const vs = ((l as { custom_fields_values?: Array<{ field_id: number; values: Array<{ value: string }> }> })
        .custom_fields_values ?? []).filter((f) => ids.includes(f.field_id));
      return vs.length === 0;
    },
    igual: () => false,
    data: () => null,
  } as never;
  return regra.erro(ler, l);
}

test('caso real de Açailândia: motivo NATIVO do Kommo conta como preenchido', () => {
  assert.equal(avaliar({ loss_reason_id: 38405099 }), null);
});

test('sem motivo nenhum continua sendo apontado', () => {
  assert.ok(avaliar({ loss_reason_id: null }));
});

test('motivo no campo customizado também vale', () => {
  const r = avaliar({
    loss_reason_id: null,
    custom_fields_values: [{ field_id: 900, values: [{ value: 'Achou caro' }] }],
  });
  assert.equal(r, null);
});

test('cartão no funil TRATAMENTO não é avaliado por esta regra', () => {
  assert.equal(avaliar({ pipeline_id: 11 }), null);
});
