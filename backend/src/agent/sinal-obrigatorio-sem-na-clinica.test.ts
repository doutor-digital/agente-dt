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

import { RECUSA_SEM_COMPROVANTE_DA_TAXA } from './confirmacao-so-com-crm.js';
import { buildAgendarConsulta } from './agenda-tools.js';

test('a recusa sem comprovante da taxa não oferece pagar na clínica', () => {
  assert.ok(!/ou pagamento na clínica/i.test(RECUSA_SEM_COMPROVANTE_DA_TAXA));
  assert.ok(!/preferir pagar na clínica/i.test(RECUSA_SEM_COMPROVANTE_DA_TAXA));
  assert.match(RECUSA_SEM_COMPROVANTE_DA_TAXA, /NUNCA ofereça pagar na clínica/);
});

test('agendar_consulta em unidade com taxa obrigatória: não manda perguntar "Pix antecipado ou na clínica"', () => {
  const comTaxa = buildAgendarConsulta({ unit: { spineBookingRequiresPayment: true }, recorder: {}, kommo: {} } as never);
  assert.ok(!comTaxa.description.includes('(Pix antecipado ou na clínica)'));
  assert.match(comTaxa.description, /taxa é OBRIGATÓRIA/);
  const opcional = buildAgendarConsulta({ unit: { spineBookingRequiresPayment: false }, recorder: {}, kommo: {} } as never);
  assert.ok(opcional.description.includes('(Pix antecipado ou na clínica)'));
});
