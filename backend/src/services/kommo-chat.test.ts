import { test } from 'node:test';
import assert from 'node:assert/strict';

import { podeVirarAudio } from './kommo-chat.service.js';

/**
 * Espelho: o paciente mandou áudio, a Sofia responde em áudio — mas só o que dá para
 * OUVIR. Chave Pix, endereço com link, confirmação em bloco e lista de horários ficam
 * em texto, porque o paciente vai reler.
 */

test('resposta curta de conversa vira áudio', () => {
  assert.equal(podeVirarAudio('Oi, Maria! Entendi, dor na lombar há dois anos. Ela desce pra perna também?').ok, true);
});

test('link, e-mail e CNPJ nunca viram áudio', () => {
  assert.equal(podeVirarAudio('Nosso endereço no mapa: https://maps.app.goo.gl/abc').ok, false);
  assert.equal(podeVirarAudio('Chave Pix: financeiro@clinica.com.br').ok, false);
  assert.equal(podeVirarAudio('Chave Pix: 45.704.980/0001-41 (Attiva)').ok, false);
});

test('telefone ou chave numérica longa fica em texto', () => {
  assert.equal(podeVirarAudio('Liga pra recepção: (63) 99102-1043').ok, false);
});

test('confirmação em bloco e lista de horários ficam em texto', () => {
  assert.equal(podeVirarAudio('✅ Agendamento confirmado, João!\n⭐ Data: segunda, 14/09\n⏰ Horário: 08:00').ok, false);
  assert.equal(podeVirarAudio('Tenho estes horários:\n- 09:00\n- 10:30\n- 14:00\nQual prefere?').ok, false);
});

test('texto longo fica em texto (limite do TTS)', () => {
  assert.equal(podeVirarAudio('palavra '.repeat(200)).ok, false);
});

test('devolve o motivo quando recusa', () => {
  assert.match(podeVirarAudio('veja www.doutorhernia.com.br').motivo ?? '', /link/);
});
