import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interpretarHorarioEscolhido } from './agenda-tools.js';

const AGORA = new Date(2026, 7, 29, 14, 0, 0); // 29/08/2026 14:00

test('horário concreto e futuro passa', () => {
  const r = interpretarHorarioEscolhido('2026-09-01 10:00', AGORA);
  assert.equal(r.ok, true);
});

test('aceita o formato com T (o modelo às vezes manda ISO)', () => {
  const r = interpretarHorarioEscolhido('2026-09-01T10:00', AGORA);
  assert.equal(r.ok, true);
});

test('sem horário nenhum recusa — é o caso dos 6 pacientes fantasma', () => {
  const r = interpretarHorarioEscolhido(undefined, AGORA);
  assert.equal(r.ok, false);
});

test('vago não cola: "amanhã de manhã" não é horário escolhido', () => {
  for (const vago of ['amanhã de manhã', 'semana que vem', 'a combinar', 'sim']) {
    const r = interpretarHorarioEscolhido(vago, AGORA);
    assert.equal(r.ok, false, `"${vago}" deveria ser recusado`);
  }
});

test('horário no passado recusa', () => {
  const r = interpretarHorarioEscolhido('2026-08-20 09:00', AGORA);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /passou/.test(r.motivo));
});

test('cinco minutos de folga pro relógio do modelo', () => {
  const r = interpretarHorarioEscolhido('2026-08-29 13:58', AGORA);
  assert.equal(r.ok, true);
});

test('data impossível recusa (o Date do JS transborda calado)', () => {
  // 2026-13-45 99:99 vira fevereiro de 2027 se ninguém conferir, e passaria
  // como horário futuro válido.
  for (const lixo of ['2026-13-45 99:99', '2026-02-30 10:00', '2026-00-10 10:00']) {
    const r = interpretarHorarioEscolhido(lixo, AGORA);
    assert.equal(r.ok, false, `"${lixo}" deveria ser recusado`);
  }
});
