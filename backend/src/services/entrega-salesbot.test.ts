import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { KommoClient } from './kommo.service.js';

interface Chamada {
  url: string;
  body: unknown;
}

function clienteFalso() {
  const patches: Chamada[] = [];
  const posts: Chamada[] = [];
  const http = {
    patch: async (url: string, body: unknown) => {
      patches.push({ url, body });
      return { data: {} };
    },
    post: async (url: string, body: unknown) => {
      posts.push({ url, body });
      return { data: {} };
    },
    get: async () => ({ data: { custom_fields_values: [] } }),
  } as unknown as AxiosInstance;

  const creds = {
    subdomain: 'unidade-teste',
    accessToken: 'token',
    salesbotId: 108264,
    replyFieldId: 2450406,
    bypassSalesbot: false,
    salesbotExecuteEnabled: true,
  };

  return { cliente: new KommoClient(creds as never, http), patches, posts };
}

function textoDo(patch: Chamada): string {
  const body = patch.body as { custom_fields_values: { values: { value: string }[] }[] };
  return body.custom_fields_values[0].values[0].value;
}

const LONGO =
  'Poxa, imagina não conseguir fazer as coisas de casa com tranquilidade. Isso pesa mesmo, ' +
  'e o nosso trabalho não é só aliviar, mas tratar a causa pra você voltar a fazer suas ' +
  'tarefas sem esse peso. A consulta é R$ 350, ou R$ 250 à vista no PIX. Faz sentido pra ' +
  'você a gente já ver um horário?';

test('caso real de Balsas: resposta longa vai em UM PATCH e UM disparo', async () => {
  const { cliente, patches, posts } = clienteFalso();
  assert.ok(LONGO.length > 240);

  await cliente.sendChatReply({ leadId: 24325194, text: LONGO, chatId: null, talkId: null, contactId: null });

  assert.equal(patches.length, 1);
  assert.equal(posts.length, 1);
});

test('o texto chega inteiro no campo, sem perder pedaço', async () => {
  const { cliente, patches } = clienteFalso();

  await cliente.sendChatReply({ leadId: 1, text: LONGO, chatId: null, talkId: null, contactId: null });

  assert.equal(textoDo(patches[0]), LONGO);
});

test('resposta curta continua com um disparo só', async () => {
  const { cliente, patches, posts } = clienteFalso();

  await cliente.sendChatReply({ leadId: 1, text: 'Oi! Tudo bem?', chatId: null, talkId: null, contactId: null });

  assert.equal(patches.length, 1);
  assert.equal(posts.length, 1);
  assert.equal(textoDo(patches[0]), 'Oi! Tudo bem?');
});

test('dois PATCHes seguidos no mesmo campo é o que duplicava a mensagem', () => {
  const disparos = [
    { patch: 'chunk 1', run: true },
    { patch: 'chunk 2', run: true },
  ];
  const lidoNaExecucao = disparos.map(() => disparos[disparos.length - 1].patch);
  assert.deepEqual(lidoNaExecucao, ['chunk 2', 'chunk 2']);
});
