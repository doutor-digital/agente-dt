import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { KommoClient } from './kommo.service.js';

const USUARIOS = [
  { id: 12586363, name: 'Doutor Digital', rights: { is_active: true } },
  { id: 12586999, name: 'Doutor Hérnia Marabá', rights: { is_active: true } },
];

function cliente(op: { usuarios?: () => unknown; recusar?: (quem: unknown) => boolean } = {}) {
  const gets: Array<{ url: string; cfg: Record<string, unknown> }> = [];
  const posts: Array<{ responsible_user_id?: number }> = [];
  const http = {
    get: async (url: string, cfg: Record<string, unknown>) => {
      gets.push({ url, cfg });
      return { data: { _embedded: { users: op.usuarios ? op.usuarios() : USUARIOS } } };
    },
    post: async (_url: string, body: Array<{ responsible_user_id?: number }>) => {
      posts.push(body[0]!);
      if (op.recusar?.(body[0]!.responsible_user_id)) throw new Error('400');
      return { data: { _embedded: { tasks: [{ id: 2484344 }] } } };
    },
  } as unknown as AxiosInstance;
  return { k: new KommoClient({ subdomain: 'marabadoutorhernia', accessToken: 't' } as never, http), gets, posts };
}

const tarefa = { leadId: 29029780, text: 'LIGAR AGORA', completeAt: 1 };

beforeEach(() => KommoClient._limparUsuariosDasContas());

test('Marabá 29029780: LIGAR AGORA do Doutor Digital nasce no usuário da clínica', async () => {
  const { k, posts, gets } = cliente();
  await k.createTask({ ...tarefa, responsibleUserId: 12586363 });
  assert.equal(posts[0]!.responsible_user_id, 12586999);
  assert.equal(gets[0]!.cfg.semFreio, true); // 403 do /users não trava o Kommo de todas as unidades
});

test('várias tarefas juntas: uma leitura de /users só (cache)', async () => {
  const { k, gets } = cliente();
  await Promise.all([k.createTask(tarefa), k.createTask(tarefa), k.createTask({ ...tarefa, responsibleUserId: 12586363 })]);
  assert.equal(gets.length, 1);
});

test('/users falhou: fica o responsável pedido, e não relê a cada tarefa', async () => {
  const { k, posts, gets } = cliente({
    usuarios: () => {
      throw new Error('403');
    },
  });
  await k.createTask({ ...tarefa, responsibleUserId: 12586363 });
  await k.createTask({ ...tarefa, responsibleUserId: 12586363 });
  assert.deepEqual(posts.map((p) => p.responsible_user_id), [12586363, 12586363]);
  assert.equal(gets.length, 1);
});

test('o Kommo recusou o usuário da clínica: repete com o responsável do lead e a tarefa nasce', async () => {
  const { k, posts } = cliente({ recusar: (quem) => quem === 12586999 });
  const r = await k.createTask({ ...tarefa, responsibleUserId: 12586363 });
  assert.deepEqual(r, { id: 2484344 });
  assert.deepEqual(posts.map((p) => p.responsible_user_id), [12586999, 12586363]);
});

test('recusa sem troca de responsável não repete: o erro sobe', async () => {
  const { k, posts } = cliente({ recusar: () => true });
  await assert.rejects(k.createTask({ ...tarefa, responsibleUserId: 12586999 }));
  assert.equal(posts.length, 1);
});

test('responsável escolhido (conector, ação do console) não é trocado nem lê /users', async () => {
  const { k, posts, gets } = cliente();
  await k.createTask({ ...tarefa, responsibleUserId: 12586363, manterResponsavel: true });
  assert.equal(posts[0]!.responsible_user_id, 12586363);
  assert.equal(gets.length, 0);
});
