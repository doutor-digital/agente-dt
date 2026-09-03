import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dataBRNoFuso, fusoDaUnidade, fusoValido, FUSO_PADRAO } from './fuso.js';

/**
 * Boa Vista é a única unidade em UTC−4. Até 03/09/2026 a data de entrada do lead
 * e o título do cartão eram formatados em São Paulo para todas — um lead que
 * chegava às 23h30 em Boa Vista ganhava a tag do dia seguinte.
 */

test('prefere o fuso do horário comercial', () => {
  assert.equal(
    fusoDaUnidade({ businessHoursTimezone: 'America/Boa_Vista', spineTimezone: 'America/Sao_Paulo' }),
    'America/Boa_Vista',
  );
});

test('cai no fuso da agenda quando o do horário comercial está vazio ou inválido', () => {
  assert.equal(fusoDaUnidade({ businessHoursTimezone: '', spineTimezone: 'America/Manaus' }), 'America/Manaus');
  assert.equal(fusoDaUnidade({ businessHoursTimezone: 'America/Sao Paulo', spineTimezone: 'America/Manaus' }), 'America/Manaus');
});

test('sem nada válido, Brasília — nunca lança', () => {
  assert.equal(fusoDaUnidade(null), FUSO_PADRAO);
  assert.equal(fusoDaUnidade({ businessHoursTimezone: 'Marte/Olympus', spineTimezone: '' }), FUSO_PADRAO);
});

test('fuso com espaço (o erro clássico de digitação) é inválido', () => {
  assert.equal(fusoValido('America/Sao Paulo'), false);
  assert.equal(fusoValido('America/Boa_Vista'), true);
});

test('a data muda de dia conforme o fuso — o motivo de tudo isso', () => {
  // 2026-09-03 03:30 UTC = 00:30 em Brasília (dia 3) e 23:30 em Boa Vista (dia 2)
  const ms = Date.UTC(2026, 8, 3, 3, 30);
  assert.equal(dataBRNoFuso(ms, 'America/Sao_Paulo'), '03/09/2026');
  assert.equal(dataBRNoFuso(ms, 'America/Boa_Vista'), '02/09/2026');
});
