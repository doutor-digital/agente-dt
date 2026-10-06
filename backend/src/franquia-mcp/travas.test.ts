import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diasNoPeriodo, ErroDeEntrada, fatiarPeriodo, MAX_DIAS_FATIA, somarDias, validarData, validarTexto } from './travas.js';

test('validarData aceita AAAA-MM-DD que existe', () => {
  assert.equal(validarData('2026-10-06', 'x'), '2026-10-06');
  assert.equal(validarData('2028-02-29', 'x'), '2028-02-29'); // bissexto
});

test('validarData recusa formato errado e dia que não existe', () => {
  for (const ruim of ['06/10/2026', '2026-10-6', '2026-10-06T00:00:00', '', '2026-02-30', '2026-13-01', '2027-02-29']) {
    assert.throws(() => validarData(ruim, 'inicio'), ErroDeEntrada, ruim);
  }
});

test('diasNoPeriodo conta os dois extremos', () => {
  assert.equal(diasNoPeriodo('2026-01-01', '2026-01-01'), 1);
  assert.equal(diasNoPeriodo('2026-01-01', '2026-04-10'), 100);
});

test('fatiarPeriodo: período curto vira uma fatia só', () => {
  assert.deepEqual(fatiarPeriodo('2026-09-01', '2026-09-30'), [{ inicio: '2026-09-01', fim: '2026-09-30' }]);
  assert.deepEqual(fatiarPeriodo('2026-09-01', '2026-09-01'), [{ inicio: '2026-09-01', fim: '2026-09-01' }]);
});

test('fatiarPeriodo: exatamente 90 dias é 1 fatia; 91 são 2', () => {
  assert.equal(fatiarPeriodo('2026-01-01', somarDias('2026-01-01', 89)).length, 1);
  assert.deepEqual(fatiarPeriodo('2026-01-01', somarDias('2026-01-01', 90)), [
    { inicio: '2026-01-01', fim: '2026-03-31' },
    { inicio: '2026-04-01', fim: '2026-04-01' },
  ]);
});

test('fatiarPeriodo: fatias contíguas, sem buraco nem dia repetido, cobrindo o período todo', () => {
  // vários tamanhos, atravessando virada de ano e fevereiro bissexto
  for (const [ini, fim] of [
    ['2025-11-15', '2026-11-14'],
    ['2027-12-01', '2028-03-15'],
    ['2026-01-01', '2026-12-31'],
    ['2024-02-28', '2024-03-01'],
  ] as const) {
    const fatias = fatiarPeriodo(ini, fim);
    assert.equal(fatias[0]?.inicio, ini);
    assert.equal(fatias.at(-1)?.fim, fim);
    let dias = 0;
    for (const [i, f] of fatias.entries()) {
      const n = diasNoPeriodo(f.inicio, f.fim);
      assert.ok(n >= 1 && n <= MAX_DIAS_FATIA, `fatia ${i} com ${n} dias`);
      if (i > 0) assert.equal(f.inicio, somarDias(fatias[i - 1]!.fim, 1), 'buraco ou sobreposição');
      dias += n;
    }
    assert.equal(dias, diasNoPeriodo(ini, fim), 'a soma das fatias tem que ser o período');
  }
});

test('fatiarPeriodo recusa início depois do fim', () => {
  assert.throws(() => fatiarPeriodo('2026-10-02', '2026-10-01'), ErroDeEntrada);
});

test('validarTexto: mínimo 2 letras; vazio é "sem filtro"', () => {
  assert.equal(validarTexto(undefined, 'nome'), undefined);
  assert.equal(validarTexto('   ', 'nome'), undefined);
  assert.equal(validarTexto('  Jo ', 'nome'), 'Jo');
  assert.throws(() => validarTexto(' J ', 'nome'), ErroDeEntrada);
});
