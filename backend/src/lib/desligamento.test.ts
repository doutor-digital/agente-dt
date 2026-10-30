import { test } from 'node:test';
import assert from 'node:assert/strict';

import { desligarComGraca, planoDeDesligamento, PRAZO_TOTAL_PADRAO_MS, ESPERA_TRAEFIK_PADRAO_MS, TETO_DRENAGEM_PADRAO_MS } from './desligamento.js';

/** Relógio falso: `dormir` avança o tempo; `drenar` consome o que o chamador deixar (até `gasta`). */
function mundo(gastaNaDrenagem = 0) {
  let t = 1_000_000;
  const eventos: string[] = [];
  return {
    eventos,
    deps: {
      agora: () => t,
      dormir: async (ms: number) => { eventos.push(`dormir:${ms}`); t += ms; },
      fecharPorta: () => { eventos.push('fecharPorta'); },
      drenar: async (maxMs: number) => {
        eventos.push(`drenar:${maxMs}`);
        t += Math.min(gastaNaDrenagem, maxMs);
        return { filaRestante: 0, restantes: 0, esperouMs: Math.min(gastaNaDrenagem, maxMs) };
      },
    },
  };
}

test('ordem: espera o Traefik, SÓ DEPOIS fecha a porta, depois drena', async () => {
  const m = mundo();
  await desligarComGraca({ esperaTraefikMs: 20_000, tetoDrenagemMs: 35_000, prazoTotalMs: 55_000 }, m.deps);
  assert.deepEqual(m.eventos, ['dormir:20000', 'fecharPorta', 'drenar:35000']);
});

test('padrões: 20 s de espera + 35 s de drenagem = 55 s, dentro dos 60 s do stop_grace_period', () => {
  const p = planoDeDesligamento({});
  assert.equal(p.esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(p.tetoDrenagemMs, TETO_DRENAGEM_PADRAO_MS);
  assert.equal(p.prazoTotalMs, PRAZO_TOTAL_PADRAO_MS);
  assert.equal(ESPERA_TRAEFIK_PADRAO_MS + TETO_DRENAGEM_PADRAO_MS, PRAZO_TOTAL_PADRAO_MS);
  assert.ok(PRAZO_TOTAL_PADRAO_MS <= 55_000, 'sobram 5 s dos 60 s para soltar o lease e desconectar');
});

test('variáveis de ambiente mudam o plano; lixo cai no padrão', () => {
  const p = planoDeDesligamento({ SHUTDOWN_ESPERA_TRAEFIK_MS: '5000', SHUTDOWN_AGUARDA_TURNOS_MS: '10000' });
  assert.equal(p.esperaTraefikMs, 5000);
  assert.equal(p.tetoDrenagemMs, 10_000);
  assert.equal(planoDeDesligamento({ SHUTDOWN_ESPERA_TRAEFIK_MS: 'abc' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ SHUTDOWN_ESPERA_TRAEFIK_MS: '-3' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ SHUTDOWN_ESPERA_TRAEFIK_MS: '0' }).esperaTraefikMs, 0, 'zero desliga a espera');
  assert.equal(planoDeDesligamento({ SHUTDOWN_AGUARDA_TURNOS_MS: '0' }).tetoDrenagemMs, TETO_DRENAGEM_PADRAO_MS);
});

test('espera zero: não dorme, fecha a porta e drena', async () => {
  const m = mundo();
  await desligarComGraca({ esperaTraefikMs: 0, tetoDrenagemMs: 35_000, prazoTotalMs: 55_000 }, m.deps);
  assert.deepEqual(m.eventos, ['fecharPorta', 'drenar:35000']);
});

test('teto alto demais é recortado: espera + drenagem nunca passam do prazo total contado do SIGTERM', async () => {
  const m = mundo();
  const r = await desligarComGraca({ esperaTraefikMs: 20_000, tetoDrenagemMs: 90_000, prazoTotalMs: 55_000 }, m.deps);
  assert.deepEqual(m.eventos, ['dormir:20000', 'fecharPorta', 'drenar:35000']);
  assert.equal(r.tetoUsadoMs, 35_000);
});

test('espera absurda é recortada ao prazo, e a drenagem fica com 0 (porta fecha e sai)', async () => {
  const m = mundo();
  const r = await desligarComGraca({ esperaTraefikMs: 300_000, tetoDrenagemMs: 35_000, prazoTotalMs: 55_000 }, m.deps);
  assert.deepEqual(m.eventos, ['dormir:55000', 'fecharPorta', 'drenar:0']);
  assert.equal(r.esperouTraefikMs, 55_000);
});

test('devolve o que sobrou na fila e nos turnos', async () => {
  const m = mundo();
  m.deps.drenar = async () => ({ filaRestante: 2, restantes: 1, esperouMs: 5 });
  const r = await desligarComGraca({ esperaTraefikMs: 0, tetoDrenagemMs: 10, prazoTotalMs: 55_000 }, m.deps);
  assert.equal(r.filaRestante, 2);
  assert.equal(r.restantes, 1);
});

test('se dormir estoura o prazo, a drenagem recebe 0 (nunca negativo)', async () => {
  const m = mundo();
  const dormirOriginal = m.deps.dormir;
  m.deps.dormir = async (ms: number) => { await dormirOriginal(ms + 50_000); };
  await desligarComGraca({ esperaTraefikMs: 20_000, tetoDrenagemMs: 35_000, prazoTotalMs: 55_000 }, m.deps);
  assert.ok(m.eventos.includes('drenar:0'), m.eventos.join(','));
});

test('variável vazia, só espaços ou Infinity cai no padrão', () => {
  assert.equal(planoDeDesligamento({ SHUTDOWN_ESPERA_TRAEFIK_MS: '' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ SHUTDOWN_ESPERA_TRAEFIK_MS: '   ' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ SHUTDOWN_ESPERA_TRAEFIK_MS: 'Infinity' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ SHUTDOWN_AGUARDA_TURNOS_MS: 'Infinity' }).tetoDrenagemMs, TETO_DRENAGEM_PADRAO_MS);
});
