/**
 * Aba «Registro»: junta respostas, eventos, decisões e avaliações; agrupa por conversa (mais nova primeiro); filtra; corta no teto.
 * E o modo «Sofia como robô» (preparado, desligado por padrão).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { montarRegistro, lerTipoDoRegistro, DESFECHOS } = await import('./sofia-registro.js');
const { portaDoRobo, tokenDoRobo } = await import('./chatwoot-sofia-bot.js');
const { criarContextoChatwoot } = await import('../mcp-remoto/chatwoot.js');
const { DESFECHOS_DO_REGISTRO } = await import('./chatwoot-ia.js');

const t = (iso: string) => new Date(iso);
const FONTES = {
  respostas: [{ conversa: 10, texto: 'Oi! Sou a Sofia.', fala: 'quero marcar', criadoEm: t('2026-11-13T12:00:00Z') }],
  eventos: [
    { conversa: 10, tipo: 'marcou', nome: 'Maria', detalhe: '2026-11-17T09:30', criadoEm: t('2026-11-13T12:05:00Z') },
    { conversa: 20, tipo: 'decisao', nome: 'calada', detalhe: 'ia-pausada', criadoEm: t('2026-11-13T13:00:00Z') },
    { conversa: 20, tipo: 'decisao', nome: 'desfecho-novo', detalhe: null, criadoEm: t('2026-11-13T09:00:00Z') },
    { conversa: 30, tipo: 'pix', nome: null, detalhe: null, criadoEm: t('2026-11-12T10:00:00Z') },
  ],
  avaliacoes: [{ conversa: 10, nota: 'ruim', texto: 'falou o preço errado', quemNome: 'Cleia', criadoEm: t('2026-11-13T12:10:00Z') }],
};

test('registro: agrupa por conversa, a conversa com o item mais novo primeiro; itens do mais novo para o mais velho', () => {
  const r = montarRegistro(FONTES);
  assert.deepEqual(r.conversas.map((c) => c.conversa), [20, 10, 30]);
  assert.deepEqual(r.conversas[1]!.itens.map((i) => i.tipo), ['avaliacao', 'marcou', 'resposta']);
  assert.equal(r.total, 6);
  assert.equal(r.cortado, false);
  const marcou = r.conversas[1]!.itens[1]!;
  assert.equal(marcou.titulo, 'Marcou consulta para 17/11 às 09h30');
  assert.equal(r.conversas[1]!.itens[2]!.detalhe, 'Paciente: quero marcar');
  assert.match(r.conversas[1]!.itens[0]!.titulo, /Cleia avaliou uma resposta como ruim/);
});

test('registro: «não respondeu» traduz desfecho e motivo; desfecho desconhecido não quebra', () => {
  const r = montarRegistro(FONTES);
  const [calada, nova] = r.conversas[0]!.itens;
  assert.equal(calada!.tipo, 'nao-respondeu');
  assert.equal(calada!.titulo, DESFECHOS.calada);
  assert.match(calada!.detalhe ?? '', /IA pausada nesta conversa/);
  assert.match(nova!.titulo, /desfecho-novo/);
});

test('registro: filtros por conversa e por tipo; teto corta e avisa; tipo inválido vira null', () => {
  assert.deepEqual(montarRegistro({ ...FONTES, filtro: { conversa: 30 } }).conversas.map((c) => c.conversa), [30]);
  const so = montarRegistro({ ...FONTES, filtro: { tipo: 'nao-respondeu' } });
  assert.equal(so.total, 2);
  assert.ok(so.conversas.every((c) => c.itens.every((i) => i.tipo === 'nao-respondeu')));
  const cortado = montarRegistro({ ...FONTES, limite: 2 });
  assert.equal(cortado.cortado, true);
  assert.equal(cortado.conversas.flatMap((c) => c.itens).length, 2);
  assert.equal(lerTipoDoRegistro('pix'), 'pix');
  assert.equal(lerTipoDoRegistro('qualquer'), null);
});

test('registro: todo desfecho que a Sofia grava tem frase para a equipe', () => {
  for (const d of DESFECHOS_DO_REGISTRO) assert.ok(DESFECHOS[d], `falta a frase de «${d}»`);
  assert.ok(DESFECHOS['unidade-pausada']);
});

test('robô: só liga com CHATWOOT_SOFIA_COMO_BOT=1 E token válido', () => {
  assert.equal(tokenDoRobo({}), null);
  assert.equal(tokenDoRobo({ CHATWOOT_SOFIA_BOT_TOKEN: 'abcdefghijklmnop' }), null, 'sem a chave de ligar');
  assert.equal(tokenDoRobo({ CHATWOOT_SOFIA_COMO_BOT: '1' }), null, 'sem token');
  assert.equal(tokenDoRobo({ CHATWOOT_SOFIA_COMO_BOT: '1', CHATWOOT_SOFIA_BOT_TOKEN: 'curto' }), null);
  assert.equal(tokenDoRobo({ CHATWOOT_SOFIA_COMO_BOT: '1', CHATWOOT_SOFIA_BOT_TOKEN: 'abcdefghijklmnop' }), 'abcdefghijklmnop');
});

test('robô: a resposta sai com o token do ROBÔ (usuário null) e a passagem abre a conversa para a equipe', async () => {
  const chamadas: Array<{ url: string; metodo: string; token: string | undefined; corpo: unknown }> = [];
  const falso = (async (url: string, init: any) => {
    chamadas.push({ url, metodo: init.method, token: init.headers?.api_access_token, corpo: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 901, sender: { id: 1, type: 'agent_bot' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const base = criarContextoChatwoot({ url: 'https://cw.exemplo.test', conta: 1, token: 'token-do-usuario' });
  const robo = portaDoRobo(base, 'token-do-robo-123', { fetch: falso })!;
  const r = await robo.publica(55, 'Oi!');
  assert.deepEqual(r, { usuario: null, mensagem: 901 }, 'o id 1 do robô não pode virar «usuário da integração» (colide com o usuário 1)');
  await robo.abrirParaEquipe(55);
  assert.equal(chamadas[0]!.token, 'token-do-robo-123');
  assert.match(chamadas[0]!.url, /\/api\/v1\/accounts\/1\/conversations\/55\/messages$/);
  assert.deepEqual(chamadas[0]!.corpo, { content: 'Oi!', message_type: 'outgoing', private: false });
  assert.match(chamadas[1]!.url, /\/conversations\/55\/toggle_status$/);
  assert.deepEqual(chamadas[1]!.corpo, { status: 'open' });
  assert.equal(portaDoRobo(criarContextoChatwoot(null), 'token-do-robo-123'), null);
});
