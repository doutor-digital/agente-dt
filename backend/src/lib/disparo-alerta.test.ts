import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertaLimiteDeTaxa, alertaNumeroRestrito, alertaPausaPorFalhas, alertaPausaPorSair, alertaSemAndar } from './disparo/alerta.js';
import { env } from './env.js';
import { depoisDaRodada } from './disparo-worker.js';
import { portoReal } from './disparo/porto.js';
import { enviarTelegram } from './telegram.js';

const vazia = { adiados: 0, mandou: 0, receberia: 0, falhou: 0, saiu: 0, descartados: 0 };
const UNIT = { id: 'u1', slug: 'doutor-hernia-canaa' };

test('cada texto traz a unidade, a onda, o motivo e o que fazer', () => {
  const restrito = alertaNumeroRestrito({ unidade: 'doutor-hernia-canaa', ondas: ['o1', 'o2'] });
  for (const t of ['doutor-hernia-canaa', 'o1, o2', '131048', 'O que fazer', 'Retomar']) assert.ok(restrito.includes(t), t);
  const taxa = alertaLimiteDeTaxa({ unidade: 'doutor-hernia-canaa', ondas: ['o1'], rodadas: 10 });
  for (const t of ['doutor-hernia-canaa', 'o1', '10 rodadas', 'O que fazer']) assert.ok(taxa.includes(t), t);
  const sem = alertaSemAndar({ unidade: 'doutor-hernia-canaa', rodadas: 5, adiados: 3 });
  for (const t of ['doutor-hernia-canaa', '5 rodadas', 'franquia', 'O que fazer']) assert.ok(sem.includes(t), t);
  assert.ok(alertaNumeroRestrito({ unidade: 'u', ondas: [] }).includes('(nenhuma aprovada)'));
});

test('SEM ANDAR: avisa o João UMA vez ao chegar a 5 rodadas; não repete nas seguintes; episódio novo (depois que alguém anda) avisa de novo', async () => {
  const avisos: string[] = [];
  const ctx = { avisar: async (t: string) => void avisos.push(t), contagem: new Map<string, number>() };
  const presa = { ...vazia, adiados: 3 };
  for (let i = 1; i <= 4; i++) await depoisDaRodada(UNIT, presa, ctx);
  assert.deepEqual(avisos, [], 'até a 4ª nada');
  await depoisDaRodada(UNIT, presa, ctx);
  assert.equal(avisos.length, 1, 'na 5ª avisa');
  assert.match(avisos[0]!, /doutor-hernia-canaa[\s\S]*5 rodadas/);
  for (let i = 6; i <= 14; i++) await depoisDaRodada(UNIT, presa, ctx);
  assert.equal(avisos.length, 1, 'e não repete a cada rodada (nem a cada 5)');
  await depoisDaRodada(UNIT, { ...vazia, receberia: 2 }, ctx); // alguém andou: o episódio acabou
  for (let i = 1; i <= 5; i++) await depoisDaRodada(UNIT, presa, ctx);
  assert.equal(avisos.length, 2, 'novo episódio, novo aviso');
});

test('SEM ANDAR: é por unidade, e Telegram que falha não derruba a rodada', async () => {
  const avisos: string[] = [];
  const contagem = new Map<string, number>();
  const ctx = { avisar: async (t: string) => void avisos.push(t), contagem };
  for (let i = 0; i < 5; i++) await depoisDaRodada({ id: 'a', slug: 'unidade-a' }, { ...vazia, adiados: 1 }, ctx);
  for (let i = 0; i < 4; i++) await depoisDaRodada({ id: 'b', slug: 'unidade-b' }, { ...vazia, adiados: 1 }, ctx);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /unidade-a/);
  const quebrado = { avisar: async () => { throw new Error('telegram fora'); }, contagem: new Map<string, number>() };
  for (let i = 0; i < 5; i++) await depoisDaRodada(UNIT, { ...vazia, adiados: 1 }, quebrado);
});

test('porto real: avisar usa o Telegram (enviarTelegram, com Telegram de mentira) e engole a falha', async () => {
  const pedidos: Array<{ url: string; corpo: { chat_id: string; text: string } }> = [];
  const fetchFalso = (async (url: string, opcoes: RequestInit) => {
    pedidos.push({ url: String(url), corpo: JSON.parse(String(opcoes.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const env = { TELEGRAM_BOT_TOKEN: 'tok-de-teste', TELEGRAM_CHAT_JOAO: '42' } as NodeJS.ProcessEnv;
  const porto = portoReal(new Map(), (t) => enviarTelegram(t, { env, fetch: fetchFalso }));
  await porto.avisar(alertaNumeroRestrito({ unidade: 'doutor-hernia-canaa', ondas: ['o1'] }));
  assert.equal(pedidos.length, 1);
  assert.match(pedidos[0]!.url, /\/bottok-de-teste\/sendMessage$/);
  assert.equal(pedidos[0]!.corpo.chat_id, '42');
  assert.match(pedidos[0]!.corpo.text, /doutor-hernia-canaa[\s\S]*131048/);

  const semToken = portoReal(new Map(), (t) => enviarTelegram(t, { env: {} as NodeJS.ProcessEnv, fetch: fetchFalso }));
  await semToken.avisar('x'); // sem token: não manda e não lança
  const lanca = portoReal(new Map(), async () => { throw new Error('boom'); });
  await lanca.avisar('x');
  assert.equal(pedidos.length, 1);
});

test('texto da pausa por SAIR: quantos pediram, o link do painel e o que fazer; NÃO tem texto de paciente; só o João retoma', () => {
  const m = alertaPausaPorSair({ unidade: 'doutor-hernia-canaa', ondas: [{ id: 'o1', painel: 'https://x/api/disparo/ondas/o1/painel' }, { id: 'o2', painel: null }], sairam: 4, limite: 3 });
  for (const t of ['doutor-hernia-canaa', '4 pessoas pediram SAIR', 'acima de 3', 'o1 — https://x/api/disparo/ondas/o1/painel', '\no2', 'Só você retoma']) assert.ok(m.includes(t), t);
  assert.ok(!/escreveu:|"/.test(m), 'sem citação de mensagem de paciente');
  const f = alertaPausaPorFalhas({ unidade: 'doutor-hernia-canaa', ondas: [], falhas: 5 });
  for (const t of ['5 envios seguidos recusados', '(nenhuma aprovada)', 'O que fazer']) assert.ok(f.includes(t), t);
});

test('porto real: o link do painel usa a origem de MCP_URL_PUBLICA; sem ela, sem link', () => {
  const antes = env.MCP_URL_PUBLICA;
  try {
    (env as { MCP_URL_PUBLICA?: string }).MCP_URL_PUBLICA = 'https://agente-vps.exemplo.com/mcp';
    assert.equal(portoReal(new Map()).linkDoPainel('o 1'), 'https://agente-vps.exemplo.com/api/disparo/ondas/o%201/painel');
    (env as { MCP_URL_PUBLICA?: string }).MCP_URL_PUBLICA = undefined;
    assert.equal(portoReal(new Map()).linkDoPainel('o1'), null);
  } finally {
    (env as { MCP_URL_PUBLICA?: string }).MCP_URL_PUBLICA = antes;
  }
});
