import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pioroDemais } from './taxa-erro-worker.js';

/**
 * O único alarme técnico que existia era o de saldo esgotado. Erro de verdade
 * era gravado e ninguém comparava com o normal — foi assim que tudo que
 * apareceu hoje passou meses invisível.
 *
 * A parte difícil de um alarme desses não é disparar: é NÃO disparar à toa.
 * Alarme que toca sem motivo é alarme que ninguém olha mais, e aí ele fica pior
 * que não existir. Por isso a maior parte dos casos aqui é sobre silêncio.
 */

const amostra = (o: Partial<Parameters<typeof pioroDemais>[0]>) =>
  pioroDemais({
    slug: 'doutor-hernia-porto',
    unitId: 'u1',
    recentesTotal: 0,
    recentesErro: 0,
    baseTotal: 0,
    baseErro: 0,
    ...o,
  } as Parameters<typeof pioroDemais>[0]);

// ── quando DEVE alarmar ─────────────────────────────────────────────────────

test('um quarto das chamadas falhando alarma sozinho, sem comparar com nada', () => {
  const r = amostra({ recentesTotal: 40, recentesErro: 12, baseTotal: 500, baseErro: 100 });
  assert.equal(r.alarme, true);
  assert.match(r.motivo, /30% das chamadas falhando/);
});

test('sair de zero para um patamar alto alarma', () => {
  const r = amostra({ recentesTotal: 50, recentesErro: 6, baseTotal: 900, baseErro: 0 });
  assert.equal(r.alarme, true);
  assert.match(r.motivo, /saiu de zero/);
});

test('triplicar em relação ao normal da unidade alarma', () => {
  // normal 4%, agora 12%
  const r = amostra({ recentesTotal: 100, recentesErro: 12, baseTotal: 1000, baseErro: 40 });
  assert.equal(r.alarme, true);
  assert.match(r.motivo, /12% agora contra 4% do normal/);
});

// ── quando NÃO pode alarmar ─────────────────────────────────────────────────

test('unidade parada com duas chamadas não vira incêndio', () => {
  // 1 de 2 é 50%, mas não há amostra pra concluir nada.
  const r = amostra({ recentesTotal: 2, recentesErro: 1, baseTotal: 300, baseErro: 3 });
  assert.equal(r.alarme, false);
  assert.match(r.motivo, /amostra pequena/);
});

test('triplicar de um número minúsculo continua sendo ruído', () => {
  // normal 0,2%, agora 0,6% — é o triplo, e não interessa a ninguém.
  const r = amostra({ recentesTotal: 500, recentesErro: 3, baseTotal: 5000, baseErro: 10 });
  assert.equal(r.alarme, false);
  assert.match(r.motivo, /baixa em termos absolutos/);
});

test('unidade que sempre erra um pouco não alarma por continuar igual', () => {
  const r = amostra({ recentesTotal: 200, recentesErro: 20, baseTotal: 2000, baseErro: 190 });
  assert.equal(r.alarme, false);
  assert.match(r.motivo, /dentro do normal/);
});

test('zero erro nunca alarma', () => {
  assert.equal(amostra({ recentesTotal: 300, recentesErro: 0, baseTotal: 3000, baseErro: 60 }).alarme, false);
});

test('unidade sem tráfego nenhum não alarma nem quebra', () => {
  const r = amostra({});
  assert.equal(r.alarme, false);
  assert.equal(r.taxa, 0);
});

test('o motivo é frase de gente, não número solto', () => {
  const r = amostra({ recentesTotal: 40, recentesErro: 12, baseTotal: 500, baseErro: 100 });
  assert.ok(r.motivo.length > 12, 'quem for acordado às 3h precisa entender sem abrir o código');
});
