/**
 * Passo 5 — o conector (claude.ai) e as contas do Chatwoot. Padrão: a conta 1 (Parauapebas), IGUAL a antes. O parâmetro `conta` só vale para
 * quem a Doutor Digital autorizou (MCP_CHATWOOT_CONTAS_EMAILS); para os demais é recusado SEM falar com o Chatwoot.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

function montar(escolheConta: boolean | (() => boolean), usuario = 'pessoa@example.com') {
  Object.assign(process.env, ENV);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
  const chamadas: Array<{ metodo: string; url: string; token: string | undefined; corpo: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    chamadas.push({ metodo: String(init.method), url: String(url), token: (init.headers as Record<string, string>).api_access_token, corpo: init.body ? JSON.parse(String(init.body)) : undefined });
    const conta = /accounts\/(\d+)/.exec(String(url))?.[1];
    return new Response(JSON.stringify({ payload: [{ nome: conta === '2' ? 'SEGREDO-DA-CONTA-2' : 'dado-da-conta-1' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(), { fetch: f });
  const ferramentas = new Map<string, { schema: Record<string, unknown>; descricao: string; cb: (a: any) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>();
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean }> = [];
  const server = { registerTool: (id: string, def: { inputSchema: Record<string, unknown>; description: string }, cb: never) => void ferramentas.set(id, { schema: def.inputSchema, descricao: def.description, cb }) } as unknown as McpServer;
  C.registrarFerramentasChatwoot(server, ctx, usuario, (r) => auditoria.push(r as never), escolheConta);
  const chamar = (id: string, args: Record<string, unknown> = {}) => ferramentas.get(id)!.cb(args);
  /** o caminho de VERDADE: um McpServer e um Client do SDK ligados em memória (a validação do schema acontece aqui, não na função da ferramenta) */
  const viaSdk = async (escolhe: boolean | (() => boolean), quem = usuario) => {
    const srv = new McpServer({ name: 'teste', version: '1.0.0' });
    C.registrarFerramentasChatwoot(srv, ctx, quem, (r) => auditoria.push(r as never), escolhe);
    const cliente = new Client({ name: 'cliente', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([srv.connect(a), cliente.connect(b)]);
    return cliente;
  };
  return { chamadas, ferramentas, chamar, auditoria, viaSdk };
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

test('QUEM NÃO ESCOLHE CONTA vê o conector EXATAMENTE como era: sem `conta` em schema nenhum, sem `chatwoot_contas`, textos de sempre', async () => {
  const sem = montar(false);
  const com = montar(true);
  assert.equal(sem.ferramentas.has('chatwoot_contas'), false);
  assert.equal(com.ferramentas.has('chatwoot_contas'), true);
  assert.deepEqual([...sem.ferramentas.keys()].sort(), [...com.ferramentas.keys()].filter((k) => k !== 'chatwoot_contas').sort());
  for (const [id] of PEDIDOS) {
    assert.ok(!('conta' in sem.ferramentas.get(id)!.schema), `${id}: sem permissão não tem o parâmetro conta`);
    assert.ok('conta' in com.ferramentas.get(id)!.schema, `${id}: com permissão tem`);
  }
  // os mesmos campos de antes, em cada ferramenta
  assert.deepEqual(Object.keys(sem.ferramentas.get('chatwoot_api')!.schema).sort(), ['caminho', 'corpo', 'metodo', 'query']);
  assert.deepEqual(Object.keys(sem.ferramentas.get('chatwoot_confirmar')!.schema), ['codigo']);
  // nenhum texto fala em escolher conta
  for (const [, f] of sem.ferramentas) assert.ok(!/mesma "conta"|passe a mesma|"conta"/i.test(f.descricao), f.descricao.slice(0, 60));
  assert.ok(com.ferramentas.get('chatwoot_preparar')!.descricao.includes('MESMA "conta"'));
  // o que a pessoa lê ao preparar e ao confirmar um código errado: igual ao de antes
  const p = JSON.parse((await sem.chamar('chatwoot_preparar', { metodo: 'DELETE', caminho: 'labels/3' })).content[0]!.text) as { vaiFazer: string };
  assert.equal(p.vaiFazer, 'DELETE labels/3 — apaga');
  assert.equal((await sem.chamar('chatwoot_confirmar', { codigo: 'ABCDEF123456' })).content[0]!.text, 'Pedido inválido: código desconhecido ou já usado — prepare de novo');
});

test('PERMISSÃO CONFERIDA A CADA CHAMADA: tirar o e-mail da lista corta a escolha de conta NA HORA, mesmo com a sessão já aberta', async () => {
  let pode = true;
  const t = montar(() => pode, 'joao@example.com');
  assert.equal((await t.chamar('chatwoot_caixas', { conta: 2 })).isError, undefined, 'com permissão: abre a conta 2');
  assert.equal(t.chamadas.length, 1);
  pode = false; // saiu da lista
  const r = await t.chamar('chatwoot_caixas', { conta: 2 });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /não está autorizada/);
  assert.equal((await t.chamar('chatwoot_contas')).isError, true, 'nem a lista de contas');
  assert.equal(t.chamadas.length, 1, 'nenhuma chamada nova ao Chatwoot');
  // a conta padrão continua funcionando para quem perdeu a permissão
  assert.equal((await t.chamar('chatwoot_caixas')).isError, undefined);
  pode = true; // voltou
  assert.equal((await t.chamar('chatwoot_caixas', { conta: 2 })).isError, undefined);
});

// DEFESA EM PROFUNDIDADE: chama a função da ferramenta DIRETO (sem o SDK). No servidor de verdade o SDK já descarta o `conta` de quem não tem o parâmetro no
// schema (ver os testes «SDK» abaixo); esta recusa é a segunda barreira, para o caso de a função ser chamada por outro caminho.
test('defesa em profundidade: chamada DIRETA à função de quem NÃO foi autorizado, com conta=2 (ou 99), é recusada, sem falar com o Chatwoot e sem vazar dado', async () => {
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
  const lista = JSON.parse(r.content[0]!.text) as Array<{ conta: number; padrao: boolean; usavel: boolean; unidades: string[] }>;
  assert.deepEqual(lista, [
    { conta: 1, padrao: true, usavel: true, unidades: [U.SEMENTE_PARAUAPEBAS.slug] },
    { conta: 2, padrao: false, usavel: true, unidades: ['clinica-demonstracao'] },
  ]);
  assert.doesNotMatch(r.content[0]!.text, /tk-/);
  assert.deepEqual(t.chamadas, []);
});

test('dois passos: o código preparado na conta 2 só confirma na conta 2 (e mostra a conta); na conta 1 é «desconhecido»', async () => {
  const t = montar(true, 'joao@example.com');
  const p = await t.chamar('chatwoot_preparar', { metodo: 'DELETE', caminho: 'labels/3', conta: 2 });
  const prep = JSON.parse(p.content[0]!.text) as { codigo: string; vaiFazer: string };
  assert.match(prep.vaiFazer, /\(conta 2 · clinica-demonstracao\)/);
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

test('autorizado, mas a clínica ainda NÃO tem token próprio: recusa (nunca usa o token de Parauapebas em outra conta)', async () => {
  const t = montar(true, 'joao@example.com');
  delete process.env.CHATWOOT_API_TOKEN_DEMO;
  const r = await t.chamar('chatwoot_caixas', { conta: 2 });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /ainda não tem token próprio/);
  assert.deepEqual(t.chamadas, []);
});

test('unidade que declara a mesma conta do ambiente: conta=1 continua sendo a padrão (mesmo contexto, mesmas confirmações pendentes)', async () => {
  const t = montar(false);
  U.aplicarConfigs([{ ...U.SEMENTE_PARAUAPEBAS, contaId: undefined } as never, { ...DEMO, contaId: 1, slug: 'outra-na-conta-1', caixas: [{ id: 21, tipo: 'cloud' as const }] } as never]);
  const p = JSON.parse((await t.chamar('chatwoot_preparar', { metodo: 'DELETE', caminho: 'labels/3' })).content[0]!.text) as { codigo: string };
  const r = await t.chamar('chatwoot_confirmar', { codigo: p.codigo, conta: 1 });
  assert.equal(r.isError, undefined, 'o código preparado sem conta confirma com conta=1');
});

test('duas clínicas na MESMA conta, só a segunda com token próprio: a conta é usável (não depende de qual vem primeiro)', async () => {
  const t = montar(true, 'joao@example.com');
  const a = { ...DEMO, slug: 'a-clinica', envSufixo: 'AAA', caixas: [{ id: 30, tipo: 'cloud' as const }] };
  const b = { ...DEMO, slug: 'b-clinica', envSufixo: 'BBB', caixas: [{ id: 31, tipo: 'cloud' as const }] };
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, a as never, b as never]);
  process.env.CHATWOOT_API_TOKEN_BBB = 'tk-da-bbb';
  const r = await t.chamar('chatwoot_caixas', { conta: 2 });
  assert.equal(r.isError, undefined);
  const feitas = [...(t.chamadas as Array<{ token?: string }>)];
  assert.equal(feitas[0]!.token, 'tk-da-bbb');
  const lista = JSON.parse((await t.chamar('chatwoot_contas')).content[0]!.text) as Array<{ conta: number; usavel: boolean }>;
  assert.equal(lista.find((x) => x.conta === 2)!.usavel, true);
});

