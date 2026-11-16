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
const fetchReal = globalThis.fetch;
const MODELO_OK = { name: 'parau_reativacao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Oi {{1}}, tudo bem?' }] };

function chatwootDeMentira() {
  return (async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(String(url));
    chamadas.push(`${o.method ?? 'GET'} ${u.pathname}`);
    const resp = (status: number, j: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(j), json: async () => j }) as Response;
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
  const montar = await pedir('POST', '/public/disparos/ondas', 'tok-demo', { slug: DEMO.slug, nome: 'Teste', filtro, modelo: { nome: 'demo_x', idioma: 'pt_BR', variaveis: [] } }, '2');
  assert.ok([422, 502].includes(montar.status), `montar na caixa de API não pode passar (veio ${montar.status})`);
  assert.ok(!chamadas.some((c) => c.startsWith('POST') && /conversations\/\d+\/messages/.test(c)), 'nenhuma mensagem foi mandada');
});

test('montar: modelo que não está aprovado na caixa, variáveis em número errado e unidade com disparos DESLIGADOS são recusados sem criar nada', async () => {
  preparar();
  const corpo = (modelo: unknown) => ({ slug: PARAU, nome: 'Reativação', filtro: { caixa: 3 }, modelo });
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
