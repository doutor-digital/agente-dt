import { test } from 'node:test';
import assert from 'node:assert/strict';

import { descricaoDoLead } from './spine-sync.service.js';

/**
 * A Origem do lead espelhado é o canal de marketing; quem o criou (a Sofia) vai
 * na Descrição. Decisão do João em 05/09/2026, quando a franquia criou a origem
 * "IA SOFIA": "o lead continua com origem de marketing; a Sofia entra no paciente".
 */

test('sem queixa, diz só que foi a Sofia', () => {
  assert.equal(descricaoDoLead(null), 'Atendimento pela Sofia (IA Doutor Digital) via WhatsApp.');
  assert.equal(descricaoDoLead('   '), 'Atendimento pela Sofia (IA Doutor Digital) via WhatsApp.');
});

test('com queixa, junta as duas coisas', () => {
  assert.equal(
    descricaoDoLead(' dor lombar há 2 anos, irradia pra perna '),
    'Atendimento pela Sofia (IA Doutor Digital) via WhatsApp. Queixa: dor lombar há 2 anos, irradia pra perna',
  );
});

test('respeita o limite de 1000 caracteres do campo', () => {
  const d = descricaoDoLead('x'.repeat(2000));
  assert.equal(d.length, 1000);
  assert.ok(d.startsWith('Atendimento pela Sofia'));
});
