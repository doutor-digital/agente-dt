// A impressão da EXTENSÃO tem de bater com os vetores fixos (calculados fora, em Python). O servidor confere
// os mesmos vetores em backend/src/lib/ponte-impressao.test.ts — os três juntos garantem que os hashes casam.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const I = require('../impressao.js');
const { vetores } = require('./vetores-impressao.json');

describe('impressão (extensão)', () => {
  it('normaliza igual aos vetores: minúsculas, sem acento, só letras e números', () => {
    for (const v of vetores) assert.equal(I.normalizar(v.texto), v.normalizado, JSON.stringify(v.texto));
  });

  it('o hash é o dos vetores — e null para texto vazio ou minuto inválido', async () => {
    for (const v of vetores) assert.equal(await I.impressao(v.texto, v.minuto), v.impressao, `${JSON.stringify(v.texto)} ${v.minuto}`);
  });

  it('converte a hora do relógio da atendente para São Paulo', () => {
    const agora = new Date('2026-10-13T13:00:00Z'); // 10:00 em São Paulo
    assert.equal(I.minutoDeSaoPaulo('10:00', agora, -180), '10:00'); // computador em São Paulo
    assert.equal(I.minutoDeSaoPaulo('09:00', agora, -240), '10:00'); // computador em Boa Vista/Manaus
    assert.equal(I.minutoDeSaoPaulo('13:00', agora, 0), '10:00'); // computador em UTC
    assert.equal(I.minutoDeSaoPaulo('01:30', agora, 0), '22:30'); // volta o dia
    assert.equal(I.minutoDeSaoPaulo('23:30', agora, -240), '00:30'); // passa o dia
    assert.equal(I.minutoDeSaoPaulo('9:05', agora, -180), '09:05');
  });

  it('hora que não é hora não vira minuto', () => {
    const agora = new Date('2026-10-13T13:00:00Z');
    assert.equal(I.minutoDeSaoPaulo('25:00', agora, -180), null);
    assert.equal(I.minutoDeSaoPaulo('10:61', agora, -180), null);
    assert.equal(I.minutoDeSaoPaulo('', agora, -180), null);
    assert.equal(I.minutoDeSaoPaulo(null, agora, -180), null);
  });
});
