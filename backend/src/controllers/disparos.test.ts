/**
 * Tela «Disparos»: a página (parseia, só fala com a origem do Chatwoot, nada de innerHTML com dado do servidor, rotas certas), o item no menu
 * do Chatwoot, as rotas — com o servidor de verdade e um Chatwoot de mentira: quem aprova, o ajuste que só a Doutor Digital muda, onda de OUTRA
 * clínica = «não encontrada», e a caixa que NÃO é WhatsApp oficial (Clínica Demonstração) recusada.
 * O ataque conta 1 → conta 2 = 403 de TODAS estas rotas está em `lib/conta-da-requisicao.test.ts` (a lista de rotas é lida do roteador).
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import express from 'express';
import { prisma } from '../lib/prisma.js';

const { paginaDosDisparos } = await import('../lib/disparos-pagina.js');
const { montarMenuJs } = await import('./funil.controller.js');
const U = await import('../lib/chatwoot-unidades.js');
const R = await import('../lib/conta-da-requisicao.js');
const { apiRouter } = await import('../routes/api.routes.js');

const CW = 'https://atendimento.exemplo.test';

// ── a página ────────────────────────────────────────────────────────────────────────────────────────────────────

function scriptDaPagina(): string {
  const html = paginaDosDisparos(CW);
  const partes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.ok(partes.length >= 1);
  return partes[partes.length - 1]!;
}

test('a página dos Disparos parseia, só aceita a origem do Chatwoot, usa o molde (Inter, claro/escuro) e não usa innerHTML', () => {
  const html = paginaDosDisparos(CW);
  assert.doesNotThrow(() => new Function(scriptDaPagina()));
  assert.ok(html.includes(`origemDoPai(${JSON.stringify(CW)})`), 'a sessão só vem do pai na origem do Chatwoot');
  assert.ok(html.includes('origemDoCrm(ev.origin) || ev.source !== window.parent'));
  assert.ok(!html.includes('__ORIGEM_CW__') && !html.includes('__LOGO_DD__') && !html.includes('__CONTA_JS__') && !html.includes('__ORIGENS_CW__'), 'nenhum marcador sobrou');
  assert.ok(html.includes('family=Inter') && html.includes('prefers-color-scheme:dark') && html.includes('--brand:#2781f6'), 'o mesmo molde das telas Robôs/Agente');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(scriptDaPagina()), 'dado do servidor entra por textContent');
  assert.ok(!scriptDaPagina().includes('`') && !scriptDaPagina().includes('${'), 'a página é um String.raw: sem crase nem ${');
  assert.ok(html.includes('X-CW-Token') && html.includes('comConta('), 'login do Chatwoot e ?conta=N em toda chamada');
});

test('a página usa as rotas dos Disparos e as rotas existem no roteador e no servidor', () => {
  const js = scriptDaPagina();
  for (const rota of ["'/api/public/disparos?slug='", "'/api/public/disparos/opcoes?slug='", "'/api/public/disparos/contar'", "'/api/public/disparos/ondas'", "'/api/public/disparos/ondas/'", "'/aprovar'", "'/cancelar'", "'/api/public/disparos/ajuste'", "'/api/public/testar-ia/unidades'"]) {
    assert.ok(js.includes(rota), rota);
  }
  const rotas = readFileSync(new URL('../routes/api.routes.ts', import.meta.url), 'utf8');
  for (const r of [
    "apiRouter.get('/public/disparos', disparosHandler)",
    "apiRouter.get('/public/disparos/opcoes', disparosOpcoesHandler)",
    "apiRouter.post('/public/disparos/contar', disparosContarHandler)",
    "apiRouter.post('/public/disparos/ondas', disparosMontarHandler)",
    "apiRouter.get('/public/disparos/ondas/:id', disparosOndaHandler)",
    "apiRouter.post('/public/disparos/ondas/:id/aprovar', disparosAprovarHandler)",
    "apiRouter.post('/public/disparos/ondas/:id/cancelar', disparosCancelarHandler)",
    "apiRouter.post('/public/disparos/ajuste', disparosAjusteHandler)",
  ]) assert.ok(rotas.includes(r), r);
  assert.ok(readFileSync(new URL('../server.ts', import.meta.url), 'utf8').includes("app.get('/funil/disparos', paginaDisparosHandler)"));
});

test('a página mostra o modo seco, o que o aprovar faz em seco e a prévia por pessoa; aprovar sem poder fica desligado', () => {
  const js = scriptDaPagina();
  assert.ok(js.includes('MODO SECO') && js.includes('NÃO manda mensagem nenhuma'));
  assert.ok(js.includes('Prévia para') && js.includes('Primeiro nome do contato'));
  assert.ok(js.includes('ba.disabled = !(o.podeAprovar && o.conferencia && o.conferencia.ok)'));
  assert.ok(js.includes('Sem caixa de WhatsApp oficial'), 'unidade sem caixa oficial vê o porquê, não um formulário que não funciona');
});

test('o menu do Chatwoot ganha «Disparos» (url /funil/disparos, ícone próprio) e o menu.js continua parseando', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("nome: 'Disparos'") && js.includes("url: '/funil/disparos'") && js.includes("marca: 'data-disparos-menu'"));
  assert.ok(js.includes('ICONES.disparos'));
  assert.ok(js.includes("nome: 'Robôs'") && js.includes("nome: 'Agente'"), 'as outras telas continuam');
});

// ── o servidor de verdade, com Chatwoot e banco de mentira ──────────────────────────────────────────────────────

const PARAU = U.SEMENTE_PARAUAPEBAS.slug;
const DEMO = {
  slug: 'clinica-demonstracao', contaId: 2, prefixoModelos: 'demo_', usuarioCelularId: 77, gerenteId: 51, metaAgendamentosDia: 5, kapsoPhoneNumberId: '404404404404', wabaId: '999888777666555', envSufixo: 'DEMO',
  dadosModelos: { nome: 'Clínica Demonstração', cidade: 'Demonstração', endereco: 'Rua Exemplo, 100 — Centro, Demonstração/PA', mapa: 'https://maps.example/demo' },
  caixas: [{ id: 6, tipo: 'cloud' as const }],
};
const AMBIENTE = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test', CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo', KIT_ADMINS_DD: 'suzanne.mychelly1@gmail.com,doutordigitalconsultoria@gmail.com' };
const SALVO = { ...process.env };

const PERFIS: Record<string, { id: number; name: string; email: string; accounts: Array<{ id: number; role: string }> }> = {
  'tok-agente': { id: 7, name: 'Ana Atendente', email: 'ana@clinica.com', accounts: [{ id: 1, role: 'agent' }] },
  'tok-gerente': { id: 8, name: 'Gabi Gerente', email: 'gerente@clinica.com', accounts: [{ id: 1, role: 'administrator' }] },
  'tok-dd': { id: 9, name: 'Suzanne', email: 'suzanne.mychelly1@gmail.com', accounts: [{ id: 1, role: 'administrator' }, { id: 2, role: 'administrator' }] },
  'tok-demo': { id: 10, name: 'Bia Demo', email: 'bia@demo.com', accounts: [{ id: 2, role: 'administrator' }] },
};
let chamadas: string[] = [];
/** Caminhos que o Chatwoot de mentira NUNCA responde (para provar o teto de tempo). */
let travar: RegExp | null = null;
/** Caminhos a que o Chatwoot de mentira responde 401 (token caído). */
let recusar: RegExp | null = null;
const fetchReal = globalThis.fetch;
const MODELO_OK = { name: 'parau_reativacao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Oi {{1}}, tudo bem?' }] };