test('chatwoot_contas marca como NÃO usável a conta sem token próprio', async () => {
  const t = montar(true);
  delete process.env.CHATWOOT_API_TOKEN_DEMO;
  const lista = JSON.parse((await t.chamar('chatwoot_contas')).content[0]!.text) as Array<{ conta: number; usavel: boolean }>;
  assert.equal(lista.find((x) => x.conta === 2)!.usavel, false);
  assert.equal(lista.find((x) => x.conta === 1)!.usavel, true);
});

// ── pelo caminho do SDK de verdade (McpServer + Client em memória) ─────────────────────────────────────────

test('SDK (o que acontece DE FATO): sem permissão o `conta` é APAGADO pelo schema antes de chegar à função — a chamada cai em Parauapebas, sem erro, exatamente como era antes deste PR', async () => {
  const t = montar(false, 'lia@example.com');
  const cliente = await t.viaSdk(false);
  const tools = (await cliente.listTools()).tools;
  assert.ok(tools.length >= 9);
  for (const f of tools) assert.ok(!('conta' in ((f.inputSchema.properties ?? {}) as object)), `${f.name} não anuncia conta`);
  assert.ok(!tools.some((f) => f.name === 'chatwoot_contas'));
  const r = await cliente.callTool({ name: 'chatwoot_caixas', arguments: { conta: 2 } });
  assert.notEqual(r.isError, true, 'sem erro: o parâmetro desconhecido é descartado, não recusado');
  assert.equal(t.chamadas.length, 1);
  assert.match(t.chamadas[0]!.url, /\/accounts\/1\/inboxes$/, 'foi para a conta 1 (Parauapebas), nunca para a 2');
  assert.equal(t.chamadas[0]!.token, 'tk-do-ambiente');
  assert.doesNotMatch(JSON.stringify(r.content), /SEGREDO/);
  assert.ok(t.auditoria.every((a) => !('conta' in (a.argumentos ?? {}))), 'a auditoria nem vê o parâmetro (já foi descartado)');
});

