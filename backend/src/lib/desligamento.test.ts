import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from 'node:http';
import { desligarComGraca, fecharServidor, ESPERA_REQUISICOES_MS, planoDeDesligamento, PRAZO_TOTAL_PADRAO_MS, ESPERA_TRAEFIK_PADRAO_MS, TETO_DRENAGEM_PADRAO_MS } from './desligamento.js';

/** Relógio falso: `dormir` avança o tempo; `drenar` consome o que o chamador deixar (até `gasta`). */
function mundo(gastaNaDrenagem = 0) {
  let t = 1_000_000;
  const eventos: string[] = [];
  return {
    eventos,
    deps: {
      agora: () => t,
      dormir: async (ms: number) => { eventos.push(`dormir:${ms}`); t += ms; },
      fecharPorta: async (ms: number) => { eventos.push(`fecharPorta:${ms}`); },
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
  assert.deepEqual(m.eventos, ['dormir:20000', 'fecharPorta:5000', 'drenar:35000']);
});

test('padrões: 20 s de espera + 35 s de drenagem = 55 s, dentro dos 60 s do stop_grace_period', () => {
  const p = planoDeDesligamento({ NODE_ENV: 'production' });
  assert.equal(p.esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(p.tetoDrenagemMs, TETO_DRENAGEM_PADRAO_MS);
  assert.equal(p.prazoTotalMs, PRAZO_TOTAL_PADRAO_MS);
  assert.equal(ESPERA_TRAEFIK_PADRAO_MS + TETO_DRENAGEM_PADRAO_MS, PRAZO_TOTAL_PADRAO_MS);
  assert.ok(PRAZO_TOTAL_PADRAO_MS <= 55_000, 'sobram 5 s dos 60 s para soltar o lease e desconectar');
});

test('variáveis de ambiente mudam o plano; lixo cai no padrão', () => {
  const p = planoDeDesligamento({ NODE_ENV: 'production', SHUTDOWN_ESPERA_TRAEFIK_MS: '5000', SHUTDOWN_AGUARDA_TURNOS_MS: '10000' });
  assert.equal(p.esperaTraefikMs, 5000);
  assert.equal(p.tetoDrenagemMs, 10_000);
  assert.equal(planoDeDesligamento({ NODE_ENV: 'production', SHUTDOWN_ESPERA_TRAEFIK_MS: 'abc' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ NODE_ENV: 'production', SHUTDOWN_ESPERA_TRAEFIK_MS: '-3' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ NODE_ENV: 'production', SHUTDOWN_ESPERA_TRAEFIK_MS: '0' }).esperaTraefikMs, 0, 'zero desliga a espera');
  assert.equal(planoDeDesligamento({ SHUTDOWN_AGUARDA_TURNOS_MS: '0' }).tetoDrenagemMs, TETO_DRENAGEM_PADRAO_MS);
});

test('a espera do Traefik só vale em produção (Ctrl+C em desenvolvimento não trava 20 s)', () => {
  assert.equal(planoDeDesligamento({ NODE_ENV: 'production' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ NODE_ENV: 'development' }).esperaTraefikMs, 0);
  assert.equal(planoDeDesligamento({}).esperaTraefikMs, 0);
  assert.equal(planoDeDesligamento({ NODE_ENV: 'development', SHUTDOWN_ESPERA_TRAEFIK_MS: '7000' }).esperaTraefikMs, 7000);
});

test('a drenagem só começa DEPOIS que a porta terminou de fechar (requisição em voo entra na fila antes)', async () => {
  const ordem: string[] = [];
  await desligarComGraca({ esperaTraefikMs: 0, tetoDrenagemMs: 10, prazoTotalMs: 55_000 }, {
    agora: () => 0,
    dormir: async () => undefined,
    fecharPorta: async () => { await new Promise((r) => setTimeout(r, 30)); ordem.push('porta fechada'); },
    drenar: async () => { ordem.push('drenou'); return { filaRestante: 0, restantes: 0, esperouMs: 0 }; },
  });
  assert.deepEqual(ordem, ['porta fechada', 'drenou']);
});

test('fecharServidor espera a requisição em curso terminar e derruba a conexão ociosa', async () => {
  let respondeu = false;
  const server = createServer((_req, res) => { setTimeout(() => { respondeu = true; res.end('ok'); }, 120); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const porta = (server.address() as { port: number }).port;
  const resp = fetch(`http://127.0.0.1:${porta}/`).then((x) => x.text());
  await new Promise((r) => setTimeout(r, 30)); // a requisição chegou e está pendente
  const t0 = Date.now();
  await fecharServidor(server, 3000);
  assert.equal(respondeu, true, 'esperou a requisição em curso');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await resp, 'ok');
});

test('fecharServidor sai no teto mesmo com requisição que não acaba', async () => {
  const server = createServer(() => { /* nunca responde */ });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const porta = (server.address() as { port: number }).port;
  const ac = new AbortController();
  void fetch(`http://127.0.0.1:${porta}/`, { signal: ac.signal }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  await fecharServidor(server, 150);
  const dt = Date.now() - t0;
  assert.ok(dt >= 140 && dt < 1000, `levou ${dt} ms`);
  ac.abort();
  (server as unknown as { closeAllConnections(): void }).closeAllConnections();
  assert.equal(ESPERA_REQUISICOES_MS, 5000);
});

test('espera zero: não dorme, fecha a porta e drena', async () => {
  const m = mundo();
  await desligarComGraca({ esperaTraefikMs: 0, tetoDrenagemMs: 35_000, prazoTotalMs: 55_000 }, m.deps);
  assert.deepEqual(m.eventos, ['fecharPorta:5000', 'drenar:35000']);
});

test('teto alto demais é recortado: espera + drenagem nunca passam do prazo total contado do SIGTERM', async () => {
  const m = mundo();
  const r = await desligarComGraca({ esperaTraefikMs: 20_000, tetoDrenagemMs: 90_000, prazoTotalMs: 55_000 }, m.deps);
  assert.deepEqual(m.eventos, ['dormir:20000', 'fecharPorta:5000', 'drenar:35000']);
  assert.equal(r.tetoUsadoMs, 35_000);
});

test('espera absurda é recortada ao prazo, e a drenagem fica com 0 (porta fecha e sai)', async () => {
  const m = mundo();
  const r = await desligarComGraca({ esperaTraefikMs: 300_000, tetoDrenagemMs: 35_000, prazoTotalMs: 55_000 }, m.deps);
  assert.deepEqual(m.eventos, ['dormir:55000', 'fecharPorta:0', 'drenar:0']);
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
  assert.equal(planoDeDesligamento({ NODE_ENV: 'production', SHUTDOWN_ESPERA_TRAEFIK_MS: '' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ NODE_ENV: 'production', SHUTDOWN_ESPERA_TRAEFIK_MS: '   ' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ NODE_ENV: 'production', SHUTDOWN_ESPERA_TRAEFIK_MS: 'Infinity' }).esperaTraefikMs, ESPERA_TRAEFIK_PADRAO_MS);
  assert.equal(planoDeDesligamento({ SHUTDOWN_AGUARDA_TURNOS_MS: 'Infinity' }).tetoDrenagemMs, TETO_DRENAGEM_PADRAO_MS);
});
