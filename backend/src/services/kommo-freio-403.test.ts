import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { KommoClient, eh403DeEscopo } from './kommo.service.js';

// 04/11/2026: Imperatriz e Parauapebas não têm o escopo de chats; cada leitura da conversa oficial dava 403 e o
// freio global congelava o Kommo de TODAS as unidades por 30 s (mediana das respostas da Sofia: 20 s → 63 s).

function cliente() {
  const gets: Array<{ url: string; cfg: Record<string, unknown> }> = [];
  const http = {
    get: async (url: string, cfg: Record<string, unknown>) => {
      gets.push({ url, cfg });
      return { data: { _embedded: { talks: [], messages: [] } } };
    },
  } as unknown as AxiosInstance;
  return { k: new KommoClient({ subdomain: 'attivacorpoementeitz', accessToken: 't' } as never, http), gets };
}

test('ler a conversa oficial não aciona o freio global (talks e talks/messages com semFreio)', async () => {
  const { k, gets } = cliente();
  await k.listTalks(21890181);
  await k.listTalkMessages(9502, 15);
  assert.equal(gets.length, 2);
  for (const g of gets) assert.equal(g.cfg.semFreio, true, g.url);
});

test('403 de escopo é reconhecido; 403 sem marca de escopo (bloqueio) não é', () => {
  assert.equal(eh403DeEscopo({ title: 'Forbidden', detail: 'Invalid scope' }), true);
  assert.equal(eh403DeEscopo('{"hint":"Insufficient scope"}'), true);
  assert.equal(eh403DeEscopo({ title: 'Forbidden', detail: 'Account blocked' }), false);
  assert.equal(eh403DeEscopo(undefined), false);
  assert.equal(eh403DeEscopo(null), false);
});
