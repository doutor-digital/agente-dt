/**
 * Motivo no topo do cartão perdido (20/10/2026): o cartão em PERDIDO mostrava "Motivo indefinido" com o motivo
 * preenchido logo abaixo, e isso confundia as SDRs no vídeo de treinamento de Petrópolis.
 *
 * O que estes testes prendem:
 *  - copia o ⊘ só para cartão perdido (143) com o topo vazio; nunca troca o topo já preenchido;
 *  - campo vazio não vira motivo inventado;
 *  - qual campo vence: no COMERCIAL o de não fechamento (com o nome antigo também), depois o do não agendamento;
 *    no TRATAMENTO, o do cancelamento;
 *  - a janela de leitura anda sem pular nem ficar presa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PERDIDO, motivoDoCampo, planejarMotivoNoCabecalho, proximoDesde } from './motivo-no-cabecalho.js';

const campo = (field_name: string, value: string) => ({ field_name, values: [{ value }] });
const naoAgendou = campo('⊘ Motivo do não agendamento', 'Sem condições financeiras');

test('PERDIDO com o topo vazio: copia o motivo do campo', () => {
  assert.equal(planejarMotivoNoCabecalho({ status_id: PERDIDO, loss_reason_id: null, custom_fields_values: [naoAgendou] }, 'COMERCIAL'), 'Sem condições financeiras');
  assert.equal(planejarMotivoNoCabecalho({ status_id: PERDIDO, loss_reason_id: 0, custom_fields_values: [naoAgendou] }, 'COMERCIAL'), 'Sem condições financeiras');
});

test('nunca troca o topo já preenchido, nem mexe em cartão aberto, nem inventa motivo', () => {
  assert.equal(planejarMotivoNoCabecalho({ status_id: PERDIDO, loss_reason_id: 38906699, custom_fields_values: [naoAgendou] }, 'COMERCIAL'), null);
  assert.equal(planejarMotivoNoCabecalho({ status_id: 111915771, loss_reason_id: null, custom_fields_values: [naoAgendou] }, 'COMERCIAL'), null);
  assert.equal(planejarMotivoNoCabecalho({ status_id: PERDIDO, loss_reason_id: null, custom_fields_values: [] }, 'COMERCIAL'), null);
  assert.equal(planejarMotivoNoCabecalho({ status_id: PERDIDO, loss_reason_id: null, custom_fields_values: [campo('⊘ Motivo do não agendamento', '  ')] }, 'COMERCIAL'), null);
  assert.equal(planejarMotivoNoCabecalho({ status_id: PERDIDO, loss_reason_id: null, custom_fields_values: [naoAgendou] }, null), null);
});

test('COMERCIAL: não fechamento vence o não agendamento; o nome antigo do campo também vale', () => {
  const naoFechou = campo('⊘ Motivo de não fechamento', 'Decidir com a família');
  assert.equal(motivoDoCampo([naoAgendou, naoFechou], 'COMERCIAL'), 'Decidir com a família');
  assert.equal(motivoDoCampo([campo('⊘ Motivo de não fechamento do tratamento', 'Vai viajar')], 'COMERCIAL'), 'Vai viajar');
  assert.equal(motivoDoCampo([naoAgendou], 'COMERCIAL'), 'Sem condições financeiras');
});

test('TRATAMENTO CANCELADO: o motivo do cancelamento, não os do COMERCIAL', () => {
  const cancelou = campo('⊘ Motivo do cancelamento do tratamento', 'Mudou de cidade');
  assert.equal(motivoDoCampo([naoAgendou, cancelou], 'TRATAMENTO'), 'Mudou de cidade');
  assert.equal(motivoDoCampo([naoAgendou], 'TRATAMENTO'), null);
});

test('janela: sobra além do teto recomeça nela; limite de páginas recomeça no último lido; leu tudo, anda até o início da rodada', () => {
  assert.equal(proximoDesde({ inicio: 1000, completo: true, sobra: { updated_at: 500 }, ultimo: { updated_at: 900 } }), 500);
  assert.equal(proximoDesde({ inicio: 1000, completo: false, ultimo: { updated_at: 900 } }), 900);
  assert.equal(proximoDesde({ inicio: 1000, completo: true, ultimo: { updated_at: 900 } }), 1000);
  assert.equal(proximoDesde({ inicio: 1000, completo: true }), 1000);
});