function chatwootDeMentira() {
  return (async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(String(url));
    chamadas.push(`${o.method ?? 'GET'} ${u.pathname}`);
    if (travar && travar.test(u.pathname)) return new Promise<Response>(() => undefined);
    const resp = (status: number, j: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(j), json: async () => j }) as Response;
    if (recusar && recusar.test(u.pathname)) return resp(401, { error: 'token' });
    if (u.pathname === '/api/v1/profile') {
      const p = PERFIS[o.headers?.['access-token'] ?? ''];
      return p ? resp(200, p) : resp(401, { error: 'x' });
    }
    const conta = /\/accounts\/(\d+)\//.exec(u.pathname)?.[1];
    if (/\/inboxes$/.test(u.pathname)) {
      return resp(200, { payload: conta === '2' ? [{ id: 6, name: 'API da demonstração', channel_type: 'Channel::Api' }] : [{ id: 3, name: 'WhatsApp Parauapebas', channel_type: 'Channel::Whatsapp', provider: 'whatsapp_cloud' }, { id: 2, name: 'Celular', channel_type: 'Channel::Api' }] });
    }
    if (/\/inboxes\/3\/message_templates$/.test(u.pathname)) return resp(200, { payload: [MODELO_OK, { ...MODELO_OK, name: 'parau_pausado', status: 'PAUSED' }, { ...MODELO_OK, name: 'parau_imagem', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Oi' }] }] });
    if (/\/labels$/.test(u.pathname)) return resp(200, { payload: [{ title: 'lead-frio' }, { title: 'sem-follow-up' }] });
    if (/\/custom_attribute_definitions$/.test(u.pathname)) return resp(200, [{ attribute_key: 'etapa', attribute_display_name: 'Etapa', attribute_values: ['Perdido', 'Frio'] }]);
    if (/\/conversations$/.test(u.pathname)) return resp(200, { data: { payload: [], meta: {} } });
    return resp(200, { payload: [] });
  }) as unknown as typeof fetch;
}

let servidor: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  servidor = createServer(app);
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => servidor.close(r));
});

