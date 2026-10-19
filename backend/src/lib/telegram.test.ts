import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_JOAO_PADRAO, configTelegram, enviarTelegram, semSegredo } from './telegram.js';

const TOKEN = '123456:FALSO-token-de-teste';

test('sem TELEGRAM_BOT_TOKEN: não chama a API e devolve false', async () => {
  let chamou = false;
  const ok = await enviarTelegram('oi', {
    env: {} as NodeJS.ProcessEnv,
    fetch: (async () => {
      chamou = true;
      return new Response('{}');
    }) as typeof fetch,
  });
  assert.equal(ok, false);
  assert.equal(chamou, false);
  assert.equal(configTelegram({} as NodeJS.ProcessEnv), null);
});

test('com token: POST no sendMessage, destino padrão = chat do João', async () => {
  const pedidos: Array<{ url: string; corpo: Record<string, unknown> }> = [];
  const ok = await enviarTelegram('⏰ Paciente sem resposta', {
    env: { TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv,
    fetch: (async (url: string, init: RequestInit) => {
      pedidos.push({ url, corpo: JSON.parse(String(init.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(ok, true);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(pedidos[0].corpo.chat_id, CHAT_JOAO_PADRAO);
  assert.equal(CHAT_JOAO_PADRAO, '7822226023');
  assert.equal(pedidos[0].corpo.text, '⏰ Paciente sem resposta');
});

test('destino por parâmetro (os grupos das unidades, depois) e por variável', async () => {
  const chats: unknown[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    chats.push(JSON.parse(String(init.body)).chat_id);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  await enviarTelegram('a', { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_JOAO: '42' } as NodeJS.ProcessEnv, fetch: f });
  await enviarTelegram('b', { env: { TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv, fetch: f, chat: '-100777' });
  assert.deepEqual(chats, ['42', '-100777']);
});

test('recusa ou erro de rede: false, sem lançar', async () => {
  const recusou = await enviarTelegram('x', {
    env: { TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv,
    fetch: (async () => new Response('{"ok":false}', { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(recusou, false);
  const caiu = await enviarTelegram('x', {
    env: { TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv,
    fetch: (async () => {
      throw new Error(`falhou https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as unknown as typeof fetch,
  });
  assert.equal(caiu, false);
});

test('semSegredo: o token nunca sobra num texto de log', () => {
  assert.equal(semSegredo(`url .../bot${TOKEN}/sendMessage`, TOKEN), 'url .../bot***/sendMessage');
  assert.equal(semSegredo('nada aqui', TOKEN), 'nada aqui');
});
