/**
 * O freio e a conta das chamadas ao Chatwoot (27/11/2026): o trabalho de FUNDO espera a vez (balde de fichas + teto de pedidos ao mesmo tempo),
 * o que tem gente esperando nunca é segurado, e cada origem é contada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { LimitadorDoChatwoot, LIMIAR_DO_AVISO_MS } = await import('./chatwoot-limite.js');

/** Relógio de mentira com timers de verdade (virtuais): `dormir` só acorda quando o relógio chega lá; `passar` deixa tudo assentar e salta ao próximo timer. */
function relogio() {
  let t = 1_000_000;
  const timers: Array<{ em: number; ok: () => void }> = [];
  const assentar = async () => { for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok)); };
  return {
    agora: () => t,
    dormir: (ms: number) => new Promise<void>((ok) => timers.push({ em: t + ms, ok })),
    /** roda até não sobrar timer */
    async correr() {
      for (;;) {
        await assentar();
        if (!timers.length) return;
        timers.sort((a, b) => a.em - b.em);
        const prox = timers.shift()!;
        t = Math.max(t, prox.em);
        prox.ok();
      }
    },
    async avancar(ms: number) { t += ms; },
  };
}
const avisos: Array<Record<string, unknown>> = [];
const resumos: Array<Record<string, unknown>> = [];
const registrar = { aviso: (d: Record<string, unknown>) => void avisos.push(d), resumo: (d: Record<string, unknown>) => void resumos.push(d) };

test('freio: a rajada sai de uma vez e o resto sai no ritmo de `porSegundo` — nunca mais que isso por segundo', async () => {
  const r = relogio();
  const l = new LimitadorDoChatwoot({ porSegundo: 2, rajada: 3, simultaneas: 99, agora: r.agora, dormir: r.dormir, registrar });
  const saidas: number[] = [];
  const todos = Promise.all(Array.from({ length: 9 }, () => l.executar('c1', 'regua', true, async () => void saidas.push(r.agora()))));
  await r.correr();
  await todos;
  const t0 = saidas[0]!;
  assert.equal(saidas.filter((t) => t === t0).length, 3, 'a rajada (3) sai junta');
  const resto = saidas.slice(3).map((t) => t - t0);
  for (let i = 1; i < resto.length; i++) assert.ok(resto[i]! - resto[i - 1]! >= 499, 'um a cada ~500 ms');
  assert.ok(saidas[8]! - t0 >= 3000, '9 pedidos, 3 de rajada + 6 a 2/s = 3 s');
  // em qualquer janela de 1 s cabem no máximo rajada + porSegundo pedidos
  for (const t of saidas) assert.ok(saidas.filter((x) => x >= t && x < t + 1000).length <= 3 + 2);
});

test('freio: no máximo `simultaneas` pedidos de fundo ao mesmo tempo, na ordem de chegada, e a vaga nunca estoura o teto', async () => {
  const r0 = relogio();
  const l = new LimitadorDoChatwoot({ porSegundo: 1000, rajada: 1000, simultaneas: 2, agora: r0.agora, dormir: r0.dormir, registrar });
  let agora = 0;
  let pico = 0;
  const ordem: number[] = [];
  const soltar: Array<() => void> = [];
  const pedidos = Array.from({ length: 6 }, (_, i) =>
    l.executar('c1', 'agenda', true, async () => {
      ordem.push(i);
      agora++;
      pico = Math.max(pico, agora);
      await new Promise<void>((ok) => soltar.push(ok));
      agora--;
    }),
  );
  for (let rodada = 0; rodada < 20; rodada++) {
    await new Promise((ok) => setImmediate(ok));
    while (soltar.length) soltar.shift()!();
  }
  await Promise.all(pedidos);
  assert.equal(pico, 2, 'nunca mais que 2 ao mesmo tempo');
  assert.deepEqual(ordem, [0, 1, 2, 3, 4, 5], 'ordem de chegada');
});

test('freio: pedido com gente esperando (não é `baixa`) NUNCA espera; e `porSegundo: 0` desliga o freio — os dois seguem contados', async () => {
  const r = relogio();
  const l = new LimitadorDoChatwoot({ porSegundo: 1, rajada: 1, simultaneas: 1, agora: r.agora, dormir: r.dormir, registrar });
  const t0 = r.agora();
  await Promise.all(Array.from({ length: 20 }, () => l.executar('c1', 'sessao', false, async () => 1)));
  assert.equal(r.agora(), t0, 'nenhuma espera');
  const livre = new LimitadorDoChatwoot({ porSegundo: 0, rajada: 1, simultaneas: 1, agora: r.agora, dormir: r.dormir, registrar });
  await Promise.all(Array.from({ length: 5 }, () => livre.executar('c1', 'regua', true, async () => 1)));
  assert.equal(r.agora(), t0);
  assert.deepEqual(l.contagem(), { sessao: 20 });
  assert.deepEqual(livre.contagem(), { regua: 5 });
});

test('freio: cada instalação do Chatwoot tem o seu balde; erro de um pedido não trava a fila nem prende a vaga', async () => {
  const r = relogio();
  const l = new LimitadorDoChatwoot({ porSegundo: 1, rajada: 1, simultaneas: 1, agora: r.agora, dormir: r.dormir, registrar });
  await l.executar('a', 'x', true, async () => 1);
  const t = r.agora();
  await l.executar('b', 'x', true, async () => 1); // outra instalação: ficha própria, sem espera
  assert.equal(r.agora(), t);
  const falha = assert.rejects(l.executar('a', 'x', true, async () => { throw new Error('caiu'); }));
  await r.correr();
  await falha;
  const seguinte = l.executar('a', 'x', true, async () => 7);
  await r.correr();
  assert.equal(await seguinte, 7, 'a fila segue depois do erro');
});

test('aviso: quando o freio segura alguém mais que o limiar vai para o log, no máximo um por minuto; o resumo por origem sai a cada 10 min e zera', async () => {
  avisos.length = 0;
  resumos.length = 0;
  const r = relogio();
  const l = new LimitadorDoChatwoot({ porSegundo: 1, rajada: 1, simultaneas: 9, agora: r.agora, dormir: r.dormir, registrar });
  const t0 = r.agora();
  const todos = Promise.all(Array.from({ length: 8 }, () => l.executar('c', 'regua', true, async () => 1)));
  await r.correr();
  await todos;
  assert.ok(r.agora() - t0 >= LIMIAR_DO_AVISO_MS);
  assert.equal(avisos.length, 1, 'um aviso só, não um por pedido');
  assert.equal(avisos[0]!.origem, 'regua');
  await l.executar('c', 'capi', false, async () => 1);
  assert.equal(resumos.length, 0, 'ainda não passaram 10 min');
  await r.avancar(10 * 60_000);
  await l.executar('c', 'funil', false, async () => 1);
  assert.equal(resumos.length, 1);
  assert.deepEqual(resumos[0]!.porOrigem, { regua: 8, capi: 1 }, 'o pedido que fecha a janela já entra na seguinte');
  assert.equal(resumos[0]!.total, 9);
  assert.deepEqual(l.contagem(), { funil: 1 }, 'a contagem recomeçou');
});