const originais = new Map<string, PropertyDescriptor | undefined>();
function falso(modelo: string, metodos: Record<string, unknown>): void {
  if (!originais.has(modelo)) originais.set(modelo, Object.getOwnPropertyDescriptor(prisma, modelo));
  Object.defineProperty(prisma, modelo, { value: metodos, configurable: true, writable: true });
}
const UNIDADES: Record<string, Record<string, unknown>> = {
  [PARAU]: { id: 'u1', slug: PARAU, name: 'Doutor Hérnia Parauapebas', isActive: true, spineToken: 'spine', spineTimezone: 'America/Belem' },
  [DEMO.slug]: { id: 'u2', slug: DEMO.slug, name: 'Clínica Demonstração', isActive: true, spineToken: null, spineTimezone: 'America/Belem' },
};
let ajusteGravado: Record<string, unknown> | null = null;
const consultasDeOnda: Array<Record<string, unknown>> = [];
function preparar(opcoes: { gerenteAprova?: boolean; onda?: Record<string, unknown> | null } = {}) {
  Object.assign(process.env, AMBIENTE);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
  R.esquecerContextoDoAmbiente();
  chamadas = [];
  ajusteGravado = null;
  consultasDeOnda.length = 0;
  mock.method(globalThis, 'fetch', (async (url: string, o: never) => (String(url).startsWith(base) ? fetchReal(url, o) : chatwootDeMentira()(url, o))) as never);
  falso('unit', { findUnique: async (a: { where: { slug: string } }) => UNIDADES[a.where.slug] ?? null });
  falso('chatwootDisparoAjuste', {
    findUnique: async () => (opcoes.gerenteAprova ? { gerenteAprova: true, tierDoNumero: 'TIER_250' } : null),
    upsert: async (a: { create: Record<string, unknown>; update: Record<string, unknown> }) => ((ajusteGravado = { ...a.create, ...a.update }), { gerenteAprova: a.update.gerenteAprova ?? a.create.gerenteAprova ?? false, tierDoNumero: a.update.tierDoNumero ?? a.create.tierDoNumero ?? null }),
  });
  falso('disparoOnda', {
    findMany: async () => [],
    findFirst: async (a: { where: Record<string, unknown> }) => (consultasDeOnda.push(a.where), opcoes.onda ?? null),
  });
  falso('disparoDestinatario', { groupBy: async () => [], findMany: async () => [] });
}
afterEach(() => {
  travar = null;
  recusar = null;
  mock.restoreAll();
  for (const [modelo, d] of originais) {
    if (d) Object.defineProperty(prisma, modelo, d);
    else delete (prisma as unknown as Record<string, unknown>)[modelo];
  }
  originais.clear();
  for (const k of Object.keys(process.env)) if (!(k in SALVO)) delete process.env[k];
  Object.assign(process.env, SALVO);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  R.esquecerContextoDoAmbiente();
});

