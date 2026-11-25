/**
 * A MARCA que o servidor grava ao publicar (content_attributes), da qual o rótulo do balão depende: a Sofia publicada pelo conector leva `dd_sofia`; a espera fixa da demora
 * leva `demora_espera` nos DOIS caminhos (pelo robô e pelo conector). Sem a marca, o CRM não sabe distinguir e o rótulo erraria («modelo automático» para texto da Sofia).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { portaDoChatwoot } = await import('./chatwoot-porta.js');
const { portaDoRobo } = await import('./chatwoot-sofia-bot.js');
const { criarContextoChatwoot } = await import('../mcp-remoto/chatwoot.js');

type Chamada = { url: string; corpo: Record<string, unknown> };
function falso(chamadas: Chamada[]) {
  return (async (url: string, init?: { body?: string }) => {
    chamadas.push({ url: String(url), corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 501, sender: { id: 2 } }) } as Response;
  }) as unknown as typeof fetch;
}
const CONTA = { url: 'https://crm.exemplo.test', conta: 1, token: 'tk' };

test('Sofia pelo conector: a porta do Chatwoot grava a marca em content_attributes; sem marca, não manda o campo', async () => {
  const chamadas: Chamada[] = [];
  const porta = portaDoChatwoot(criarContextoChatwoot(CONTA, { fetch: falso(chamadas) }));
  await porta.publica(77, 'Oi, aqui é a Sofia', { dd_sofia: true });
  await porta.publica(77, 'sem marca');
  assert.deepEqual(chamadas[0]!.corpo, { content: 'Oi, aqui é a Sofia', message_type: 'outgoing', private: false, content_attributes: { dd_sofia: true } });
  assert.deepEqual(chamadas[1]!.corpo, { content: 'sem marca', message_type: 'outgoing', private: false });
});

test('pelo robô: a porta do robô também leva a marca (espera da demora), e sem marca não manda o campo', async () => {
  const chamadas: Chamada[] = [];
  const base = criarContextoChatwoot(CONTA, { fetch: falso(chamadas) });
  const robo = portaDoRobo(base, 'botoken1234567890', { fetch: falso(chamadas) })!;
  await robo.publica(77, 'Já já alguém te responde', { demora_espera: true });
  await robo.publica(77, 'resposta da Sofia');
  assert.deepEqual(chamadas[0]!.corpo.content_attributes, { demora_espera: true });
  assert.equal('content_attributes' in chamadas[1]!.corpo, false);
});

test('a espera da demora grava demora_espera nos DOIS caminhos: pelo robô (token do robô ligado) e pelo conector', async () => {
  const { mundoReal } = await import('./crm-demora-worker.js');
  const guardado = { fetch: globalThis.fetch, env: { ...process.env } };
  const chamadas: Chamada[] = [];
  try {
    process.env.CHATWOOT_URL = CONTA.url; process.env.CHATWOOT_TOKEN = 'tk'; process.env.CHATWOOT_CONTA_ID = '1';
    process.env.CHATWOOT_SOFIA_COMO_BOT = '1'; process.env.CHATWOOT_SOFIA_BOT_TOKEN = 'botoken1234567890';
    globalThis.fetch = falso(chamadas); // o caminho do robô cria o próprio contexto (fetch global)
    const ctx = criarContextoChatwoot(CONTA, { fetch: falso(chamadas) });
    const u = { slug: 'doutor-hernia-parauapebas' } as never;
    await mundoReal().mandarEspera(u, ctx, 77, 'Já já alguém te responde'); // com o robô
    process.env.CHATWOOT_SOFIA_COMO_BOT = '0';
    await mundoReal().mandarEspera(u, ctx, 77, 'Já já alguém te responde'); // pelo conector
  } finally {
    globalThis.fetch = guardado.fetch;
    for (const k of ['CHATWOOT_URL', 'CHATWOOT_TOKEN', 'CHATWOOT_CONTA_ID', 'CHATWOOT_SOFIA_COMO_BOT', 'CHATWOOT_SOFIA_BOT_TOKEN']) {
      if (guardado.env[k] === undefined) delete process.env[k]; else process.env[k] = guardado.env[k];
    }
  }
  const posts = chamadas.filter((c) => c.url.endsWith('/messages'));
  assert.equal(posts.length, 2);
  for (const c of posts) assert.deepEqual(c.corpo.content_attributes, { demora_espera: true });
});

test('a Sofia da IA (portasReais): SEM robô na conta sai pelo conector COM a marca dd_sofia; com o robô não precisa de marca (o remetente já é o robô)', async () => {
  const { portasReais } = await import('./chatwoot-ia.js');
  const chamadas: Chamada[] = [];
  const ctx = criarContextoChatwoot(CONTA, { fetch: falso(chamadas) });
  await portasReais(ctx, { tokenRobo: null }).publica(77, 'Oi, aqui é a Sofia');
  assert.deepEqual(chamadas.find((c) => c.url.endsWith('/messages'))!.corpo.content_attributes, { dd_sofia: true });
});
