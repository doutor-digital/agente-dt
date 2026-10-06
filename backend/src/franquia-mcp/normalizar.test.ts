import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diaLocal, normalizarItem, normalizarWhatsapp, paraLocal } from './normalizar.js';

test('UTC vira hora local — o caso medido em produção (Canaã, 26/08/2026)', () => {
  // a franquia gravou 2026-09-08T20:00:00.000Z para uma consulta das 17:00 em SP
  assert.equal(paraLocal('2026-09-08T20:00:00.000Z', 'America/Sao_Paulo'), '2026-09-08T17:00:00');
  assert.equal(paraLocal('2026-09-08T20:00:00Z', 'America/Manaus'), '2026-09-08T16:00:00');
});

test('dia local muda na virada: 01:00 UTC é 22:00 do dia anterior em SP', () => {
  assert.equal(diaLocal('2026-10-07T01:00:00.000Z', 'America/Sao_Paulo'), '2026-10-06');
});

test('sem fuso explícito vale o guia (§9.2: UTC); outros formatos de fuso também', () => {
  assert.equal(paraLocal('2026-09-08T20:00:00', 'America/Sao_Paulo'), '2026-09-08T17:00:00');
  assert.equal(paraLocal('2026-09-08 20:00:00', 'America/Sao_Paulo'), '2026-09-08T17:00:00');
  assert.equal(paraLocal('2026-09-08T20:00:00+0000', 'America/Sao_Paulo'), '2026-09-08T17:00:00');
  assert.equal(paraLocal('2026-09-08T17:00:00-03:00', 'America/Sao_Paulo'), '2026-09-08T17:00:00');
});

test('só data, ou o que não é data, não vira instante', () => {
  assert.equal(paraLocal('2026-09-08', 'America/Sao_Paulo'), null);
  assert.equal(paraLocal('ontem', 'America/Sao_Paulo'), null);
  assert.equal(paraLocal(123, 'America/Sao_Paulo'), null);
});

test('WhatsApp em +55DDNNNNNNNNN', () => {
  assert.equal(normalizarWhatsapp('5541999999999'), '+5541999999999');
  assert.equal(normalizarWhatsapp('+55 (41) 99999-9999'), '+5541999999999');
  assert.equal(normalizarWhatsapp('(41) 99999-9999'), '+5541999999999');
  assert.equal(normalizarWhatsapp('4133334444'), '+554133334444'); // fixo, 10 dígitos
  assert.equal(normalizarWhatsapp(5541999999999), '+5541999999999');
});

test('número que não é celular brasileiro vira null, não chave errada', () => {
  for (const ruim of ['', '123', '999999999', '1 555 123 4567 89', null, undefined, {}]) {
    assert.equal(normalizarWhatsapp(ruim), null, String(ruim));
  }
});

test('normalizarItem acrescenta …Local e …E164 sem mexer no original', () => {
  const original = { idClient: 1, whatsapp: '5541999999999', created: '2026-09-08T20:00:00Z', name: 'Ana' };
  const saida = normalizarItem(original, 'America/Sao_Paulo') as Record<string, unknown>;
  assert.equal(saida.whatsappE164, '+5541999999999');
  assert.equal(saida.createdLocal, '2026-09-08T17:00:00');
  assert.equal(saida.created, '2026-09-08T20:00:00Z');
  assert.equal(saida.name, 'Ana');
  assert.equal('whatsappE164' in original, false);
});