async function pedir(metodo: 'GET' | 'POST', caminho: string, token: string, corpo?: unknown, conta = '') {
  const url = `${base}/api${caminho}${caminho.includes('?') ? '&' : '?'}${conta ? `conta=${conta}` : ''}`;
  const r = await fetchReal(url, { method: metodo, headers: { 'content-type': 'application/json', 'X-CW-Token': token, 'X-CW-Client': 'c', 'X-CW-Uid': 'x@x.com' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  return { status: r.status, corpo: (await r.json().catch(() => ({}))) as any };
}

test('GET /disparos: a unidade nasce em SECO; a atendente vê mas não aprova nem ajusta; a administração da Doutor Digital aprova e ajusta', async () => {
  preparar();
  const agente = await pedir('GET', `/public/disparos?slug=${PARAU}`, 'tok-agente');
  assert.equal(agente.status, 200);
  assert.equal(agente.corpo.modo, 'seco');
  assert.equal(agente.corpo.podeAprovar, false);
  assert.equal(agente.corpo.podeAjustar, false);
  assert.deepEqual(agente.corpo.caixas.map((c: any) => [c.id, c.oficial]), [[3, true]], 'só a caixa cloud; o celular (API) nem aparece');
  assert.equal(agente.corpo.freios.comAgenda, true);
  const gerente = await pedir('GET', `/public/disparos?slug=${PARAU}`, 'tok-gerente');
  assert.equal(gerente.corpo.podeAprovar, false, 'administradora da clínica NÃO aprova de fábrica');
  const dd = await pedir('GET', `/public/disparos?slug=${PARAU}`, 'tok-dd');
  assert.equal(dd.corpo.podeAprovar, true);
  assert.equal(dd.corpo.podeAjustar, true);
});

test('com o ajuste «gerente aprova» ligado, a administradora da clínica passa a poder aprovar — a atendente (agente) continua não podendo', async () => {
  preparar({ gerenteAprova: true });
  assert.equal((await pedir('GET', `/public/disparos?slug=${PARAU}`, 'tok-gerente')).corpo.podeAprovar, true);
  assert.equal((await pedir('GET', `/public/disparos?slug=${PARAU}`, 'tok-agente')).corpo.podeAprovar, false);
  assert.equal((await pedir('GET', `/public/disparos?slug=${PARAU}`, 'tok-gerente')).corpo.freios.tetoDoTier, 250);
});

test('aprovar: atendente e administradora (ajuste desligado) levam 403 ANTES de qualquer gravação; o id de outra unidade é «não encontrado»', async () => {
  preparar({ onda: null });
  const sem = await pedir('POST', '/public/disparos/ondas/abcdefghij12/aprovar', 'tok-dd', { slug: PARAU, total: 1, impressao: 'x' });
  assert.equal(sem.status, 404, 'onda que não é desta unidade/conta');
  assert.deepEqual(consultasDeOnda[0], { id: 'abcdefghij12', unitId: 'u1', origem: 'chatwoot', contaChatwoot: 1 }, 'a busca da onda leva a unidade E a conta da sessão');
  const onda = { id: 'abcdefghij12', unitId: 'u1', origem: 'chatwoot', estado: 'montada', contaChatwoot: 1, campanha: { nome: 'x' } };
  preparar({ onda });
  falso('disparoOnda', {
    findFirst: async () => onda,
    findUnique: async () => ({ ...onda, total: 1, impressao: 'x', template: 't', idioma: 'pt_BR', textoModelo: 'Oi', variaveis: [], unit: { id: 'u1', slug: PARAU }, caixaChatwoot: 3 }),
    updateMany: async () => {
      throw new Error('NÃO podia gravar a aprovação');
    },
  });
  for (const tok of ['tok-agente', 'tok-gerente']) {
    const r = await pedir('POST', '/public/disparos/ondas/abcdefghij12/aprovar', tok, { slug: PARAU, total: 1, impressao: 'x' });
    assert.equal(r.status, 403, tok);
    assert.match(r.corpo.error, /administração da Doutor Digital/);
  }
});

test('id de onda torto (não é o formato do banco) é «não encontrado» sem tocar o banco', async () => {
  preparar();
  for (const id of ['1', 'a b c d e f g h', '../../etc', 'x'.repeat(80)]) {
    consultasDeOnda.length = 0;
    const r = await pedir('GET', `/public/disparos/ondas/${encodeURIComponent(id)}?slug=${PARAU}`, 'tok-dd');
    assert.equal(r.status, 404, id);
    assert.deepEqual(consultasDeOnda, [], id);
  }
});

test('ajuste: só a Doutor Digital muda; TIER torto e valores que não são verdadeiro/falso são recusados; grava quem mudou', async () => {
  preparar();
  const nao = await pedir('POST', '/public/disparos/ajuste', 'tok-gerente', { slug: PARAU, gerenteAprova: true });
  assert.equal(nao.status, 403);
  assert.equal(ajusteGravado, null, 'a administradora da clínica não liga a própria aprovação');
  assert.equal((await pedir('POST', '/public/disparos/ajuste', 'tok-dd', { slug: PARAU, gerenteAprova: 'sim' })).status, 400);
  assert.equal((await pedir('POST', '/public/disparos/ajuste', 'tok-dd', { slug: PARAU, tierDoNumero: 'grande' })).status, 400);
  assert.equal((await pedir('POST', '/public/disparos/ajuste', 'tok-dd', { slug: PARAU })).status, 400, 'nada para mudar');
  const ok = await pedir('POST', '/public/disparos/ajuste', 'tok-dd', { slug: PARAU, gerenteAprova: true, tierDoNumero: 'tier_250' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.corpo.ajuste, { gerenteAprova: true, tierDoNumero: 'TIER_250' });
  assert.equal(ajusteGravado!.atualizadoPor, 'suzanne.mychelly1@gmail.com');
});

test('opções: etiquetas, atributos de lista e SÓ os modelos aprovados — o pausado nem aparece e o de mídia vem marcado como «não dá»', async () => {
  preparar();
  const r = await pedir('GET', `/public/disparos/opcoes?slug=${PARAU}&caixa=3`, 'tok-agente');
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.etiquetas, ['lead-frio', 'sem-follow-up']);
  assert.deepEqual(r.corpo.atributos.find((a: any) => a.chave === 'etapa').valores, ['Perdido', 'Frio']);
  assert.deepEqual(r.corpo.modelos.map((m: any) => [m.nome, m.problema === null]), [['parau_imagem', false], ['parau_reativacao', true]]);
  assert.equal((await pedir('GET', `/public/disparos/opcoes?slug=${PARAU}&caixa=2`, 'tok-agente')).status, 404, 'caixa do celular (API) não é opção');
  assert.equal((await pedir('GET', `/public/disparos/opcoes?slug=${PARAU}&caixa=99`, 'tok-agente')).status, 404);
});

test('a Clínica Demonstração (caixa de API registrada como «cloud»): a tela diz que não é WhatsApp oficial e contar/montar são RECUSADOS', async () => {
  preparar();
  const painel = await pedir('GET', `/public/disparos?slug=${DEMO.slug}`, 'tok-demo', undefined, '2');
  assert.equal(painel.status, 200);
  assert.deepEqual(painel.corpo.caixas.map((c: any) => [c.id, c.oficial]), [[6, false]]);
  assert.match(painel.corpo.caixas[0].motivo, /Channel::Api/);
  const filtro = { caixa: 6 };
  const contar = await pedir('POST', '/public/disparos/contar', 'tok-demo', { slug: DEMO.slug, filtro }, '2');
  assert.equal(contar.status, 422);
  assert.match(contar.corpo.error, /Channel::Api/);
  const opcoes = await pedir('GET', `/public/disparos/opcoes?slug=${DEMO.slug}&caixa=6`, 'tok-demo', undefined, '2');
  assert.equal(opcoes.status, 422);
  const montar = await pedir('POST', '/public/disparos/ondas', 'tok-demo', { slug: DEMO.slug, nome: 'Teste', maximo: 50, filtro, modelo: { nome: 'demo_x', idioma: 'pt_BR', variaveis: [] } }, '2');
  assert.ok([422, 502].includes(montar.status), `montar na caixa de API não pode passar (veio ${montar.status})`);
  assert.ok(!chamadas.some((c) => c.startsWith('POST') && /conversations\/\d+\/messages/.test(c)), 'nenhuma mensagem foi mandada');
});

test('montar: modelo que não está aprovado na caixa, variáveis em número errado e unidade com disparos DESLIGADOS são recusados sem criar nada', async () => {
  preparar();
  const corpo = (modelo: unknown) => ({ slug: PARAU, nome: 'Reativação', maximo: 50, filtro: { caixa: 3 }, modelo });
  const a = await pedir('POST', '/public/disparos/ondas', 'tok-agente', corpo({ nome: 'parau_inexistente', idioma: 'pt_BR', variaveis: [] }));
  assert.equal(a.status, 422);
  const b = await pedir('POST', '/public/disparos/ondas', 'tok-agente', corpo({ nome: 'parau_imagem', idioma: 'pt_BR', variaveis: [] }));
  assert.equal(b.status, 422);
  assert.match(b.corpo.error, /mídia/);
  const c = await pedir('POST', '/public/disparos/ondas', 'tok-agente', { slug: PARAU, nome: 'x', filtro: { caixa: 3 }, modelo: { nome: 'parau_reativacao' } });
  assert.equal(c.status, 400);
  const { _semearParaTeste } = await import('../lib/automacoes-estado.js');
  _semearParaTeste([{ slug: PARAU, automacao: 'chatwoot-disparo', estado: 'desligado' }]);
  const d = await pedir('POST', '/public/disparos/ondas', 'tok-agente', corpo({ nome: 'parau_reativacao', idioma: 'pt_BR', variaveis: ['primeiroNome'] }));
  assert.equal(d.status, 422);
  assert.match(d.corpo.error, /DESLIGADOS/);
  _semearParaTeste([]);
});

test('TETO DE TEMPO: Chatwoot que não responde NÃO pendura a tela — opções e montar devolvem 504 no teto; o painel da unidade abre com a caixa marcada «demorou»', async () => {
  const { _definirTetosDeTempo } = await import('./disparos.controller.js');
  _definirTetosDeTempo(150, 150);
  try {
    preparar();
    travar = /message_templates$/;
    const t0 = Date.now();
    const opcoes = await pedir('GET', `/public/disparos/opcoes?slug=${PARAU}&caixa=3`, 'tok-agente');
    assert.equal(opcoes.status, 504);
    assert.match(opcoes.corpo.error, /demorou/);
    const montar = await pedir('POST', '/public/disparos/ondas', 'tok-agente', { slug: PARAU, nome: 'Reativação', maximo: 50, filtro: { caixa: 3 }, modelo: { nome: 'parau_reativacao', idioma: 'pt_BR', variaveis: ['primeiroNome'] } });
    assert.equal(montar.status, 504);
    assert.ok(Date.now() - t0 < 3000, 'voltou no teto, não nos 60 s do Chatwoot');
    travar = /\/inboxes$/;
    // a leitura das caixas da PESSOA (login) também usa /inboxes: aqui só o painel da unidade, que lê a caixa com o token da conta, importa — o login já passou
    travar = null;
  } finally {
    _definirTetosDeTempo(6_000, 8_000);
  }
});

test('401 do CRM (token caído) NÃO aparece como «demorou»: opções devolvem 502 «o CRM recusou o acesso», e o painel marca a caixa assim', async () => {
  preparar();
  recusar = /message_templates$/;
  const opcoes = await pedir('GET', `/public/disparos/opcoes?slug=${PARAU}&caixa=3`, 'tok-agente');
  assert.equal(opcoes.status, 502);
  assert.match(opcoes.corpo.error, /recusou o acesso/);
  assert.doesNotMatch(opcoes.corpo.error, /demorou/);
  const demais = await pedir('POST', '/public/disparos/ondas', 'tok-agente', { slug: PARAU, nome: 'Reativação', maximo: 50, filtro: { caixa: 3 }, modelo: { nome: 'parau_reativacao', idioma: 'pt_BR', variaveis: ['primeiroNome'] } });
  assert.equal(demais.status, 502);
  assert.match(demais.corpo.error, /recusou o acesso/);
});

test('contagem: vagas — uma por unidade e no máximo 3 no TOTAL somando unidades; liberar devolve a vaga', async () => {
  const { reservarContagem, liberarContagem, MAX_CONTAGENS_SIMULTANEAS } = await import('./disparos.controller.js');
  assert.equal(MAX_CONTAGENS_SIMULTANEAS, 3);
  assert.equal(reservarContagem('a'), 'ok');
  assert.equal(reservarContagem('a'), 'unidade');
  assert.equal(reservarContagem('b'), 'ok');
  assert.equal(reservarContagem('c'), 'ok');
  assert.equal(reservarContagem('d'), 'global', 'a quarta unidade espera');
  liberarContagem('b');
  assert.equal(reservarContagem('d'), 'ok');
  for (const u of ['a', 'c', 'd']) liberarContagem(u);
});

test('«receberia (seco)» vem da CONTAGEM no banco, não das 150 linhas da tabela: 300 continua 300', async () => {
  const ondaDb = { id: 'ondaaaaaaa1', unitId: 'u1', origem: 'chatwoot', contaChatwoot: 1, estado: 'aprovada', total: 300, impressao: 'x', etiqueta: 'CRM', template: 't', idioma: 'pt_BR', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], cabecalho: null, resumo: {}, campanha: { nome: 'Seco grande' }, caixaChatwoot: 3 };
  preparar({ onda: ondaDb });
  const linhas = Array.from({ length: 150 }, (_, i) => ({ nome: `P${i}`, telefone: '5594991000001', estado: 'pendente', motivo: null, enviadoEm: null, simuladoEm: new Date() }));
  falso('disparoDestinatario', { groupBy: async () => [{ estado: 'pendente', _count: 300 }], findMany: async () => linhas });
  // os números vêm agrupados do BANCO (uma consulta); a tabela tem só as primeiras 150 linhas
  falso('$queryRaw', (async (q: { sql?: string }) => (/GROUP BY onda_id/.test(q.sql ?? '') ? [{ onda_id: 'ondaaaaaaa1', selecionadas: 300, enviadas: 0, tentadas: 0, entregues: 0, lidas: 0, responderam: 0, pediram_sair: 0, falharam: 0, incertas: 0, na_fila: 300, descartadas: 0, receberiam: 300 }] : [])) as never);
  const r = await pedir('GET', `/public/disparos/ondas/ondaaaaaaa1?slug=${PARAU}`, 'tok-dd');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.simulados, 300);
  assert.equal(r.corpo.destinatarios.length, 150);
});

test('relatório por campanha: só as campanhas DESTA unidade e conta; os seis números e as taxas; sem telefone nem nome', async () => {
  preparar();
  const h = (n: number) => new Date(Date.now() - n * 3_600_000);
  const consultas: Array<Record<string, unknown>> = [];
  falso('disparoOnda', {
    findMany: async (a: { where: Record<string, unknown> }) => (consultas.push(a.where), [{ id: 'ondaaaaaaa1', estado: 'aprovada', total: 4, template: 'parau_reativacao', criadoEm: h(20), aprovadaEm: h(19), campanha: { nome: 'Reativação' } }]),
  });
  const consultasSql: string[] = [];
  falso('$queryRaw', (async (q: { sql?: string }) => (consultasSql.push(q.sql ?? ''), [{ onda_id: 'ondaaaaaaa1', selecionadas: 4, enviadas: 3, tentadas: 4, entregues: 3, lidas: 1, responderam: 1, pediram_sair: 1, falharam: 1, incertas: 0, na_fila: 0, descartadas: 0, receberiam: 0 }])) as never);
  falso('disparoDestinatario', {
    findMany: async () => {
      throw new Error('o relatório NÃO lê linhas de destinatário: os números vêm agrupados do banco');
    },
  });
  const r = await pedir('GET', `/public/disparos/relatorio?slug=${PARAU}`, 'tok-agente');
  assert.equal(r.status, 200);
  assert.deepEqual(consultas[0], { unitId: 'u1', origem: 'chatwoot', contaChatwoot: 1 }, 'a busca leva a unidade E a conta da sessão');
  assert.equal(consultasSql.length, 1, 'uma consulta agrupada para todas as campanhas');
  assert.match(consultasSql[0]!, /GROUP BY onda_id/);
  const c = r.corpo.campanhas[0];
  assert.equal(c.nome, 'Reativação');
  assert.deepEqual(c.numeros, { selecionadas: 4, enviadas: 3, tentadas: 4, entregues: 3, lidas: 1, responderam: 1, pediramSair: 1, falharam: 1, incertas: 0, naFila: 0, descartadas: 0, receberiam: 0 });
  assert.deepEqual(c.taxas, { entregues: 100, lidas: 33, responderam: 33, pediramSair: 33, falharam: 25 });
  assert.ok(!/\d{10,}/.test(JSON.stringify(r.corpo).replace(/"criadoEm":"[^"]+"|"aprovadaEm":"[^"]+"/g, '')), 'o relatório não carrega telefone (só contagens)');
  assert.equal((await pedir('GET', `/public/disparos/relatorio?slug=${DEMO.slug}`, 'tok-agente')).status, 403, 'unidade de outra conta: não atende');
});

test('a página tem o relatório por campanha e o relatório dentro do disparo', () => {
  const js = scriptDaPagina();
  assert.ok(js.includes("'/api/public/disparos/relatorio?slug='"));
  for (const t of ['Relatório por campanha', 'Responderam (72 h)', 'Pediram SAIR', 'Falharam', 'Entregues', 'Lidas']) assert.ok(js.includes(t), t);
  assert.ok(paginaDosDisparos(CW).includes('id="btRel"'));
});

// ── máximo, custo e ritmo na tela ───────────────────────────────────────────────────────────────────────────────

const LINHAS_DE_CUSTO = [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 329, costUsd: '20.5625' }]; // US$ 0,0625 por mensagem
const ondaDeCusto = (extra: Record<string, unknown> = {}) => ({ id: 'ondaaaaaaa1', unitId: 'u1', origem: 'chatwoot', contaChatwoot: 1, estado: 'aprovada', total: 40, impressao: 'x', etiqueta: 'CRM', template: 't', idioma: 'pt_BR', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], cabecalho: null, resumo: {}, campanha: { nome: 'Custo' }, caixaChatwoot: 3, maximoPessoas: 50, categoriaModelo: 'MARKETING', criadaPor: 'x', ...extra });

