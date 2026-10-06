import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lerPagina, lerTudo } from './paginar.js';
import { Orcamento } from './ritmo.js';

/** Uma "franquia" de 250 registros, servida em páginas de 100, com o envelope que a gente escolher. */
function fonte(envelope: (itens: number[], pagina: number) => unknown, total = 250, linhas = 100) {
  const pedidas: number[] = [];
  const buscar = async (pagina: number) => {
    pedidas.push(pagina);
    const itens = Array.from({ length: total }, (_, i) => i + 1).slice((pagina - 1) * linhas, pagina * linhas);
    return envelope(itens, pagina);
  };
  return { buscar, pedidas };
}

test('envelope real (aninhado) e o do guia', () => {
  assert.deepEqual(lerPagina({ status: 'success', data: { data: [1, 2], total: 2, totalPages: 1 } }), { itens: [1, 2], total: 2, totalPaginas: 1 });
  assert.deepEqual(lerPagina({ success: true, data: [1], total: 1, totalPages: 1 }), { itens: [1], total: 1, totalPaginas: 1 });
});

test('formato desconhecido é erro, nunca lista vazia', () => {
  for (const ruim of [{}, { data: null }, { data: { itens: [] } }, null, 'x']) assert.throws(() => lerPagina(ruim), /formato/);
});

test('com totalPages: lê todas', async () => {
  const f = fonte((itens) => ({ data: { data: itens, total: 250, totalPages: 3 } }));
  const r = await lerTudo(f.buscar, 20, 100);
  assert.equal(r.itens.length, 250);
  assert.equal(r.truncado, false);
});

test('SEM totalPages, mas com total: continua até bater o total', async () => {
  const f = fonte((itens) => ({ data: { data: itens, total: 250 } }));
  const r = await lerTudo(f.buscar, 20, 100);
  assert.equal(r.itens.length, 250);
  assert.deepEqual(f.pedidas, [1, 2, 3]);
});

test('sem totalPages e sem total: continua enquanto a página vem cheia', async () => {
  const f = fonte((itens) => ({ data: { data: itens } }));
  const r = await lerTudo(f.buscar, 20, 100);
  assert.equal(r.itens.length, 250);
  assert.deepEqual(f.pedidas, [1, 2, 3]);
  // múltiplo exato de 100: pede uma página a mais, que volta vazia, e para
  const g = fonte((itens) => ({ data: { data: itens } }), 200);
  assert.equal((await lerTudo(g.buscar, 20, 100)).itens.length, 200);
  assert.deepEqual(g.pedidas, [1, 2, 3]);
});

test('teto de páginas marca truncado e diz quantas a franquia tem', async () => {
  const f = fonte((itens) => ({ data: { data: itens, total: 250, totalPages: 3 } }));
  const r = await lerTudo(f.buscar, 2, 100);
  assert.equal(r.itens.length, 200);
  assert.equal(r.truncado, true);
  assert.match(r.motivoTruncado ?? '', /teto de 2 páginas \(a franquia tem 3\)/);
});

test('cota acabando no meio devolve o que leu, marcado', async () => {
  const o = new Orcamento(2);
  const f = fonte((itens) => ({ data: { data: itens, total: 250, totalPages: 3 } }));
  const r = await lerTudo(async (p) => (o.gastar(), f.buscar(p)), 20, 100);
  assert.equal(r.itens.length, 200);
  assert.equal(r.truncado, true);
});
