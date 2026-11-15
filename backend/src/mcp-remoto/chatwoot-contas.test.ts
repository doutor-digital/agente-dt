/**
 * Passo 5 — o conector (claude.ai) e as contas do Chatwoot. Padrão: a conta 1 (Parauapebas), IGUAL a antes. O parâmetro `conta` só vale para
 * quem a Doutor Digital autorizou (MCP_CHATWOOT_CONTAS_EMAILS); para os demais é recusado SEM falar com o Chatwoot.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const C = await import('./chatwoot.js');
const U = await import('../lib/chatwoot-unidades.js');

const DEMO = {
  slug: 'clinica-demonstracao',
  contaId: 2,
  prefixoModelos: 'demo_',
  usuarioCelularId: 77,
  gerenteId: 51,
  metaAgendamentosDia: 5,
  kapsoPhoneNumberId: '404404404404',
  wabaId: '999888777666555',
  envSufixo: 'DEMO',
  dadosModelos: { nome: 'Clínica Demonstração', cidade: 'Demonstração', endereco: 'Rua Exemplo, 100 — Centro, Demonstração/PA', mapa: 'https://maps.example/demo' },
  caixas: [{ id: 20, tipo: 'cloud' as const }],
};
const ENV = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test', CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo' };
const SALVO = { ...process.env };

function montar(escolheConta: boolean, usuario = 'pessoa@example.com') {
  Object.assign(process.env, ENV);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
  const chamadas: Array<{ metodo: string; url: string; token: string | undefined; corpo: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    chamadas.push({ metodo: String(init.method), url: String(url), token: (init.headers as Record<string, string>).api_access_token, corpo: init.body ? JSON.parse(String(init.body)) : undefined });
    const conta = /accounts\/(\d+)/.exec(String(url))?.[1];
    return new Response(JSON.stringify({ payload: [{ nome: conta === '2' ? 'SEGREDO-DA-CONTA-2' : 'dado-da-conta-1' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(), { fetch: f });
  const ferramentas = new Map<string, { schema: Record<string, unknown>; cb: (a: any) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>();
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean }> = [];
  const server = { registerTool: (id: string, def: { inputSchema: Record<string, unknown> }, cb: never) => void ferramentas.set(id, { schema: def.inputSchema, cb }) } as unknown as McpServer;
  C.registrarFerramentasChatwoot(server, ctx, usuario, (r) => auditoria.push(r as never), escolheConta);
  const chamar = (id: string, args: Record<string, unknown> = {}) => ferramentas.get(id)!.cb(args);
  return { chamadas, ferramentas, chamar, auditoria };
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SALVO)) delete process.env[k];
  Object.assign(process.env, SALVO);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
});

/** Um pedido válido para cada ferramenta que fala com o Chatwoot. */
const PEDIDOS: Array<[string, Record<string, unknown>]> = [
  ['chatwoot_conta', {}],
  ['chatwoot_conversas', { status: 'open' }],
  ['chatwoot_mensagens', { conversaId: 5 }],
  ['chatwoot_contatos', { busca: 'maria' }],
  ['chatwoot_caixas', {}],
  ['chatwoot_etiquetas', {}],
  ['chatwoot_agentes', {}],
  ['chatwoot_equipes', {}],
  ['chatwoot_api', { metodo: 'POST', caminho: 'labels', corpo: { title: 'x' } }],
  ['chatwoot_preparar', { metodo: 'DELETE', caminho: 'labels/3' }],
  ['chatwoot_confirmar', { codigo: 'ABCDEF123456' }],
];

test('IDENTIDADE: sem `conta`, TODA ferramenta vai na conta 1 com o token do ambiente — para quem não escolhe conta e para quem escolhe', async () => {
  for (const escolhe of [false, true]) {
    const t = montar(escolhe);
    for (const [id, args] of PEDIDOS) {
      t.chamadas.length = 0;
      await t.chamar(id, args);
      if (id === 'chatwoot_preparar' || id === 'chatwoot_confirmar') continue; // não falam com o Chatwoot / código inexistente
      assert.equal(t.chamadas.length, 1, `${id} (escolhe=${escolhe})`);
      assert.match(t.chamadas[0]!.url, /^https:\/\/crm\.exemplo\.test\/api\/v1\/accounts\/1(\/|$|\?)/, id);
      assert.equal(t.chamadas[0]!.token, 'tk-do-ambiente', id);
    }
  }
});

test('IDENTIDADE: a conta do ambiente pedida pelo número (conta=1) é a mesma coisa que não pedir, até para quem não escolhe conta', async () => {
  const t = montar(false);
  const r = await t.chamar('chatwoot_caixas', { conta: 1 });
  assert.equal(r.isError, undefined);
  assert.match(t.chamadas[0]!.url, /accounts\/1\/inboxes$/);
});

test('só quem escolhe conta vê `chatwoot_contas`; as demais ferramentas são as mesmas (mais o `conta` opcional)', () => {
  const sem = montar(false);
  const com = montar(true);
  assert.equal(sem.ferramentas.has('chatwoot_contas'), false);
  assert.equal(com.ferramentas.has('chatwoot_contas'), true);
  assert.deepEqual([...sem.ferramentas.keys()].sort(), [...com.ferramentas.keys()].filter((k) => k !== 'chatwoot_contas').sort());
  for (const [id] of PEDIDOS) assert.ok('conta' in sem.ferramentas.get(id)!.schema, `${id} aceita conta`);
});

