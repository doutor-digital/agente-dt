/**
 * Passo 4 — telas e sessão por conta. O ATAQUE: uma sessão válida da conta 1 pedindo `conta=2` recebe 403 e não vê dado nenhum,
 * em TODAS as rotas /api/public que usam o login do Chatwoot (funil, robôs, agente, assistente, aprendizados, testar-ia).
 * O servidor de verdade (o `apiRouter` inteiro) com um Chatwoot de mentira que marca todo dado da conta 2 com SEGREDO.
 */
import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const { prisma } = await import('./prisma.js');
const U = await import('./chatwoot-unidades.js');
const R = await import('./conta-da-requisicao.js');
const { chaveDoFunil } = await import('./funil-chatwoot.js');
const { apiRouter } = await import('../routes/api.routes.js');

const PARAU = U.SEMENTE_PARAUAPEBAS.slug;
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
  caixas: [{ id: 20, tipo: 'cloud' as const }, { id: 21, tipo: 'evolution' as const, instanciaEvolution: 'demo-unidade' }],
};
const AMBIENTE = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test', CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo' };
const SALVO = { ...process.env };

// ── o Chatwoot de mentira ────────────────────────────────────────────────────────────────────────
const PERFIS: Record<string, { id: number; name: string; email: string; accounts: Array<{ id: number; role: string }> } | 401> = {
  'tok-conta1': { id: 7, name: 'Ana da Conta 1', email: 'ana@example.com', accounts: [{ id: 1, role: 'agent' }] },
  'tok-conta2': { id: 8, name: 'Bia da Conta 2', email: 'bia@example.com', accounts: [{ id: 2, role: 'agent' }] },
  'tok-as-duas': { id: 9, name: 'Cris das Duas', email: 'cris@example.com', accounts: [{ id: 1, role: 'agent' }, { id: 2, role: 'agent' }] },
  'tok-ruim': 401,
};
let chamadas: string[] = [];
const fetchReal = globalThis.fetch;
function chatwootDeMentira() {
  return (async (url: string, o: { method?: string; headers?: Record<string, string> } = {}) => {
    const u = new URL(String(url));
    chamadas.push(`${o.method ?? 'GET'} ${u.pathname} [${o.headers?.['access-token'] ?? o.headers?.api_access_token ?? '-'}]`);
    const resp = (status: number, j: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(j), json: async () => j }) as Response;
    if (u.pathname === '/api/v1/profile') {
      const p = PERFIS[o.headers?.['access-token'] ?? ''];
      return p === 401 || !p ? resp(401, { error: 'x' }) : resp(200, p);
    }
    const conta = /\/accounts\/(\d+)\//.exec(u.pathname)?.[1];
    const marca = conta === '2' ? 'SEGREDO-DA-CONTA-2' : 'dado-da-conta-1';
    // a conta 2 «enxerga» também uma caixa de Parauapebas (3): configuração torta — a tela não pode listar a unidade dela
    if (/\/inboxes$/.test(u.pathname)) return resp(200, { payload: conta === '2' ? [{ id: 20, name: marca }, { id: 3, name: marca }] : [{ id: 3, name: marca }] });
    if (/\/conversations$/.test(u.pathname)) {
      const agora = Math.floor(Date.now() / 1000);
      const c = { id: 5, inbox_id: conta === '2' ? 20 : 3, status: 'open', labels: [], custom_attributes: { etapa: 'Novo lead' }, meta: { sender: { name: marca } }, timestamp: agora, last_activity_at: agora, created_at: agora - 60, unread_count: 0 };
      return resp(200, { data: { payload: u.searchParams.get('page') === '1' || !u.searchParams.get('page') ? [c] : [], meta: { all_count: 1 } } });
    }
    return resp(200, { payload: [], data: { payload: [], meta: { all_count: 0 } }, meta: { all_count: 0 }, name: marca });
  }) as unknown as typeof fetch;
}