test('SDK: com permissão o `conta` é anunciado e vale; tirar a permissão no meio da sessão recusa na hora', async () => {
  let pode = true;
  const t = montar(() => pode, 'joao@example.com');
  const cliente = await t.viaSdk(() => pode);
  const tools = (await cliente.listTools()).tools;
  assert.ok(tools.find((f) => f.name === 'chatwoot_caixas')!.inputSchema.properties!.conta);
  assert.ok(tools.some((f) => f.name === 'chatwoot_contas'));
  const ok = await cliente.callTool({ name: 'chatwoot_caixas', arguments: { conta: 2 } });
  assert.notEqual(ok.isError, true);
  assert.match(t.chamadas.at(-1)!.url, /\/accounts\/2\/inboxes$/);
  pode = false;
  const negado = await cliente.callTool({ name: 'chatwoot_caixas', arguments: { conta: 2 } });
  assert.equal(negado.isError, true);
  assert.match(JSON.stringify(negado.content), /não está autorizada/);
  assert.equal(t.chamadas.length, 1, 'nenhuma chamada nova depois de perder a permissão');
});

test('Telegram: envio a paciente numa clínica de OUTRA conta também avisa o João (como o apagar); em Parauapebas, nada muda', async () => {
  const avisos: string[] = [];
  const montarComAviso = (escolhe: boolean) => {
    Object.assign(process.env, ENV);
    U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
    const f = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(), { fetch: f, avisar: (t) => void avisos.push(t) });
    const srv = new McpServer({ name: 't', version: '1' });
    C.registrarFerramentasChatwoot(srv, ctx, 'joao@example.com', () => undefined, escolhe);
    return ctx;
  };
  const ctx = montarComAviso(true);
  const corpo = { content: 'oi paciente' };
  const dona = C.contextoDaChamada(ctx, 2, true);
  const prep = C.preparar(dona, 'joao@example.com', { metodo: 'POST', caminho: 'conversations/5/messages', corpo });
  await C.confirmar(dona, 'joao@example.com', prep.codigo, true);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /✉️ Chatwoot \(conta 2 · clinica-demonstracao\): joao@example.com mandou/);
  const p1 = C.preparar(ctx, 'joao@example.com', { metodo: 'POST', caminho: 'conversations/5/messages', corpo });
  await C.confirmar(ctx, 'joao@example.com', p1.codigo);
  assert.equal(avisos.length, 1, 'em Parauapebas não há aviso novo (como era)');
});
