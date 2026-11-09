import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_JOAO_PADRAO, configTelegram, enviarTelegram, enviarTelegramChamados, enviarTelegramSofia, semSegredo, telegramConfigurado } from './telegram.js';

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

// ─── três canais, cada um com o seu bot ────────────────────────────────────────────────────────────────

const AVISOS = '111:FALSO-avisos';
const CHAMADOS = '222:FALSO-chamados';
const SOFIA = '333:FALSO-sofia';
const TODOS = { TELEGRAM_BOT_TOKEN: AVISOS, TELEGRAM_CHAMADOS_TOKEN: CHAMADOS, TELEGRAM_CHAMADOS_CHAT: '-100500', TELEGRAM_SOFIA_TOKEN: SOFIA } as NodeJS.ProcessEnv;

test('canais: cada um usa o token do seu bot; o chat próprio só vale com o token próprio', () => {
  assert.equal(configTelegram(TODOS)?.token, AVISOS);
  assert.equal(configTelegram(TODOS, 'avisos')?.canal, 'avisos');
  const c = configTelegram(TODOS, 'chamados');
  assert.equal(c?.token, CHAMADOS);
  assert.equal(c?.chat, '-100500');
  assert.equal(c?.canal, 'chamados');
  const s = configTelegram(TODOS, 'sofia');
  assert.equal(s?.token, SOFIA);
  assert.equal(s?.chat, CHAT_JOAO_PADRAO); // sem TELEGRAM_SOFIA_CHAT: o chat do João
});

test('canal sem token próprio cai no DD-Avisos (token E chat do DD-Avisos, nunca o chat de outro bot)', () => {
  const env = { TELEGRAM_BOT_TOKEN: AVISOS, TELEGRAM_CHAMADOS_CHAT: '-100500' } as NodeJS.ProcessEnv; // chat órfão, sem token
  const c = configTelegram(env, 'chamados');
  assert.equal(c?.token, AVISOS);
  assert.equal(c?.chat, CHAT_JOAO_PADRAO);
  assert.equal(c?.canal, 'avisos');
  // token próprio só com espaços não conta
  assert.equal(configTelegram({ ...env, TELEGRAM_SOFIA_TOKEN: '   ' } as NodeJS.ProcessEnv, 'sofia')?.token, AVISOS);
});

test('sem nenhum token (nem o do DD-Avisos): nenhum canal envia', () => {
  for (const canal of ['avisos', 'chamados', 'sofia'] as const) {
    assert.equal(configTelegram({} as NodeJS.ProcessEnv, canal), null);
    assert.equal(telegramConfigurado({} as NodeJS.ProcessEnv, canal), false);
  }
  // só o token do canal basta para o canal funcionar, mesmo sem o DD-Avisos
  assert.equal(telegramConfigurado({ TELEGRAM_SOFIA_TOKEN: SOFIA } as NodeJS.ProcessEnv, 'sofia'), true);
  assert.equal(telegramConfigurado({ TELEGRAM_SOFIA_TOKEN: SOFIA } as NodeJS.ProcessEnv, 'avisos'), false);
});

test('enviarTelegram com canal: o POST sai pela URL do bot daquele canal e para o chat dele', async () => {
  const pedidos: Array<{ url: string; chat: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    pedidos.push({ url, chat: JSON.parse(String(init.body)).chat_id });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await enviarTelegram('a', { env: TODOS, fetch: f }), true);
  assert.equal(await enviarTelegram('b', { env: TODOS, fetch: f, canal: 'chamados' }), true);
  assert.equal(await enviarTelegram('c', { env: TODOS, fetch: f, canal: 'sofia' }), true);
  assert.ok(pedidos[0]!.url.includes(`/bot${AVISOS}/`));
  assert.ok(pedidos[1]!.url.includes(`/bot${CHAMADOS}/`));
  assert.equal(pedidos[1]!.chat, '-100500');
  assert.ok(pedidos[2]!.url.includes(`/bot${SOFIA}/`));
});

test('os atalhos enviarTelegramChamados e enviarTelegramSofia escolhem o canal sozinhos', async () => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  await enviarTelegramChamados('x', { env: TODOS, fetch: f });
  await enviarTelegramSofia('y', { env: TODOS, fetch: f });
  assert.ok(urls[0]!.includes(`/bot${CHAMADOS}/`));
  assert.ok(urls[1]!.includes(`/bot${SOFIA}/`));
});
