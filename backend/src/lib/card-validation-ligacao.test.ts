import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarContexto, soMudancasIgnoradas } from './card-validation-worker.js';

const campos = [
  { id: 1, name: '✓ Fechou tratamento' },
  { id: 2, name: '¤ Valor do tratamento' },
  { id: 10, name: '☎ Última ligação' },
  { id: 11, name: '☎ Resultado' },
  { id: 12, name: '☎ Gravação' },
];

test('validador: campos ☎ do rastreio de ligação entram no conjunto ignorado', () => {
  const ctx = montarContexto(campos, [{ id: 1, name: 'COMERCIAL', statuses: [{ id: 5, name: 'AGENDADO' }] }]);
  assert.deepEqual([...ctx.camposLigacao].sort(), [10, 11, 12]);
  assert.deepEqual(ctx.campos.FECHOU_TRAT, [1]);
});

test('validador: cartão mexido só pelo robô das ligações não gera alerta', () => {
  const ctx = montarContexto(campos, []);
  const soLigacao = [
    { type: 'custom_field_10_value_changed' },
    { type: 'custom_field_11_value_changed' },
    { type: 'custom_field_12_value_changed' },
  ];
  assert.equal(soMudancasIgnoradas(soLigacao, ctx.camposLigacao), true);
});

test('validador: qualquer outra mudança no cartão mantém a validação', () => {
  const ctx = montarContexto(campos, []);
  assert.equal(soMudancasIgnoradas([{ type: 'custom_field_10_value_changed' }, { type: 'lead_status_changed' }], ctx.camposLigacao), false);
  assert.equal(soMudancasIgnoradas([{ type: 'custom_field_1_value_changed' }], ctx.camposLigacao), false);
  assert.equal(soMudancasIgnoradas([], ctx.camposLigacao), false, 'sem eventos (API falhou ou atrasou) segue como antes');
});