test('MÁXIMO obrigatório: montar sem o máximo (ou fora de 1 a 500) é recusado com 400, sem criar nada', async () => {
  preparar();
  const corpo = (maximo: unknown) => ({ slug: PARAU, nome: 'Reativação', maximo, filtro: { caixa: 3 }, modelo: { nome: 'parau_reativacao', idioma: 'pt_BR', variaveis: ['primeiroNome'] } });
  for (const ruim of [undefined, 0, -3, 501, 'cinquenta', 2.5, null]) {
    const r = await pedir('POST', '/public/disparos/ondas', 'tok-agente', corpo(ruim));
    assert.equal(r.status, 400, String(ruim));
    assert.match(r.corpo.error, /máximo de pessoas/);
  }
});

test('o disparo mostra o CUSTO estimado (pessoas × preço da categoria na tabela da Meta × dólar), o máximo, o ritmo e o teto de gasto; o gasto até agora usa as enviadas', async () => {
  const { _definirCambio } = await import('../lib/disparo/chatwoot/custo.js');
  _definirCambio(5.6);
  preparar({ onda: ondaDeCusto() });
  falso('whatsappCostDaily', { findMany: async () => LINHAS_DE_CUSTO });
  falso('$queryRaw', (async (q: { sql?: string }) => (/GROUP BY onda_id/.test(q.sql ?? '') ? [{ onda_id: 'ondaaaaaaa1', selecionadas: 40, enviadas: 10, tentadas: 10, entregues: 8, lidas: 3, responderam: 1, pediram_sair: 0, falharam: 0, incertas: 0, na_fila: 30, descartadas: 0, receberiam: 0 }] : [])) as never);
  const r = await pedir('GET', `/public/disparos/ondas/ondaaaaaaa1?slug=${PARAU}`, 'tok-dd');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.maximo, 50);
  assert.equal(r.corpo.custo.conhecido, true);
  assert.equal(r.corpo.custo.porMensagemBrl, 0.35);
  assert.equal(r.corpo.custo.brl, 14, '40 pessoas × R$ 0,35');
  assert.equal(r.corpo.custo.categoria, 'MARKETING');
  assert.equal(r.corpo.gastoEstimadoBrl, 3.5, '10 enviadas × R$ 0,35');
  assert.deepEqual([r.corpo.ritmo.porDia, r.corpo.ritmo.dias, r.corpo.ritmo.limitadoPor, r.corpo.ritmo.soDiasUteis], [100, 1, 'dia', true]);
  assert.equal(r.corpo.freios.tetoReaisDia, 50);
  assert.equal(r.corpo.freios.tetoPorHora, 30);
  assert.equal(r.corpo.freios.tetoPorDia, 100);
});

