import { test } from 'node:test';
import assert from 'node:assert/strict';

import { downgradeEmoji } from './kommo.service.js';

test('emojis BMP seguros passam intactos (não rebaixados)', () => {
  const safe = '✅ ⭐ ⏰ ⏳ ✨';
  assert.equal(downgradeEmoji(safe), safe);
});

test('emojis 4-byte comuns viram BMP bonitos (não somem)', () => {
  assert.equal(downgradeEmoji('👏'), '✅');
  assert.equal(downgradeEmoji('📍'), '➤');
});

test('a confirmação com emojis seguros chega idêntica', () => {
  const msg =
    '✅ Agendamento confirmado!\n\n⭐ Data: 05/08\n⏰ Horário: 08:00\n⏳ Chegue 15 minutos antes.\n✨ Valor: R$ 150';
  assert.equal(downgradeEmoji(msg), msg);
});

test('4-byte fora do mapa não trunca a mensagem (é removido, resto fica)', () => {
  const out = downgradeEmoji('Olá 💰 tudo certo');
  assert.ok(out.includes('Olá'));
  assert.ok(out.includes('tudo certo'));
});
