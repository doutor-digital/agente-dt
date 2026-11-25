/**
 * Quadro do Funil em DOIS funis (Comercial e Tratamento), contas com o atributo `etapa_tratamento`: o quadro separa pelo `funil` + `etapa_tratamento`, mover no
 * Tratamento grava `etapa_tratamento` (não a etapa comercial), e conta SEM esse atributo segue com um funil só, como sempre. Chatwoot de mentira com estado.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

process.env.CHATWOOT_API_TOKEN = 'token-da-conta';
process.env.CHATWOOT_CONTA_ID = '1';
process.env.CHATWOOT_URL = 'https://chatwoot.exemplo.test';
mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-18T14:00:00Z') });
const AGORA_S = Math.floor(Date.now() / 1000);

const conversa = (id: number, attrs: Record<string, unknown>) => ({
  id,
  status: 'open',
  inbox_id: 3,
  created_at: AGORA_S - 3600,
  last_activity_at: AGORA_S - id * 60,
  labels: [],
  custom_attributes: { ...attrs },
  meta: { sender: { name: `Paciente ${id}`, phone_number: '+5594999990000', custom_attributes: {} }, assignee: null },
  last_non_activity_message: null,
});
const ETAPAS = ['Novo lead', 'Sofia qualifica', 'Agendado', 'Fechou', 'Perdido'];
const TRAT = ['Entrada', 'Em tratamento', 'Alta', 'Tratamento cancelado'];
let conversas: any[] = [];
let defs: any[] = [];
const escritas: Array<{ metodo: string; url: string; corpo: any }> = [];
const notas: string[] = [];
const def = (key: string, values: string[]) => ({ attribute_key: key, attribute_values: values, attribute_model: 0, attribute_display_type: 6 });

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const metodo = String(init?.method ?? 'GET').toUpperCase();
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (u.endsWith('/api/v1/profile')) return json({ id: 1, name: 'Suzanne', email: 's@dd.com', accounts: [{ id: 1, role: 'administrator' }] });
  if (u.includes('/inboxes')) return json({ payload: [{ id: 3, name: 'WhatsApp' }] });
  if (u.includes('/custom_attribute_definitions')) return json(defs);
  if (u.includes('/conversations?')) return json({ data: { payload: new URL(u).searchParams.get('inbox_id') === '3' ? conversas : [] } });
  let m: RegExpExecArray | null;
  if ((m = /\/conversations\/(\d+)\/custom_attributes$/.exec(u)) && metodo === 'POST') {
    const c = conversas.find((x) => x.id === Number(m![1]))!;
    const corpo = JSON.parse(String(init?.body));
    escritas.push({ metodo, url: u, corpo });
    c.custom_attributes = corpo.custom_attributes;
    return json({ custom_attributes: c.custom_attributes });
  }
  if ((m = /\/conversations\/(\d+)\/messages$/.exec(u))) {
    if (metodo === 'POST') {
      notas.push(JSON.parse(String(init?.body)).content);
      return json({ id: 1 });
    }
    return json({ payload: [] });
  }
  if ((m = /\/conversations\/(\d+)$/.exec(u))) return json(conversas.find((x) => x.id === Number(m![1])));
  void headers;
  return json({ payload: [] });
}) as typeof fetch;

const { prisma } = await import('../lib/prisma.js');
for (const [k, v] of Object.entries({ chatwootReguaVisto: { findMany: async () => [], findFirst: async () => null }, unit: { findUnique: async () => null }, funilTarefa: { findMany: async () => [] } })) Object.defineProperty(prisma, k, { value: v, configurable: true });
const { _esquecerLeituraDoFunil, funilQuadroHandler, funilMoverHandler, funilConversaHandler, paginaFunilHandler } = await import('./funil.controller.js');

function resp() {
  const r = { codigo: 200, corpo: undefined as any, tipo: '', status(n: number) { r.codigo = n; return r; }, json(c: unknown) { r.corpo = c; return r; }, type(t: string) { r.tipo = t; return r; }, set() { return r; }, send(c: unknown) { r.corpo = c; return r; } };
  return r;
}
const asRes = (r: ReturnType<typeof resp>) => r as unknown as Response;
const pedido = (query: Record<string, string> = {}, body: unknown = undefined, params: Record<string, string> = {}) => {
  const h: Record<string, string> = { 'x-cw-token': 'tk', 'x-cw-client': 'c', 'x-cw-uid': 'u@dd.com' };
  return { query, body, params, ip: '1.1.1.1', get: (n: string) => h[n.toLowerCase()] } as unknown as Request;
};
function preparar(comTratamento: boolean) {
  _esquecerLeituraDoFunil();
  escritas.length = 0;
  notas.length = 0;
  defs = [def('etapa', ETAPAS), ...(comTratamento ? [def('etapa_tratamento', TRAT), def('funil', ['Comercial', 'Tratamento'])] : [])];
  conversas = [
    conversa(1, { etapa: 'Agendado', funil: 'Comercial' }),
    conversa(2, { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', valor_fechado: '2000' }),
    conversa(3, { etapa_tratamento: 'Alta' }), // sem `funil`: quem tem etapa do tratamento é do Tratamento
    conversa(4, { funil: 'Comercial', etapa_tratamento: 'Alta', etapa: 'Sofia qualifica' }), // mesma regra da régua: etapa_tratamento preenchida = Tratamento
    conversa(5, { funil: 'Tratamento', etapa_tratamento: 'Etapa apagada' }), // etapa que a lista não tem = 1ª do tratamento
    conversa(6, {}), // sem nada: Comercial, 1ª coluna
  ];
}
const quadro = async (query: Record<string, string> = {}) => {
  const r = resp();
  await funilQuadroHandler(pedido(query), asRes(r));
  assert.equal(r.codigo, 200, JSON.stringify(r.corpo));
  return r.corpo as any;
};
const ids = (col: any) => col.cartoes.map((k: any) => k.id).sort((a: number, b: number) => a - b);

test('conta SEM o atributo etapa_tratamento: um funil só, como sempre (todas as conversas nas etapas comerciais, sem seletor)', async () => {
  preparar(false);
  const q = await quadro();
  assert.deepEqual(q.etapas, ETAPAS);
  assert.deepEqual(q.funis, []);
  assert.equal(q.funil, 'comercial');
  assert.equal(q.total, 6);
  assert.deepEqual(ids(q.colunas[0]), [2, 3, 5, 6], 'sem o atributo, a conversa do tratamento cai na 1ª coluna comercial (como sempre foi)');
  assert.ok(q.colunas.every((c: any) => c.cartoes.every((k: any) => k.funil === 'comercial')));
  // ?funil=tratamento numa conta sem o atributo é ignorado
  const t = await quadro({ funil: 'tratamento' });
  assert.equal(t.funil, 'comercial');
  assert.equal(t.total, 6);
});

test('conta com etapa_tratamento: o Comercial NÃO mostra quem é do Tratamento, e o Tratamento mostra cada um na etapa do tratamento', async () => {
  preparar(true);
  const c = await quadro();
  assert.equal(c.funil, 'comercial');
  assert.deepEqual(c.etapas, ETAPAS);
  assert.deepEqual(c.funis, [{ id: 'comercial', nome: 'Comercial', total: 2 }, { id: 'tratamento', nome: 'Tratamento', total: 4 }]);
  assert.equal(c.total, 2);
  assert.deepEqual(ids(c.colunas[0]), [6], '«Novo lead»: só a conversa sem etapa');
  assert.deepEqual(ids(c.colunas.find((x: any) => x.etapa === 'Agendado')), [1]);
  assert.deepEqual(ids(c.colunas.find((x: any) => x.etapa === 'Sofia qualifica')), [], 'a conversa 4 tem etapa_tratamento: é do Tratamento (como a régua a trata)');
  const t = await quadro({ funil: 'tratamento' });
  assert.equal(t.funil, 'tratamento');
  assert.deepEqual(t.etapas, TRAT);
  assert.equal(t.total, 4);
  assert.deepEqual(ids(t.colunas.find((x: any) => x.etapa === 'Entrada')), [5], 'etapa que a lista não tem = a 1ª do tratamento');
  assert.deepEqual(ids(t.colunas.find((x: any) => x.etapa === 'Em tratamento')), [2]);
  assert.deepEqual(ids(t.colunas.find((x: any) => x.etapa === 'Alta')), [3, 4]);
  assert.equal(t.colunas.find((x: any) => x.etapa === 'Em tratamento').soma, 2000, 'a soma em R$ também vale no Tratamento');
  assert.ok(t.colunas.every((col: any) => col.cartoes.every((k: any) => k.funil === 'tratamento' && k.etapa === col.etapa)));
  // valor estranho no pedido = Comercial
  assert.equal((await quadro({ funil: 'lixo' })).funil, 'comercial');
});

test('mover NO TRATAMENTO grava etapa_tratamento (a etapa comercial fica), põe funil=Tratamento só se faltava e deixa a nota do tratamento', async () => {
  preparar(true);
  const r = resp();
  await funilMoverHandler(pedido({}, { conversaId: 3, etapa: 'Em tratamento', funil: 'tratamento' }), asRes(r));
  assert.equal(r.codigo, 200, JSON.stringify(r.corpo));
  assert.deepEqual(r.corpo, { ok: true, de: 'Alta', para: 'Em tratamento' });
  assert.deepEqual(conversas[2].custom_attributes, { etapa_tratamento: 'Em tratamento', funil: 'Tratamento' });
  assert.match(notas[0]!, /^📋 Etapa do tratamento: Alta → Em tratamento \(por Suzanne\) — pelo funil$/);
  // conversa que já tem funil: não mexe nele nem nos outros atributos
  const r2 = resp();
  await funilMoverHandler(pedido({}, { conversaId: 2, etapa: 'Alta', funil: 'tratamento', confirmar: true }), asRes(r2));
  assert.deepEqual(conversas[1].custom_attributes, { funil: 'Tratamento', etapa_tratamento: 'Alta', valor_fechado: '2000' });
  // mesma etapa: nada
  const antes = escritas.length;
  const r3 = resp();
  await funilMoverHandler(pedido({}, { conversaId: 2, etapa: 'Alta', funil: 'tratamento', confirmar: true }), asRes(r3));
  assert.deepEqual(r3.corpo, { ok: true, igual: true });
  assert.equal(escritas.length, antes);
  // etapa que não é do tratamento: recusada, nada gravado
  const r4 = resp();
  await funilMoverHandler(pedido({}, { conversaId: 2, etapa: 'Agendado', funil: 'tratamento' }), asRes(r4));
  assert.equal(r4.codigo, 400);
  assert.equal(escritas.length, antes);
});

test('mover no Comercial segue igual (grava `etapa`), e pedir o Tratamento numa conta sem o atributo é recusado', async () => {
  preparar(true);
  const r = resp();
  await funilMoverHandler(pedido({}, { conversaId: 1, etapa: 'Fechou' }), asRes(r));
  assert.deepEqual(r.corpo, { ok: true, de: 'Agendado', para: 'Fechou' });
  assert.deepEqual(conversas[0].custom_attributes, { etapa: 'Fechou', funil: 'Comercial' });
  assert.match(notas[0]!, /^📋 Etapa: Agendado → Fechou/);
  preparar(false);
  const r2 = resp();
  await funilMoverHandler(pedido({}, { conversaId: 2, etapa: 'Alta', funil: 'tratamento' }), asRes(r2));
  assert.equal(r2.codigo, 400);
  assert.match(r2.corpo.error, /não tem o funil de Tratamento/);
  assert.equal(escritas.length, 0);
});

test('a ficha da conversa do Tratamento traz as etapas do tratamento e o funil; a do Comercial segue com as comerciais', async () => {
  preparar(true);
  const t = resp();
  await funilConversaHandler(pedido({}, undefined, { id: '2' }), asRes(t));
  assert.equal(t.codigo, 200, JSON.stringify(t.corpo));
  assert.deepEqual(t.corpo.etapas, TRAT);
  assert.equal(t.corpo.funil, 'tratamento');
  assert.equal(t.corpo.cartao.etapa, 'Em tratamento');
  const c = resp();
  await funilConversaHandler(pedido({}, undefined, { id: '1' }), asRes(c));
  assert.deepEqual(c.corpo.etapas, ETAPAS);
  assert.equal(c.corpo.funil, 'comercial');
});

test('a página tem o seletor Comercial | Tratamento (escondido por padrão), pede o quadro com ?funil= e PARSEIA', () => {
  const r = resp();
  paginaFunilHandler({} as Request, asRes(r));
  const html = String(r.corpo);
  assert.match(html, /id="funis"[^>]*hidden/);
  assert.match(html, /quadro\?funil='\+funilAtual/);
  assert.match(html, /funil:dados&&dados\.funil==='tratamento'\?'tratamento':undefined/);
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.doesNotThrow(() => new Function(js));
});

test('mover para Alta ou Tratamento cancelado SEM confirmar é recusado no servidor (409) e nada é gravado; com confirmar grava; as outras etapas não pedem', async () => {
  preparar(true);
  for (const etapa of ['Alta', 'Tratamento cancelado']) {
    const r = resp();
    await funilMoverHandler(pedido({}, { conversaId: 5, etapa, funil: 'tratamento' }), asRes(r));
    assert.equal(r.codigo, 409, etapa);
    assert.equal(r.corpo.precisaConfirmar, true);
  }
  assert.equal(escritas.length, 0, 'nada gravado sem confirmação');
  const ok = resp();
  await funilMoverHandler(pedido({}, { conversaId: 5, etapa: 'Tratamento cancelado', funil: 'tratamento', confirmar: true }), asRes(ok));
  assert.equal(ok.codigo, 200);
  assert.equal(conversas[4].custom_attributes.etapa_tratamento, 'Tratamento cancelado');
  const livre = resp();
  await funilMoverHandler(pedido({}, { conversaId: 5, etapa: 'Em tratamento', funil: 'tratamento' }), asRes(livre));
  assert.equal(livre.codigo, 200);
});

test('a ficha do Tratamento conta os dias desde a nota do TRATAMENTO (não desde a criação da conversa)', async () => {
  preparar(true);
  const t = resp();
  await funilConversaHandler(pedido({}, undefined, { id: '2' }), asRes(t));
  assert.equal(t.codigo, 200);
  assert.equal(t.corpo.desdeEtapa, conversas[1].created_at, 'sem nota: vale a criação');
});

test('a página pede confirmação antes de mover para Alta/Tratamento cancelado (arrastar, → e ficha) e guarda «recolhida» por funil', () => {
  const r = resp();
  paginaFunilHandler({} as Request, asRes(r));
  const html = String(r.corpo);
  assert.match(html, /window\.confirm\('Mover para «'\+etapa\+'»/);
  assert.match(html, /confirmar:cf\.confirmar/);
  assert.match(html, /function chaveCol\(e\)\{ return dados&&dados\.funil==='tratamento'\?'t:'\+e:e; \}/);
  assert.match(html, /\$\('busca'\)\.value=''/);
});