test('ATAQUE: quem NÃO foi autorizado pedindo conta=2 (ou 99) em QUALQUER ferramenta é recusado, sem falar com o Chatwoot e sem vazar dado', async () => {
  const t = montar(false, 'lia@example.com');
  for (const conta of [2, 99]) {
    for (const [id, args] of PEDIDOS) {
      const r = await t.chamar(id, { ...args, conta });
      assert.equal(r.isError, true, `${id} conta=${conta}`);
      assert.match(r.content[0]!.text, /não está autorizada a escolher outra conta/, `${id} conta=${conta}`);
      assert.doesNotMatch(r.content[0]!.text, /SEGREDO|dado-da-conta|tk-/, id);
    }
  }
  assert.deepEqual(t.chamadas, [], 'nenhuma chamada ao Chatwoot');
  assert.ok(t.auditoria.every((a) => !a.ok), 'tudo auditado como recusa');
  assert.ok(t.auditoria.some((a) => a.argumentos.conta === 2), 'a auditoria guarda a conta pedida');
});

test('autorizado: conta=2 vai na conta 2 com o token DELA (nunca o do ambiente); conta que ninguém usa é recusada sem chamar', async () => {
  const t = montar(true, 'joao@example.com');
  for (const [id, args] of PEDIDOS.filter(([i]) => !['chatwoot_preparar', 'chatwoot_confirmar'].includes(i))) {
    t.chamadas.length = 0;
    const r = await t.chamar(id, { ...args, conta: 2 });
    assert.equal(r.isError, undefined, id);
    assert.equal(t.chamadas.length, 1, id);
    assert.match(t.chamadas[0]!.url, /accounts\/2(\/|$|\?)/, id);
    assert.equal(t.chamadas[0]!.token, 'tk-so-da-demo', id);
  }
  t.chamadas.length = 0;
  const r = await t.chamar('chatwoot_caixas', { conta: 99 });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /conta 99 desconhecida/);
  assert.deepEqual(t.chamadas, []);
});

test('autorizado: `chatwoot_contas` lista as contas e as unidades de cada uma, sem token', async () => {
  const t = montar(true);
  const r = await t.chamar('chatwoot_contas');
  const lista = JSON.parse(r.content[0]!.text) as Array<{ conta: number; padrao: boolean; unidades: string[] }>;
  assert.deepEqual(lista, [
    { conta: 1, padrao: true, unidades: [U.SEMENTE_PARAUAPEBAS.slug] },
    { conta: 2, padrao: false, unidades: ['clinica-demonstracao'] },
  ]);
  assert.doesNotMatch(r.content[0]!.text, /tk-/);
  assert.deepEqual(t.chamadas, []);
});

test('dois passos: o código preparado na conta 2 só confirma na conta 2 (e mostra a conta); na conta 1 é «desconhecido»', async () => {
  const t = montar(true, 'joao@example.com');
  const p = await t.chamar('chatwoot_preparar', { metodo: 'DELETE', caminho: 'labels/3', conta: 2 });
  const prep = JSON.parse(p.content[0]!.text) as { codigo: string; vaiFazer: string };
  assert.match(prep.vaiFazer, /\(conta 2\)/);
  assert.deepEqual(t.chamadas, [], 'preparar não executa');
  const errado = await t.chamar('chatwoot_confirmar', { codigo: prep.codigo });
  assert.equal(errado.isError, true);
  assert.match(errado.content[0]!.text, /código desconhecido/);
  assert.deepEqual(t.chamadas, [], 'sem a conta, nada foi apagado em lugar nenhum');
  const certo = await t.chamar('chatwoot_confirmar', { codigo: prep.codigo, conta: 2 });
  assert.equal(certo.isError, undefined);
  const feitas: Array<{ url: string; metodo: string }> = [...(t.chamadas as Array<{ url: string; metodo: string }>)];
  assert.equal(feitas.length, 1);
  assert.match(feitas[0]!.url, /accounts\/2\/labels\/3$/);
  assert.equal(feitas[0]!.metodo, 'DELETE');
});

test('dois passos: o código da conta 1 não apaga nada na conta 2', async () => {
  const t = montar(true, 'joao@example.com');
  const prep = JSON.parse((await t.chamar('chatwoot_preparar', { metodo: 'DELETE', caminho: 'labels/3' })).content[0]!.text) as { codigo: string };
  const r = await t.chamar('chatwoot_confirmar', { codigo: prep.codigo, conta: 2 });
  assert.equal(r.isError, true);
  assert.deepEqual(t.chamadas, []);
});

test('o caminho continua preso à conta: `../2/…` e afins são recusados mesmo na conta padrão', async () => {
  const t = montar(false);
  for (const caminho of ['../2/inboxes', 'accounts/2/inboxes', 'api/v1/accounts/2/inboxes']) {
    const r = await t.chamar('chatwoot_api', { metodo: 'GET', caminho });
    assert.equal(r.isError, true, caminho);
  }
  assert.deepEqual(t.chamadas, []);
});
