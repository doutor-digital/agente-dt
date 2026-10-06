import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache, Contador, emParalelo, Orcamento, OrcamentoEsgotado, Ritmo } from './ritmo.js';

/** Relógio de mentira: `dormir` só avança o tempo, e registra quanto esperou. */
function relogio() {
  let agora = 1_000_000;
  const esperas: number[] = [];
  return {
    agora: () => agora,
    dormir: async (ms: number) => {
      esperas.push(ms);
      agora += ms;
    },
    avancar: (ms: number) => (agora += ms),
    esperas,
  };
}

test('Ritmo: mesmo token, uma requisição por vez e com intervalo mínimo', async () => {
  const r = relogio();
  const ritmo = new Ritmo(1000, r.dormir, r.agora);
  const inicios: number[] = [];
  let rodando = 0;
  let maxSimultaneas = 0;
  const tarefa = async () => {
    rodando++;
    maxSimultaneas = Math.max(maxSimultaneas, rodando);
    inicios.push(r.agora());
    await Promise.resolve();
    rodando--;
  };
  await Promise.all([ritmo.vez('tok', tarefa), ritmo.vez('tok', tarefa), ritmo.vez('tok', tarefa)]);
  assert.equal(maxSimultaneas, 1);
  assert.deepEqual(
    inicios.map((t) => t - inicios[0]!),
    [0, 1000, 2000],
  );
});

test('Ritmo: tokens diferentes não esperam um pelo outro', async () => {
  const r = relogio();
  const ritmo = new Ritmo(1000, r.dormir, r.agora);
  await Promise.all([ritmo.vez('a', async () => 1), ritmo.vez('b', async () => 2)]);
  assert.deepEqual(r.esperas, []);
});

test('Ritmo: a fila anda mesmo quando uma requisição falha', async () => {
  const r = relogio();
  const ritmo = new Ritmo(10, r.dormir, r.agora);
  const falha = ritmo.vez('tok', async () => {
    throw new Error('caiu');
  });
  const depois = ritmo.vez('tok', async () => 'ok');
  await assert.rejects(falha, /caiu/);
  assert.equal(await depois, 'ok');
});

test('Orcamento: estoura exatamente no teto', () => {
  const o = new Orcamento(2);
  o.gastar();
  o.gastar();
  assert.throws(() => o.gastar(), OrcamentoEsgotado);
  assert.equal(o.usadas, 2);
});

test('Cache: expira no prazo', () => {
  const r = relogio();
  const cache = new Cache(r.agora);
  cache.guardar('k', { n: 1 }, 1000);
  assert.deepEqual(cache.pegar('k'), { n: 1 });
  r.avancar(999);
  assert.ok(cache.pegar('k'));
  r.avancar(1);
  assert.equal(cache.pegar('k'), undefined);
});

test('Contador: ids no caminho viram {id} e a conta é por unidade', () => {
  assert.equal(Contador.endpoint('GET', '/api/clients/123'), 'GET /api/clients/{id}');
  assert.equal(Contador.endpoint('POST', '/api/schedules/search'), 'POST /api/schedules/search');
  const c = new Contador();
  c.registrar('serra', 'GET', '/api/clients/1', true);
  c.registrar('serra', 'GET', '/api/clients/2', false);
  c.registrar('taubate', 'POST', '/api/schedules/search', true);
  const r = c.resumo();
  assert.equal(r.total, 3);
  assert.deepEqual(r.porUnidade.serra, { 'GET /api/clients/{id}': { chamadas: 2, erros: 1 } });
});

test('emParalelo: respeita o limite e devolve na ordem da entrada', async () => {
  let rodando = 0;
  let max = 0;
  const saida = await emParalelo([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
    rodando++;
    max = Math.max(max, rodando);
    await new Promise((r) => setTimeout(r, n));
    rodando--;
    return n * 10;
  });
  assert.equal(max, 3);
  assert.deepEqual(saida, [50, 10, 40, 20, 30, 0, 60]);
});

test('Cache: teto de entradas — vencidas saem primeiro, depois as mais antigas', () => {
  let agora = 0;
  const cache = new Cache(() => agora, 3);
  cache.guardar('vence', 1, 10);
  cache.guardar('a', 1, 1000);
  cache.guardar('b', 1, 1000);
  agora = 20;
  cache.guardar('c', 1, 1000); // passou do teto: sai a vencida
  assert.equal(cache.pegar('vence'), undefined);
  assert.equal(cache.tamanho, 3);
  cache.guardar('d', 1, 1000); // nenhuma vencida: sai a mais antiga (a)
  assert.equal(cache.pegar('a'), undefined);
  assert.equal(cache.pegar('d'), 1);
  assert.equal(cache.tamanho, 3);
});