// ── o servidor ───────────────────────────────────────────────────────────────────────────────────
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
function preparar() {
  Object.assign(process.env, AMBIENTE);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
  R.esquecerContextoDoAmbiente();
  chamadas = [];
  mock.method(globalThis, 'fetch', (async (url: string, o: never) => (String(url).startsWith(base) ? fetchReal(url, o) : chatwootDeMentira()(url, o))) as never);
}
afterEach(() => {
  mock.restoreAll();
  for (const k of Object.keys(process.env)) if (!(k in SALVO)) delete process.env[k];
  Object.assign(process.env, SALVO);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  R.esquecerContextoDoAmbiente();
});

// ── as rotas que usam o login do Chatwoot (lidas do próprio roteador, não de uma lista minha) ─────
interface Rota { metodo: 'get' | 'post' | 'delete'; caminho: string }
function rotasPublicas(): Rota[] {
  const l: Rota[] = [];
  for (const camada of (apiRouter as any).stack) {
    if (!camada.route) continue;
    for (const m of Object.keys(camada.route.methods)) l.push({ metodo: m as Rota['metodo'], caminho: String(camada.route.path) });
  }
  return l.filter((r) => r.caminho.startsWith('/public/'));
}
const COM_LOGIN = /^\/public\/(funil|robos|agente|assistente|aprendizados|testar-ia)(\/|$)/;
/** O resto das rotas públicas: autorizadas por código/segredo da unidade, token do widget ou HMAC — nenhuma usa o login do Chatwoot nem aceita `conta`. */
const SEM_LOGIN = /^\/public\/(pausa|central|evolution|chatwoot\/evento|widget|alta|ia|whatsapp)(\/|$)/;

test('GUARDA: toda rota /api/public é varrida pelo ataque (login do Chatwoot) ou está declarada como autorizada por código/segredo', () => {
  const rotas = rotasPublicas();
  assert.ok(rotas.length > 60, `achei só ${rotas.length} rotas públicas`);
  const soltas = rotas.filter((r) => !COM_LOGIN.test(r.caminho) && !SEM_LOGIN.test(r.caminho));
  assert.deepEqual(soltas, [], 'rota pública nova: ou usa o login do Chatwoot (entra no ataque) ou é autorizada por código — classifique');
  assert.ok(rotas.filter((r) => COM_LOGIN.test(r.caminho)).length >= 40);
});

function montar(r: Rota, query: string): { url: string; init: RequestInit } {
  const caminho = r.caminho.replace(/:slug/g, PARAU).replace(/:[a-zA-Z]+/g, '5');
  const corpo = { slug: PARAU, conversa: 5, conversaId: 5, pergunta: 'oi', nota: 'boa', acao: 'pausar', etapa: 'Novo lead', mensagem: 1, texto: 'Preciso de ajuda com a agenda da unidade, por favor.', como: 'ok', tipo: 'outro', caixaId: 3, nome: 'x', telefone: '11999990000' };
  return {
    url: `${base}/api${caminho}${caminho.includes('?') ? '' : '?'}${r.metodo === 'get' ? `slug=${PARAU}&conversa=5&` : ''}${query}`,
    init: { method: r.metodo.toUpperCase(), headers: { 'content-type': 'application/json', 'X-CW-Token': 'tok-conta1', 'X-CW-Client': 'c', 'X-CW-Uid': 'ana@example.com' }, body: r.metodo === 'get' ? undefined : JSON.stringify(corpo) },
  };
}
function comLogin(): Rota[] {
  return rotasPublicas().filter((r) => COM_LOGIN.test(r.caminho));
}

