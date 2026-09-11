import test from 'node:test';
import assert from 'node:assert/strict';
import { classificarRespostaD1, textoConfirmacaoD1 } from './confirmacao-d1.js';

test('classificarRespostaD1: "1", ok, sim e confirmações contam como confirmou', () => {
  for (const t of ['1', '1.', ' 1 ', 'ok', 'Ok!', 'sim', 'Sim, estarei lá', 'confirmo', 'Confirmado', '👍', 'pode confirmar']) {
    assert.equal(classificarRespostaD1(t), 'confirmou', t);
  }
});

test('classificarRespostaD1: "2", não, remarcar e imprevisto pedem remarcação', () => {
  for (const t of ['2', '2 por favor', 'não vou conseguir', 'preciso remarcar', 'Vou ter que cancelar', 'surgiu um imprevisto', 'pode ser outro dia?']) {
    assert.equal(classificarRespostaD1(t), 'remarcar', t);
  }
});

test('classificarRespostaD1: texto fora do padrão vai para a IA', () => {
  for (const t of ['', 'quanto custa?', 'qual o endereço mesmo?', 'oi', 'o 1 é confirmar? e se eu não puder?']) {
    assert.equal(classificarRespostaD1(t), t === 'o 1 é confirmar? e se eu não puder?' ? 'remarcar' : null, t);
  }
});

test('classificarRespostaD1: "1" com dúvida de não poder ir vira remarcar (prioriza o não)', () => {
  assert.equal(classificarRespostaD1('1 mas talvez não consiga'), 'remarcar');
});

test('textoConfirmacaoD1: traz nome, dia da semana, data, hora, especialista, endereço e as opções 1/2', () => {
  const t = textoConfirmacaoD1({
    nome: 'Maria das Graças Silva',
    quando: '2026-09-15 14:30',
    especialista: 'DRA. ANA',
    endereco: 'Rua das Flores, 100',
  });
  assert.match(t, /Oi, Maria!/);
  assert.match(t, /terça, 15\/09 às 14:30 com DRA\. ANA/);
  assert.match(t, /📍 Rua das Flores, 100/);
  assert.match(t, /\*1\* para confirmar/);
  assert.match(t, /\*2\* se precisar remarcar/);
});

test('textoConfirmacaoD1: sem nome, especialista ou endereço não deixa buraco', () => {
  const t = textoConfirmacaoD1({ nome: null, quando: '2026-09-12T09:00:00', especialista: null, endereco: null });
  assert.match(t, /^Oi! Passando/);
  assert.doesNotMatch(t, /com\s*\./);
  assert.doesNotMatch(t, /📍/);
  assert.match(t, /12\/09 às 09:00/);
});
