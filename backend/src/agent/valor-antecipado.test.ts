import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corrigirValorAntecipado } from './valor-antecipado.js';

/** Serra: particular 350 no dia / 280 antecipado. Plano 250 no dia / 220 antecipado. */
const SERRA = { antecipado: 280 };

test('o caso do gestor da Serra, 26/09 — R$ 250 anunciado como antecipado', () => {
  const r = corrigirValorAntecipado('A consulta é R$ 250 antecipado, ou R$ 350 no dia.', SERRA);
  assert.equal(r.texto, 'A consulta é R$ 280 antecipado, ou R$ 350 no dia.');
  assert.deepEqual(r.corrigiu, [250]);
});

test('pega as variações de escrita que a IA usa de verdade', () => {
  // Estas quatro frases estavam literalmente na ficha da Serra com o valor errado.
  const casos: Array<[string, string]> = [
    [
      'Fica R$ 350 se pagar no dia, ou R$ 250 se pagar antes por PIX.',
      'Fica R$ 350 se pagar no dia, ou R$ 280 se pagar antes por PIX.',
    ],
    [
      'R$ 350 no dia da avaliação, ou R$ 250 pagando antes por PIX',
      'R$ 350 no dia da avaliação, ou R$ 280 pagando antes por PIX',
    ],
    [
      'A consulta em si é R$ 350 no dia, ou R$ 250 se pagar antes por PIX.',
      'A consulta em si é R$ 350 no dia, ou R$ 280 se pagar antes por PIX.',
    ],
    [
      'Por Pix com pelo menos 24 horas de antecedência fica R$ 250.',
      'Por Pix com pelo menos 24 horas de antecedência fica R$ 250.', // o R$ vem DEPOIS da marca: não é o slot
    ],
  ];
  for (const [antes, depois] of casos) {
    assert.equal(corrigirValorAntecipado(antes, SERRA).texto, depois, antes);
  }
});

test('NÃO casa com o valor do dia, mesmo ele vindo antes na frase', () => {
  // Sem a trava do "nenhum R$ no meio", o 350 seria capturado como antecipado.
  const r = corrigirValorAntecipado('R$ 350 no dia, ou R$ 280 com pagamento antecipado.', SERRA);
  assert.deepEqual(r.corrigiu, []);
  assert.equal(r.texto, 'R$ 350 no dia, ou R$ 280 com pagamento antecipado.');
});

test('valor certo passa intacto', () => {
  for (const t of [
    'A consulta é R$ 280 antecipado por Pix, ou R$ 350 no dia.',
    'São R$ 280 pagando antes, garantindo seu horário.',
  ]) {
    const r = corrigirValorAntecipado(t, SERRA);
    assert.equal(r.texto, t);
    assert.deepEqual(r.corrigiu, []);
  }
});

test('MENSAGEM QUE FALA DE PLANO SAI INTEIRA — foi isto que já subiu preço de quem tem plano', () => {
  for (const t of [
    'Com plano de saúde fica R$ 250 no dia, ou R$ 220 pagando antes.',
    'Você tem plano de saúde? Se tiver, o antecipado fica R$ 220.',
    'A clínica não é credenciada a convênio. Antecipado R$ 220 para quem tem plano.',
    'Pode trazer a carteirinha. O antecipado nesse caso é R$ 220.',
  ]) {
    assert.equal(corrigirValorAntecipado(t, SERRA).texto, t, t);
  }
});

test('unidade com taxa de reserva sai inteira — lá o antecipado é PARTE do valor', () => {
  // Boa Vista: "R$ 100 antecipado + R$ 250 no dia" está certo.
  const t = 'São R$ 100 antecipado para garantir a vaga, e R$ 250 no dia.';
  const r = corrigirValorAntecipado(t, { antecipado: 100, taxaDeReserva: true });
  assert.equal(r.texto, t);
  // E mesmo com o antecipado divergente, a trava não opina nessas unidades.
  assert.equal(corrigirValorAntecipado(t, { antecipado: 280, taxaDeReserva: true }).texto, t);
});

test('parcelamento não é o valor da consulta', () => {
  const t = 'Dá pra dividir em 3x de R$ 100 antecipado.';
  assert.equal(corrigirValorAntecipado(t, SERRA).texto, t);
});

test('entrada vazia e antecipado inválido não quebram', () => {
  assert.equal(corrigirValorAntecipado('', SERRA).texto, '');
  assert.equal(corrigirValorAntecipado('R$ 250 antecipado', { antecipado: 0 }).texto, 'R$ 250 antecipado');
  assert.equal(
    corrigirValorAntecipado('R$ 250 antecipado', { antecipado: Number.NaN }).texto,
    'R$ 250 antecipado',
  );
});