test('ATAQUE: sessão válida da conta 1 pedindo conta=2 → 403 («sem-conta») e NENHUM dado, em todas as rotas com login', async () => {
  preparar();
  const falhas: string[] = [];
  for (const r of comLogin()) {
    chamadas = [];
    const { url, init } = montar(r, 'conta=2');
    const res = await fetchReal(url, init);
    const texto = await res.text();
    if (res.status !== 403) falhas.push(`${r.metodo} ${r.caminho}: status ${res.status}`);
    else if (!texto.includes('"sessao":"sem-conta"') && !/não atende/.test(texto)) falhas.push(`${r.metodo} ${r.caminho}: corpo inesperado ${texto.slice(0, 80)}`);
    if (/SEGREDO|dado-da-conta/.test(texto)) falhas.push(`${r.metodo} ${r.caminho}: VAZOU dado`);
    const tocouConta = chamadas.filter((c) => /\/accounts\//.test(c));
    if (tocouConta.length) falhas.push(`${r.metodo} ${r.caminho}: falou com o Chatwoot numa conta: ${tocouConta.join(' | ')}`);
    if (chamadas.some((c) => c.includes('tk-do-ambiente') || c.includes('tk-so-da-demo'))) falhas.push(`${r.metodo} ${r.caminho}: usou token de serviço`);
  }
  assert.deepEqual(falhas, []);
});

test('ATAQUE: conta que nenhuma unidade usa (99), e a mesma conta que existe, recebem a MESMA recusa — não dá para descobrir quais contas existem', async () => {
  preparar();
  const r = { metodo: 'get' as const, caminho: '/public/funil/caixas' };
  const a = await fetchReal(montar(r, 'conta=2').url, montar(r, 'conta=2').init);
  const b = await fetchReal(montar(r, 'conta=99').url, montar(r, 'conta=99').init);
  assert.equal(a.status, 403);
  assert.equal(b.status, 403);
  assert.deepEqual(await a.json(), await b.json());
});

test('ATAQUE: `conta` torta (texto, negativa, zero, repetida, científica) → 400, sem falar com o Chatwoot', async () => {
  preparar();
  const r = { metodo: 'get' as const, caminho: '/public/funil/caixas' };
  for (const q of ['conta=abc', 'conta=-1', 'conta=0', 'conta=2&conta=1', 'conta=1e3', 'conta=', 'conta=0x2']) {
    chamadas = [];
    const { url, init } = montar(r, q);
    const res = await fetchReal(url, init);
    assert.equal(res.status, 400, q);
    assert.deepEqual(chamadas, [], q);
  }
});

test('`conta[]=2` (o formato de lista) não escolhe a conta 2: é ignorado e vale a conta do ambiente', async () => {
  preparar();
  const { url, init } = montar({ metodo: 'get', caminho: '/public/funil/caixas' }, 'conta[]=2');
  (init.headers as Record<string, string>)['X-CW-Token'] = 'tok-conta1';
  const res = await fetchReal(url, init);
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /SEGREDO/);
  assert.deepEqual(chamadas.filter((c) => /\/accounts\/2\//.test(c)), []);
});

test('ATAQUE (inverso): sessão que só é da conta 2 não abre a conta 1 — nem sem `conta` (o padrão) nem pedindo conta=1', async () => {
  preparar();
  const r = { metodo: 'get' as const, caminho: '/public/funil/caixas' };
  for (const q of ['', 'conta=1']) {
    const { url, init } = montar(r, q);
    (init.headers as Record<string, string>)['X-CW-Token'] = 'tok-conta2';
    const res = await fetchReal(url, init);
    assert.equal(res.status, 403, q || '(sem conta)');
    assert.doesNotMatch(await res.text(), /dado-da-conta|SEGREDO/);
  }
});

test('ATAQUE: o «já conferi» da conta 1 NÃO vale para a conta 2 (o cache da sessão leva a conta)', async () => {
  preparar();
  const r = { metodo: 'get' as const, caminho: '/public/funil/caixas' };
  const um = montar(r, '');
  assert.equal((await fetchReal(um.url, um.init)).status, 200, 'conta 1 (padrão): abre e guarda a conferência');
  const dois = montar(r, 'conta=2');
  chamadas = [];
  assert.equal((await fetchReal(dois.url, dois.init)).status, 403);
  assert.ok(chamadas.some((c) => c.startsWith('GET /api/v1/profile')), 'conferiu de novo no Chatwoot, em vez de reaproveitar a conferência da conta 1');
});

test('ATAQUE: link avulso (chave do funil) — a chave de Parauapebas não abre a conta 2; conta sem token próprio não abre por chave nenhuma', async () => {
  preparar();
  const r = { metodo: 'get' as const, caminho: '/public/funil/caixas' };
  const comChave = (chave: string, q: string) => {
    const { url, init } = montar(r, q);
    init.headers = { 'X-Funil-Chave': chave };
    return fetchReal(url, init);
  };
  const deParau = chaveDoFunil(AMBIENTE.CHATWOOT_API_TOKEN);
  assert.equal((await comChave(deParau, '')).status, 200, 'controle: a chave de Parauapebas abre Parauapebas, como sempre');
  assert.equal((await comChave(deParau, 'conta=2')).status, 403);
  assert.equal((await comChave(chaveDoFunil(AMBIENTE.CHATWOOT_API_TOKEN_DEMO), 'conta=2')).status, 200, 'a chave da própria conta 2 abre a conta 2');
  // a clínica sem token próprio cairia no token global: a chave global NÃO abre a conta dela
  delete process.env.CHATWOOT_API_TOKEN_DEMO;
  const sem = await comChave(deParau, 'conta=2');
  assert.equal(sem.status, 403);
  assert.deepEqual(chamadas.filter((c) => /\/accounts\/2\//.test(c)), chamadas.filter((c) => /\/accounts\/2\//.test(c)).slice(0, 1), 'a última tentativa não leu a conta 2');
});

test('CONTROLE: quem é membro das duas contas abre cada uma com o login DELE, na conta certa, com os dados dela', async () => {
  preparar();
  const r = { metodo: 'get' as const, caminho: '/public/funil/caixas' };
  const abre = async (q: string) => {
    const { url, init } = montar(r, q);
    (init.headers as Record<string, string>)['X-CW-Token'] = 'tok-as-duas';
    chamadas = [];
    const res = await fetchReal(url, init);
    return { status: res.status, texto: await res.text() };
  };
  const c1 = await abre('');
  const c2 = await abre('conta=2');
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);
  assert.match(c1.texto, /dado-da-conta-1/);
  assert.match(c2.texto, /SEGREDO-DA-CONTA-2/);
  assert.ok(chamadas.some((c) => c.startsWith('GET /api/v1/accounts/2/inboxes [tok-as-duas]')), 'a leitura da conta 2 foi com o login da pessoa');
});

test('ATAQUE: quem é das duas contas e pede a unidade de OUTRA conta (conta=2 + slug de Parauapebas) é recusado antes de ler qualquer coisa', async () => {
  preparar();
  for (const caminho of ['/public/robos', '/public/agente/painel', '/public/agente/pedidos', '/public/agente/registro', '/public/robos/enviados', '/public/robos/automacoes']) {
    const { url, init } = montar({ metodo: 'get', caminho }, 'conta=2');
    (init.headers as Record<string, string>)['X-CW-Token'] = 'tok-as-duas';
    chamadas = [];
    const res = await fetchReal(url, init);
    assert.equal(res.status, 403, caminho);
    assert.deepEqual(await res.json(), { error: 'você não atende esta unidade' }, caminho);
    assert.deepEqual(chamadas.filter((c) => /\/accounts\//.test(c)), [], caminho);
  }
});

test('CACHE das telas: a mesma pessoa em duas contas não recebe a resposta pronta de uma na outra', async () => {
  preparar();
  const r = { metodo: 'get' as const, caminho: '/public/funil/oportunidades' };
  const abre = async (q: string) => {
    const { url, init } = montar(r, q);
    (init.headers as Record<string, string>)['X-CW-Token'] = 'tok-as-duas';
    chamadas = [];
    const res = await fetchReal(url, init);
    return { status: res.status, corpo: (await res.json()) as { conta?: number } };
  };
  const a = await abre('');
  const b = await abre('conta=2');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.corpo.conta, 1);
  assert.equal(b.corpo.conta, 2, 'a conta 2 não pode vir do cache da conta 1');
  assert.ok(chamadas.some((c) => /\/accounts\/2\//.test(c)));
});

test('IDENTIDADE: sem `conta` tudo segue como antes — a conta do ambiente, o mesmo contexto, o token do ambiente', () => {
  preparar();
  const a = R.contextoDaRequisicao({ query: {} } as never);
  const b = R.contextoDaRequisicao({ query: { conta: '1' } } as never);
  assert.ok('ctx' in a && 'ctx' in b);
  if ('ctx' in a && 'ctx' in b) {
    assert.equal(a.ctx, b.ctx, 'conta=1 explícita é a mesma do ambiente: o MESMO objeto');
    assert.deepEqual(a.ctx.conta, { url: 'https://crm.exemplo.test', conta: 1, token: 'tk-do-ambiente' });
    assert.equal(a.propria, true);
  }
  const c = R.contextoDaRequisicao({ query: { conta: '2' } } as never);
  assert.ok('ctx' in c && c.ctx.conta?.conta === 2 && c.ctx.conta.token === 'tk-so-da-demo');
  for (const k of Object.keys(AMBIENTE)) delete process.env[k];
  assert.deepEqual(R.contextoDaRequisicao({ query: {} } as never), { status: 404, erro: 'desligado (CRM não configurado)' });
});

test('«agendou hoje»: a leitura da memória da régua leva o filtro de CAIXAS da conta — a conversa 5 de uma clínica não conta na outra', async () => {
  preparar();
  const wheres: Array<Record<string, any>> = [];
  const original = Object.getOwnPropertyDescriptor(prisma, 'chatwootReguaVisto');
  Object.defineProperty(prisma, 'chatwootReguaVisto', { value: { findMany: async (o: { where: Record<string, any> }) => (wheres.push(o.where), []), findFirst: async () => null }, configurable: true });
  try {
    const hoje = async (q: string) => {
      const { url, init } = montar({ metodo: 'get', caminho: '/public/funil/hoje' }, q);
      (init.headers as Record<string, string>)['X-CW-Token'] = 'tok-as-duas';
      return fetchReal(url, init);
    };
    wheres.length = 0;
    assert.equal((await hoje('conta=2')).status, 200);
    assert.ok(wheres.length > 0, 'leu a memória da régua');
    assert.deepEqual(wheres.map((w) => w.caixa), wheres.map(() => ({ in: [20, 21] })), 'conta 2: só as caixas dela');
    wheres.length = 0;
    assert.equal((await hoje('')).status, 200);
    assert.ok(wheres.length > 0);
    assert.deepEqual(wheres.map((w) => w.caixa), wheres.map(() => ({ notIn: [20, 21] })), 'conta 1: tudo menos as caixas de contas próprias');
  } finally {
    if (original) Object.defineProperty(prisma, 'chatwootReguaVisto', original);
    else delete (prisma as unknown as Record<string, unknown>).chatwootReguaVisto;
  }
});

test('IDENTIDADE do filtro: sem nenhuma clínica de conta própria, a conta do ambiente NÃO ganha filtro nenhum (a consulta é a de sempre)', () => {
  Object.assign(process.env, AMBIENTE);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  R.esquecerContextoDoAmbiente();
  const c = R.contextoDaRequisicao({ query: {} } as never);
  assert.ok('ctx' in c);
  if ('ctx' in c) assert.deepEqual(R.filtroDeCaixas(c.ctx), {});
});

test('«Testar a IA»: a lista de unidades da conta 2 só traz unidades que moram na conta 2 (mesmo que ela liste uma caixa de outra)', async () => {
  preparar();
  const pedidos: unknown[] = [];
  const original = Object.getOwnPropertyDescriptor(prisma, 'unit');
  Object.defineProperty(prisma, 'unit', { value: { findMany: async (o: { where: { slug: { in: string[] } } }) => (pedidos.push(o.where.slug.in), o.where.slug.in.map((slug) => ({ slug, name: slug }))) }, configurable: true });
  try {
    const { url, init } = montar({ metodo: 'get', caminho: '/public/testar-ia/unidades' }, 'conta=2');
    (init.headers as Record<string, string>)['X-CW-Token'] = 'tok-as-duas';
    const res = await fetchReal(url, init);
    assert.equal(res.status, 200);
    assert.deepEqual(pedidos, [['clinica-demonstracao']]);
    assert.deepEqual(((await res.json()) as { unidades: Array<{ slug: string }> }).unidades.map((u) => u.slug), ['clinica-demonstracao']);
  } finally {
    if (original) Object.defineProperty(prisma, 'unit', original);
    else delete (prisma as unknown as Record<string, unknown>).unit;
  }
});