test('categoria que a tabela de custo da unidade NÃO tem = custo estimado com preço de RESERVA (conservador, sem histórico da Meta), com o motivo; sem categoria gravada também', async () => {
  const { _definirCambio } = await import('../lib/disparo/chatwoot/custo.js');
  _definirCambio(5.6);
  preparar({ onda: ondaDeCusto({ categoriaModelo: 'AUTHENTICATION' }) });
  falso('whatsappCostDaily', { findMany: async () => [] });
  falso('$queryRaw', (async () => []) as never);
  const r = await pedir('GET', `/public/disparos/ondas/ondaaaaaaa1?slug=${PARAU}`, 'tok-dd');
  assert.equal(r.corpo.custo.conhecido, false);
  assert.equal(r.corpo.custo.reserva, true);
  assert.equal(r.corpo.custo.porMensagemBrl, 0.25, 'reserva de autenticação');
  assert.equal(r.corpo.custo.brl, 10, '40 pessoas × R$ 0,25');
  assert.match(r.corpo.custo.nota, /preço de reserva \(sem histórico da Meta\).*não tem a categoria AUTHENTICATION/);
  assert.equal(r.corpo.ritmo.limitadoPor, 'dia', 'o teto de gasto (R$ 50 ÷ R$ 0,25 = 200) é maior que o por dia (100): o ritmo existe mesmo sem histórico');
  preparar({ onda: ondaDeCusto({ categoriaModelo: null }) });
  falso('whatsappCostDaily', { findMany: async () => LINHAS_DE_CUSTO });
  falso('$queryRaw', (async () => []) as never);
  const sem = await pedir('GET', `/public/disparos/ondas/ondaaaaaaa1?slug=${PARAU}`, 'tok-dd');
  assert.equal(sem.corpo.custo.conhecido, false);
  assert.equal(sem.corpo.custo.reserva, true);
  assert.equal(sem.corpo.custo.porMensagemBrl, 2, 'sem categoria: a reserva mais cara');
  assert.match(sem.corpo.custo.nota, /categoria do modelo/);
});

