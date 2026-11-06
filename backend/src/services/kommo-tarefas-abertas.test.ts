import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { KommoClient } from './kommo.service.js';

function cliente(resposta: { status?: number; data: unknown }) {
  const gets: Array<{ url: string; params: Record<string, unknown> }> = [];
  const http = {
    get: async (url: string, cfg: { params: Record<string, unknown> }) => {
      gets.push({ url, params: cfg.params });
      return { status: resposta.status ?? 200, data: resposta.data };
    },
  } as unknown as AxiosInstance;
  return { k: new KommoClient({ subdomain: 'timbo', accessToken: 't' } as never, http), gets };
}

test('tarefasAbertasDoLead: pergunta só as abertas DO cartão', async () => {
  const { k, gets } = cliente({ data: { _embedded: { tasks: [{ id: 1, entity_id: 777, entity_type: 'leads', is_completed: false }] } } });
  const t = await k.tarefasAbertasDoLead(777);
  assert.equal(t.length, 1);
  assert.equal(gets[0]!.url, '/tasks');
  assert.equal(gets[0]!.params['filter[entity_id][]'], 777);
  assert.equal(gets[0]!.params['filter[entity_type]'], 'leads');
  assert.equal(gets[0]!.params['filter[is_completed]'], 0);
});

test('tarefasAbertasDoLead: se o Kommo ignorar o filtro, tarefa de OUTRO cartão ou já concluída não conta', async () => {
  const { k } = cliente({
    data: {
      _embedded: {
        tasks: [
          { id: 1, entity_id: 999, entity_type: 'leads', is_completed: false },
          { id: 2, entity_id: 777, entity_type: 'leads', is_completed: true },
          { id: 3, entity_id: 777, entity_type: 'contacts', is_completed: false },
          { id: 4, entity_id: 777, entity_type: 'leads', is_completed: false },
        ],
      },
    },
  });
  assert.deepEqual((await k.tarefasAbertasDoLead(777)).map((t) => t.id), [4]);
});

test('tarefasAbertasDoLead: 204 (nenhuma) é lista vazia', async () => {
  const { k } = cliente({ status: 204, data: '' });
  assert.deepEqual(await k.tarefasAbertasDoLead(777), []);
});
