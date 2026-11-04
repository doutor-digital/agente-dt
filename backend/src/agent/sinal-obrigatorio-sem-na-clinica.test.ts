import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderRulesGlobal } from './prompt-composer.js';

// Boa Vista (taxa de reserva obrigatória): a Sofia perguntava "Pix antecipado ou pagar tudo na clínica no dia?".
test('unidade com taxa obrigatória: sem o botão "Na clínica" e com a proibição de oferecer pagar no dia', () => {
  const txt = renderRulesGlobal({ spineBookingRequiresPayment: true } as never);
  assert.ok(!txt.includes('"Na clínica"'));
  assert.match(txt, /TAXA OBRIGATÓRIA/);
  assert.match(txt, /NUNCA ofereça pagar tudo na\s+clínica/);
});

test('unidade com antecipado opcional: continua igual (botões "Pix antecipado" ou "Na clínica")', () => {
  const txt = renderRulesGlobal({ spineBookingRequiresPayment: false } as never);
  assert.ok(txt.includes('"Pix antecipado" ou "Na clínica"'));
  assert.ok(!txt.includes('TAXA OBRIGATÓRIA'));
});
