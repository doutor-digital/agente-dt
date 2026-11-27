import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enviarAvisoDoVigia, PREFIXO_DA_FRASE } from './vigia-rede-banco.js';
import { FALLBACK_INDISPONIVEL } from '../agent/llm-policy.js';
import { CHAT_JOAO_PADRAO } from './telegram.js';

function espiao() {
  const chamadas: Array<{ url: string; chat: string; texto: string }> = [];
  const fetchFalso = (async (url: string | URL | Request, init?: RequestInit) => {
    const corpo = JSON.parse(String(init?.body ?? '{}')) as { chat_id: string; text: string };
    chamadas.push({ url: String(url), chat: String(corpo.chat_id), texto: corpo.text });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  return { chamadas, fetchFalso };
}

test('o vigia só manda para o Telegram PESSOAL do João (bot DD-Avisos, chat do João), nunca outro chat', async () => {
  const { chamadas, fetchFalso } = espiao();
  // Ambiente de produção com TODOS os canais e grupos configurados: nenhum deles pode ser o destino.
  const env = {
    TELEGRAM_BOT_TOKEN: 'token-avisos-123',
    TELEGRAM_CHAT_JOAO: '7822226023',
    TELEGRAM_CHAMADOS_TOKEN: 'token-chamados-456',
    TELEGRAM_CHAMADOS_CHAT: '-1001111111111',
    TELEGRAM_SOFIA_TOKEN: 'token-sofia-789',
    TELEGRAM_SOFIA_CHAT: '-1002222222222',
  } as NodeJS.ProcessEnv;
  assert.equal(await enviarAvisoDoVigia('teste', { env, fetch: fetchFalso }), true);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].chat, '7822226023', 'chat do João');
  assert.ok(chamadas[0].url.includes('/bottoken-avisos-123/'), 'bot do canal avisos');
  assert.ok(!chamadas[0].url.includes('chamados') && !chamadas[0].url.includes('sofia'));
});

test('sem TELEGRAM_CHAT_JOAO configurado, cai no chat padrão do João (o mesmo dos avisos do Asaas)', async () => {
  const { chamadas, fetchFalso } = espiao();
  await enviarAvisoDoVigia('teste', { env: { TELEGRAM_BOT_TOKEN: 'tok-abc-123' } as NodeJS.ProcessEnv, fetch: fetchFalso });
  assert.equal(chamadas[0].chat, CHAT_JOAO_PADRAO);
  assert.equal(CHAT_JOAO_PADRAO, '7822226023');
});

test('sem token do Telegram, o aviso não sai (e não vai para e-mail/relay)', async () => {
  const { chamadas, fetchFalso } = espiao();
  assert.equal(await enviarAvisoDoVigia('teste', { env: {} as NodeJS.ProcessEnv, fetch: fetchFalso }), false);
  assert.equal(chamadas.length, 0);
});

test('o código do vigia não importa o relay de e-mail nem escolhe outro chat/canal', () => {
  for (const arq of ['vigia-rede.ts', 'vigia-rede-banco.ts']) {
    const fonte = readFileSync(new URL(`./${arq}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(fonte, /opsAlert|ALERT_RELAY|alertrelay/, `${arq} não usa o relay de e-mail`);
    assert.doesNotMatch(fonte, /\bchat\s*:/, `${arq} não passa chat próprio ao Telegram`);
    assert.doesNotMatch(fonte, /canal:\s*'(chamados|sofia)'/, `${arq} não usa outro canal`);
    assert.doesNotMatch(fonte, /enviarTelegram(Chamados|Sofia)/, `${arq} não usa os atalhos de outros canais`);
  }
});

test('o detector da frase de queda procura o começo REAL da frase que o paciente recebe (mexeu no texto? este teste avisa)', () => {
  assert.ok(FALLBACK_INDISPONIVEL.startsWith(PREFIXO_DA_FRASE));
  assert.ok(PREFIXO_DA_FRASE.length >= 30);
  // em produção a frase é gravada em messages.content com este começo (conferido em 27/11/2026: 111 ocorrências)
  assert.match(PREFIXO_DA_FRASE, /^Opa, tive uma instabilidade rapidinha/);
});

test('TODA consulta do vigia ao llm_calls ignora as chamadas do Joaoof (endpoint joaoof.*; endpoint nulo continua valendo)', () => {
  const fonte = readFileSync(new URL('./vigia-rede-banco.ts', import.meta.url), 'utf8');
  const consultas = fonte.match(/FROM llm_calls c/g) ?? [];
  const filtradas = fonte.match(/AND coalesce\(c\.endpoint, ''\) NOT LIKE 'joaoof\.%'|WHERE coalesce\(c\.endpoint, ''\) NOT LIKE 'joaoof\.%'/g) ?? [];
  assert.equal(consultas.length, 4);
  assert.equal(filtradas.length, consultas.length, 'cada consulta tem de filtrar o Joaoof');
  // o coalesce é o que impede `NULL NOT LIKE …` (que é NULL) de derrubar as linhas antigas, sem endpoint
  assert.doesNotMatch(fonte, /c\.endpoint NOT LIKE/);
});

test('as outras consultas da rede ao llm_calls (taxa de erro, saúde externa) também ignoram as chamadas do Joaoof', () => {
  for (const arq of ['taxa-erro-worker.ts', 'saude-externa.ts']) {
    const fonte = readFileSync(new URL(`./${arq}`, import.meta.url), 'utf8');
    const consultas = fonte.match(/from llm_calls c/gi) ?? [];
    const filtradas = fonte.match(/and coalesce\(c\.endpoint, ''\) NOT LIKE 'joaoof\.%'/g) ?? [];
    assert.ok(consultas.length > 0, arq);
    assert.equal(filtradas.length, consultas.length, `${arq}: cada consulta ao llm_calls tem de ignorar o Joaoof`);
  }
});