test('aprovar pela rota: custo DESCONHECIDO sem confirmação = 409 com `precisaConfirmarCusto` (a tela pede o ok explícito); o máximo é conferido', async () => {
  const { _definirCambio } = await import('../lib/disparo/chatwoot/custo.js');
  const { impressaoDaOnda } = await import('../lib/disparo/modelo.js');
  const { definicaoDaOnda } = await import('../lib/disparo/onda.js');
  _definirCambio(5.6);
  const pessoas = [{ chave: 'c1', nome: 'Ana' }];
  const base = ondaDeCusto({ estado: 'montada', total: 1, categoriaModelo: 'AUTHENTICATION' });
  const impressao = impressaoDaOnda(definicaoDaOnda(base as never), pessoas);
  const onda = { ...base, impressao, unit: { id: 'u1', slug: PARAU, metaPhoneNumberId: null } };
  preparar({ onda });
  falso('disparoOnda', { findFirst: async () => onda, findUnique: async () => onda, updateMany: async () => { throw new Error('NÃO podia aprovar'); } });
  falso('disparoDestinatario', { findMany: async () => pessoas });
  falso('whatsappCostDaily', { findMany: async () => [] });
  const aprova = (extra: Record<string, unknown>) => pedir('POST', '/public/disparos/ondas/ondaaaaaaa1/aprovar', 'tok-dd', { slug: PARAU, total: 1, impressao, ...extra });
  const semMax = await aprova({});
  assert.equal(semMax.status, 409);
  assert.match(semMax.corpo.error, /máximo/);
  const semConfirma = await aprova({ maximo: 50 });
  assert.equal(semConfirma.status, 409);
  assert.equal(semConfirma.corpo.precisaConfirmarCusto, true);
  assert.match(semConfirma.corpo.error, /^custo desconhecido/);
});

