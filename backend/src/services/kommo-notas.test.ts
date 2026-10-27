import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { KommoClient, type NotaKommo } from './kommo.service.js';

const nota = (id: number, created_at: number): NotaKommo => ({ id, note_type: 'common', created_by: 0, created_at, params: { text: `n${id}` } });

/** Páginas que o Kommo devolveria para `GET /leads/:id/notes` (já em ordem decrescente); `''` = 204 sem corpo. */
function clienteCom(paginas: Array<NotaKommo[] | ''>) {
  const pedidos: Array<{ url: string; params: Record<string, unknown> }> = [];
  const http = {
    get: async (url: string, cfg: { params: Record<string, unknown> }) => {
      pedidos.push({ url, params: cfg.params });
      const p = paginas[(cfg.params.page as number) - 1] ?? '';
      return { data: p === '' ? '' : { _embedded: { notes: p } } };
    },
  } as unknown as AxiosInstance;
  return { cliente: new KommoClient({ subdomain: 'teste', accessToken: 't' } as never, http), pedidos };
}

test('listarNotasDoLead: cartão sem nota (204 sem corpo) devolve vazio', async () => {
  const { cliente, pedidos } = clienteCom(['']);
  assert.deepEqual(await cliente.listarNotasDoLead(29029780, 30), { notas: [], truncado: false });
  assert.equal(pedidos[0]!.url, '/leads/29029780/notes');
  assert.equal(pedidos[0]!.params['order[id]'], 'desc');
});

test('listarNotasDoLead: corta no limite e avisa que ficou nota de fora', async () => {
  const { cliente } = clienteCom([[nota(3, 300), nota(2, 200), nota(1, 100)]]);
  const r = await cliente.listarNotasDoLead(1, 2);
  assert.deepEqual(r.notas.map((n) => n.id), [3, 2]);
  assert.equal(r.truncado, true);
});

test('listarNotasDoLead: período pula as novas demais e para na primeira antiga demais', async () => {
  const { cliente, pedidos } = clienteCom([[nota(4, 400), nota(3, 300), nota(2, 200), nota(1, 100)]]);
  const r = await cliente.listarNotasDoLead(1, 500, { desde: 150, ate: 350 });
  assert.deepEqual(r.notas.map((n) => n.id), [3, 2]);
  assert.equal(r.truncado, false);
  assert.equal(pedidos.length, 1);
});

test('listarNotasDoLead: pagina enquanto vier página cheia', async () => {
  const cheia = Array.from({ length: 250 }, (_, i) => nota(1000 - i, 10_000 - i));
  const { cliente, pedidos } = clienteCom([cheia, [nota(1, 1)]]);
  const r = await cliente.listarNotasDoLead(1, 500);
  assert.equal(r.notas.length, 251);
  assert.equal(r.truncado, false);
  assert.equal(pedidos.length, 2);
});
