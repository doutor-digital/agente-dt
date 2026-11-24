/**
 * Página `/agente/:slug` (tela Agente das unidades do Kommo): a página compila e só tem dado do servidor em textContent; as rotas
 * pedem o código da unidade (errado = 403, unidade que não existe = 404) e aceitam o código no cabeçalho; Ensinar/Testar seguem
 * a chave por unidade; o pedido à Doutor Digital cai na fila do suporte sem entrar na fila do agente de código.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { paginaDoAgente, paginaDoAgenteKommo } from '../lib/agente-pagina.js';
import { ehJidDaTelaAgente } from './suporte-painel.controller.js';
import { agenteKommoEstadoHandler, agenteKommoNovoPedidoHandler, agenteKommoPausadasHandler, paginaAgenteKommoHandler } from './agente-kommo.controller.js';

const SLUG = 'doutor-hernia-timbo';
const unidade = { id: 'u1', slug: SLUG, isActive: true, pausaCodigo: '482913', name: 'Timbó', kommoSubdomain: 'timbo', spineTimezone: 'America/Sao_Paulo' };

function scriptDe(html: string): string {
  const i = html.lastIndexOf('<script>');
  const f = html.lastIndexOf('</script>');
  assert.ok(i > 0 && f > i, 'tem script');
  return html.slice(i + '<script>'.length, f);
}

// ── a página ──

test('a página do Kommo compila, abre no modo Kommo e não deixa marcador sem trocar', () => {
  const html = paginaDoAgenteKommo(SLUG);
  assert.doesNotThrow(() => new Function(scriptDe(html)));
  assert.ok(html.includes(`var KM = {"slug":"${SLUG}"}`));
  for (const marca of ['__KOMMO__', '__ORIGEM_CW__', '__GUIA_LIGADO__', '__ORIGENS_CW__', '__CONTA_JS__']) assert.ok(!html.includes(marca), marca);
  assert.ok(html.includes('var CW = \'\''), 'sem origem do Chatwoot: ninguém fala com a página por postMessage');
  for (const aba of ['painel', 'ensinar', 'testar', 'pausadas', 'conferir', 'pedir']) assert.ok(html.includes(`id="aba-${aba}"`) && html.includes(`id="pane-${aba}"`), aba);
  assert.ok(html.includes('noindex'));
});

test('a tela do CRM não muda: KM é nulo lá e as rotas do Chatwoot seguem as mesmas', () => {
  const html = paginaDoAgente('https://atendimento.exemplo.test');
  assert.ok(html.includes('var KM = null,'));
  assert.doesNotThrow(() => new Function(scriptDe(html)));
  assert.ok(!html.includes('__KOMMO__'));
  assert.ok(html.includes("'/api/public/agente/painel?slug='") && html.includes("'/api/public/testar-ia/pausadas'"));
});

test('nenhum dado do servidor entra por innerHTML, e o slug não consegue fechar o script', () => {
  const js = scriptDe(paginaDoAgenteKommo(SLUG));
  assert.equal((js.match(/innerHTML/g) ?? []).length, 0);
  const estranho = paginaDoAgenteKommo('x</script><script>alert(1)</script>');
  assert.ok(!estranho.includes('x</script>'), 'o < do slug sai escapado');
  assert.doesNotThrow(() => new Function(scriptDe(estranho)));
});

test('o código vai no cabeçalho nos GET (não no endereço) e no corpo nos outros; e fica só nas rotas que já existem', () => {
  const js = scriptDe(paginaDoAgenteKommo(SLUG));
  assert.ok(js.includes("init.headers['x-codigo'] = KM_COD"));
  assert.ok(!js.includes("'?codigo='") && !js.includes("'&codigo='"), 'o código nunca vai na URL');
  for (const rota of ["'/api/public/pausa/'", "'/api/public/ia/'", "'/api/public/agente-kommo/'", "'/api/public/aprendizados/'", "'/lead/'"]) assert.ok(js.includes(rota), rota);
  // Registro e 👍/👎 só existem no CRM
  assert.ok(js.includes("$('aba-registro').hidden = true"));
  assert.ok(js.includes('if (!KM) desenharRevisar'));
});

test('a unidade sem a chave de Ensinar vê «ainda não liberado» e a página não chama /aprendizados', () => {
  const js = scriptDe(paginaDoAgenteKommo(SLUG));
  assert.ok(js.includes('Ainda não liberado para a sua unidade'));
  assert.ok(js.includes('if (KM && !KM_LIB) return;'), 'carregarRegras não liga nada');
  assert.ok(js.includes('if (KM && !KM_LIB) return null;'), 'lerEstado não liga nada');
});

test('o texto que o servidor manda sobre «Kommo» aparece como «CRM» na aba Conferir', () => {
  const js = scriptDe(paginaDoAgenteKommo(SLUG));
  assert.ok(js.includes("replace(/Kommo/g, 'CRM')"));
});

// ── as rotas ──

type Saida = { status: number; body?: any; tipo?: string };
function chamar(handler: (req: never, res: never) => Promise<void>, req: Record<string, unknown>): Promise<Saida> {
  const out: Saida = { status: 200 };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.body = b; return this; },
    send(b: unknown) { out.body = b; return this; },
    type(t: string) { out.tipo = t; return this; },
    set() { return this; },
    setHeader() { return this; },
  };
  return handler(req as never, res as never).then(() => out);
}
const cabecalho = (h: Record<string, string>) => (nome: string) => h[nome.toLowerCase()];

let antesUnit: unknown;
let antesSuporte: unknown;
let antesEnv: string | undefined;
let antesToken: string | undefined;
let ip = 0;
beforeEach(() => {
  antesUnit = (prisma as unknown as { unit: unknown }).unit;
  antesSuporte = (prisma as unknown as { suporteDemanda: unknown }).suporteDemanda;
  antesEnv = process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS;
  antesToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS;
  ip += 1; // cada teste com o seu ip: o limitador de tentativas é por ip+unidade
  Object.defineProperty(prisma, 'unit', {
    value: { ...(antesUnit as object), findUnique: async (a: { where: { slug: string } }) => (a.where.slug === SLUG ? unidade : null) },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(prisma, 'unit', { value: antesUnit, configurable: true });
  Object.defineProperty(prisma, 'suporteDemanda', { value: antesSuporte, configurable: true });
  if (antesEnv === undefined) delete process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS;
  else process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS = antesEnv;
  if (antesToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = antesToken;
});

const get = (slug: string, codigo: { cabecalho?: string; consulta?: string }) => ({
  params: { slug },
  method: 'GET',
  ip: `10.9.0.${ip}`,
  query: codigo.consulta ? { codigo: codigo.consulta } : {},
  get: cabecalho(codigo.cabecalho ? { 'x-codigo': codigo.cabecalho } : {}),
});

test('a página: unidade que não existe dá 404; a que existe entrega o HTML sem pedir código (ele é pedido na página)', async () => {
  const nao = await chamar(paginaAgenteKommoHandler as never, { params: { slug: 'nao-existe' } });
  assert.equal(nao.status, 404);
  const sim = await chamar(paginaAgenteKommoHandler as never, { params: { slug: SLUG } });
  assert.equal(sim.status, 200);
  assert.ok(String(sim.body).includes(`"slug":"${SLUG}"`));
  assert.ok(!String(sim.body).includes('482913'), 'o código da unidade nunca vai na página');
});

test('estado: código errado = 403, certo (no cabeçalho ou na consulta) = 200; a chave de Ensinar vem junto', async () => {
  assert.equal((await chamar(agenteKommoEstadoHandler as never, get(SLUG, { cabecalho: '000000' }))).status, 403);
  assert.equal((await chamar(agenteKommoEstadoHandler as never, get(SLUG, {}))).status, 403, 'sem código');
  assert.equal((await chamar(agenteKommoEstadoHandler as never, get('nao-existe', { cabecalho: '482913' }))).status, 404);
  const a = await chamar(agenteKommoEstadoHandler as never, get(SLUG, { cabecalho: '482913' }));
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { unidade: 'Timbó', slug: SLUG, aprendizados: false }, 'chave desligada = Ensinar não liberado');
  process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS = SLUG;
  const b = await chamar(agenteKommoEstadoHandler as never, get(SLUG, { consulta: '482913' }));
  assert.equal(b.status, 200);
  assert.equal(b.body.aprendizados, true);
});

test('o limitador é o das outras páginas: depois de 12 erros seguidos vem 429', async () => {
  let ultimo = 0;
  for (let i = 0; i < 14; i++) ultimo = (await chamar(agenteKommoPausadasHandler as never, get(SLUG, { cabecalho: '111111' }))).status;
  assert.equal(ultimo, 429);
});

test('pedido à Doutor Digital: grava com origem da página (fora da fila do agente de código), por «recepção» sem nome e respeita o teto do dia', async () => {
  const criados: Array<{ data: Record<string, unknown> }> = [];
  let hoje = 0;
  Object.defineProperty(prisma, 'suporteDemanda', {
    value: {
      count: async () => hoje,
      create: async (a: { data: Record<string, unknown> }) => { criados.push(a); return { protocolo: 77 }; },
      update: async () => ({}),
      findMany: async () => [],
    },
    configurable: true,
  });
  const corpo = { tipo: 'valor', texto: 'A partir de 1º de dezembro a consulta passa a custar R$ 380.', por: 'Maria' };
  const post = (c: unknown, codigo = '482913') => ({ params: { slug: SLUG }, method: 'POST', ip: `10.9.1.${ip}`, query: {}, body: { ...(c as object), codigo }, get: cabecalho({}) });

  assert.equal((await chamar(agenteKommoNovoPedidoHandler as never, post(corpo, '000000'))).status, 403);
  assert.equal(criados.length, 0, 'código errado não grava nada');
  assert.equal((await chamar(agenteKommoNovoPedidoHandler as never, post({ ...corpo, texto: 'curto' }))).status, 400);

  const ok = await chamar(agenteKommoNovoPedidoHandler as never, post(corpo));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.protocolo, 77);
  const d = criados[0]!.data;
  assert.equal(d.verificacao, 'chatwoot', 'nunca entra sozinha na fila do agente de código');
  assert.equal(d.jid, `pagina:${SLUG}`);
  assert.equal(d.unidadeSlug, SLUG);
  assert.equal(d.nome, 'Maria');
  assert.match(String(d.categoriaNome), /^Agente \(página da unidade\) · /);
  assert.ok(String(d.relato).startsWith('[Agente na página da unidade] Maria, de Timbó'));

  hoje = 15;
  assert.equal((await chamar(agenteKommoNovoPedidoHandler as never, post(corpo))).status, 429);
  assert.equal(criados.length, 1);
});

test('o painel do suporte não manda WhatsApp para o «jid» dos pedidos da tela Agente (CRM e página das unidades)', () => {
  assert.equal(ehJidDaTelaAgente(`pagina:${SLUG}`), true);
  assert.equal(ehJidDaTelaAgente('chatwoot:12'), true);
  assert.equal(ehJidDaTelaAgente('5511999998888@s.whatsapp.net'), false);
  assert.equal(ehJidDaTelaAgente('123456789@lid'), false);
});

test('Sair e código recusado param os temporizadores e nada vai ao servidor sem código (não gasta as 12 tentativas)', () => {
  const js = scriptDe(paginaDoAgenteKommo(SLUG));
  assert.ok(js.includes("if (!KM_COD) throw new Error('Entre com o código da unidade.');"));
  const sair = js.slice(js.indexOf('function sairKm'), js.indexOf('async function tentarKm'));
  assert.ok(sair.includes('clearTimeout(tPainel); clearTimeout(tConferir)'));
  assert.ok(js.includes('location.reload()'), 'Sair recarrega: nada da pessoa anterior fica na tela');
});
