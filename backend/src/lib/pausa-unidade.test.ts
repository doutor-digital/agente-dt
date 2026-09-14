import test from 'node:test';
import assert from 'node:assert/strict';
import { descreverPausa, emPausa, gerarCodigoPausa, pausaAgendada, validarPedidoDePausa } from './pausa-unidade.js';

const agora = new Date('2026-09-14T13:00:00Z'); // 10:00 em Brasília
const h = (n: number) => new Date(agora.getTime() + n * 3600_000);

test('emPausa: dentro da janela pausa; depois do fim volta sozinha; antes do início ainda não', () => {
  assert.equal(emPausa({ pausaDesde: null, pausaAte: h(8) }, agora), true);
  assert.equal(emPausa({ pausaDesde: null, pausaAte: h(-1) }, agora), false);
  assert.equal(emPausa({ pausaDesde: h(2), pausaAte: h(8) }, agora), false);
  assert.equal(emPausa({ pausaDesde: h(-2), pausaAte: h(8) }, agora), true);
  assert.equal(emPausa({ pausaDesde: null, pausaAte: null }, agora), false);
  assert.equal(pausaAgendada({ pausaDesde: h(2), pausaAte: h(8) }, agora), true);
});

test('descreverPausa: hora local legível', () => {
  assert.equal(descreverPausa({ pausaDesde: null, pausaAte: null }), 'IA ativa');
  assert.match(descreverPausa({ pausaDesde: null, pausaAte: h(8), pausaPor: 'Néia', pausaMotivo: 'reunião' }), /IA pausada até 14\/09,? 18:00 por Néia \(reunião\)/);
  assert.match(descreverPausa({ pausaDesde: h(-2), pausaAte: h(8) }), /de 14\/09,? 08:00 até 14\/09,? 18:00/);
});

test('validarPedidoDePausa: passado, mais de 7 dias e início depois do fim são recusados', () => {
  assert.equal(validarPedidoDePausa({ ate: h(8) }, agora), null);
  assert.match(validarPedidoDePausa({ ate: h(-1) }, agora)!, /futuro/);
  assert.match(validarPedidoDePausa({ ate: h(24 * 8) }, agora)!, /7 dias/);
  assert.match(validarPedidoDePausa({ ate: h(2), desde: h(3) }, agora)!, /antes do término/);
});

test('gerarCodigoPausa: 6 dígitos', () => {
  for (let i = 0; i < 20; i++) assert.match(gerarCodigoPausa(), /^\d{6}$/);
});
