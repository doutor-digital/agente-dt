import test from 'node:test';
import assert from 'node:assert/strict';
import { claimMessageId, clearDedupCache, deveLimpar, podarMemoria, TTL_REENTREGA_KOMMO_MS } from './dedup-cache.js';

// ── defesa 3: o dedupe do Kommo cobre os reenvios (5 + 15 + 15 + 60 min) ─────────────────────

test('TTL do Kommo cobre o último reenvio (95 min depois da primeira tentativa)', () => {
  assert.ok(TTL_REENTREGA_KOMMO_MS >= (5 + 15 + 15 + 60) * 60_000);
  assert.ok(TTL_REENTREGA_KOMMO_MS <= 3 * 3600_000, 'prazo longo demais engoliria mensagem legítima sem id');
});

test('claimMessageId: com o prazo do Kommo, a reentrega de 20 min ainda é reconhecida', async (t) => {
  clearDedupCache();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T13:43:50Z') });
  // Sem banco no teste: claimMessageId cai no ramo "banco indisponível" e vale a memória.
  assert.equal(await claimMessageId('kommo', 'msg-1', TTL_REENTREGA_KOMMO_MS), true);
  t.mock.timers.tick(20 * 60_000);
  assert.equal(await claimMessageId('kommo', 'msg-1', TTL_REENTREGA_KOMMO_MS), false);
  t.mock.timers.tick(75 * 60_000); // 95 min: o último reenvio do Kommo
  assert.equal(await claimMessageId('kommo', 'msg-1', TTL_REENTREGA_KOMMO_MS), false);
  clearDedupCache();
});

test('claimMessageId: sem prazo explícito continua 10 min (os outros canais não mudam)', async (t) => {
  clearDedupCache();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T13:43:50Z') });
  assert.equal(await claimMessageId('meta', 'm-1'), true);
  t.mock.timers.tick(5 * 60_000);
  assert.equal(await claimMessageId('meta', 'm-1'), false);
  t.mock.timers.tick(6 * 60_000);
  assert.equal(await claimMessageId('meta', 'm-1'), true);
  clearDedupCache();
});

test('podarMemoria: tira o vencido e, cheia de chaves válidas, corta as mais antigas pela metade', () => {
  const m = new Map<string, number>();
  for (let i = 0; i < 10; i++) m.set(`k${i}`, i < 2 ? 50 : 1_000);
  podarMemoria(m, 100, 100);
  assert.equal(m.size, 8);
  assert.ok(!m.has('k0') && !m.has('k1'));

  const cheia = new Map<string, number>();
  for (let i = 0; i < 10; i++) cheia.set(`k${i}`, 1_000);
  podarMemoria(cheia, 100, 10);
  assert.equal(cheia.size, 5);
  assert.ok(cheia.has('k9') && !cheia.has('k0'), 'ficam as mais novas');
});

test('deveLimpar: limpeza do banco no máximo a cada 10 min', () => {
  assert.equal(deveLimpar(0, 0), false);
  assert.equal(deveLimpar(9 * 60_000, 0), false);
  assert.equal(deveLimpar(10 * 60_000, 0), true);
});