test('relatório por campanha mostra o GASTO estimado (enviadas × preço da categoria; sem histórico, o preço de reserva)', async () => {
  const { _definirCambio } = await import('../lib/disparo/chatwoot/custo.js');
  _definirCambio(5.6);
  preparar();
  const h = (n: number) => new Date(Date.now() - n * 3_600_000);
  falso('disparoOnda', { findMany: async () => [
    { id: 'ondaaaaaaa1', estado: 'aprovada', total: 40, template: 't', categoriaModelo: 'MARKETING', criadoEm: h(5), aprovadaEm: h(4), campanha: { nome: 'A' } },
    { id: 'ondaaaaaaa2', estado: 'aprovada', total: 40, template: 't', categoriaModelo: 'AUTHENTICATION', criadoEm: h(5), aprovadaEm: h(4), campanha: { nome: 'B' } },
  ] });
  falso('whatsappCostDaily', { findMany: async (a: { where: { pricingCategory: { startsWith: string } } }) => (a.where.pricingCategory.startsWith === 'MARKETING' ? LINHAS_DE_CUSTO : []) });
  const linha = (id: string) => ({ onda_id: id, selecionadas: 40, enviadas: 20, tentadas: 20, entregues: 0, lidas: 0, responderam: 0, pediram_sair: 0, falharam: 0, incertas: 0, na_fila: 20, descartadas: 0, receberiam: 0 });
  falso('$queryRaw', (async () => [linha('ondaaaaaaa1'), linha('ondaaaaaaa2')]) as never);
  const r = await pedir('GET', `/public/disparos/relatorio?slug=${PARAU}`, 'tok-agente');
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.campanhas.map((c: any) => c.gastoEstimadoBrl), [7, 5], '20 enviadas × R$ 0,35 = R$ 7,00; categoria sem histórico: 20 × R$ 0,25 de reserva = R$ 5,00');
});

test('a página tem o campo do máximo (padrão 50, obrigatório), o cartão de custo e ritmo, a confirmação do custo desconhecido e o gasto no relatório', () => {
  const js = scriptDaPagina();
  assert.ok(js.includes("mx.value = '50'") && js.includes('Máximo de pessoas neste disparo') && js.includes('maximo: maximo'));
  assert.ok(js.includes('Custo e ritmo') && js.includes('Teto de gasto'));
  assert.ok(js.includes('confirmarCustoDesconhecido') && js.includes('Entendo que não há histórico de custo da Meta') && js.includes('preço de reserva (sem histórico da Meta)'));
  assert.ok(js.includes('Gasto (estimado)') && js.includes('gasto até agora'));
  assert.ok(!/innerHTML/.test(js));
});
