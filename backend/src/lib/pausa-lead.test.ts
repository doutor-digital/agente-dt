import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAUSA_LEAD_MAX_DIAS, pausaDoLeadAtiva, validarPausaDoLead } from './pausa-lead-regras.js';

const agora = new Date('2026-10-02T15:00:00Z');
const emHoras = (h: number) => new Date(agora.getTime() + h * 3_600_000);

test('pausa do lead: vale até a data e para de valer na hora exata', () => {
  assert.equal(pausaDoLeadAtiva({ ate: emHoras(2) }, agora), true);
  assert.equal(pausaDoLeadAtiva({ ate: agora }, agora), false, 'no instante do fim já não vale');
  assert.equal(pausaDoLeadAtiva({ ate: emHoras(-1) }, agora), false);
  assert.equal(pausaDoLeadAtiva(null, agora), false);
  assert.equal(pausaDoLeadAtiva(undefined, agora), false);
});

test('validar pausa do lead: só no futuro e até o limite de dias', () => {
  assert.equal(validarPausaDoLead(emHoras(1), agora), null);
  assert.match(validarPausaDoLead(emHoras(-1), agora) ?? '', /futuro/);
  assert.match(validarPausaDoLead(agora, agora) ?? '', /futuro/, 'agora não é futuro');
  assert.match(validarPausaDoLead(new Date('lixo'), agora) ?? '', /inválida/);
  assert.equal(validarPausaDoLead(emHoras(PAUSA_LEAD_MAX_DIAS * 24), agora), null, 'o limite exato passa');
  assert.match(validarPausaDoLead(emHoras(PAUSA_LEAD_MAX_DIAS * 24 + 1), agora) ?? '', new RegExp(String(PAUSA_LEAD_MAX_DIAS)));
});
