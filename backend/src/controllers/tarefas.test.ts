/**
 * Tela «Tarefas»: a página (parseia, sem sintaxe que o iPhone antigo não lê, só fala com a origem do Chatwoot, nada de innerHTML), o item no menu do CRM, a aba da
 * conversa criada pelo kit, e as rotas com o servidor de verdade e um Chatwoot de mentira: o que o servidor RECUSA antes de gravar (horário passado, janela de
 * 24 h sem modelo, conversa de outra clínica ou do histórico, responsável que não é da unidade), o WhatsApp das meninas que só a Doutor Digital cadastra, o
 * resultado da ligação que cria a próxima tentativa, e que NADA aqui escreve no paciente (a tela só grava tarefa; quem manda é o robô).
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

Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });
const { paginaDasTarefas } = await import('../lib/tarefas-pagina.js');
const { montarMenuJs } = await import('./funil.controller.js');
const U = await import('../lib/chatwoot-unidades.js');
const R = await import('../lib/conta-da-requisicao.js');
const Regras = await import('../lib/crm-tarefas/regras.js');
const { abasDaConta } = await import('../lib/kit-unidade/fase2.js');
const { apiRouter } = await import('../routes/api.routes.js');

const CW = 'https://atendimento.exemplo.test';

// ── a página ────────────────────────────────────────────────────────────────────────────────────────────────────

function scriptDaPagina(): string {
  const html = paginaDasTarefas(CW);
  const partes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.ok(partes.length >= 1);
  return partes[partes.length - 1]!;
}

test('a página das Tarefas parseia, só aceita a origem do Chatwoot, usa o molde (Inter, claro/escuro) e não usa innerHTML', () => {
  const html = paginaDasTarefas(CW);
  assert.doesNotThrow(() => new Function(scriptDaPagina()));
  assert.ok(html.includes(`origemDoPai(${JSON.stringify(CW)})`), 'a sessão só vem do pai na origem do Chatwoot');
  assert.ok(html.includes('!origemDoCrm(ev.origin) || ev.source !== window.parent'));
  assert.ok(!html.includes('__ORIGEM_CW__') && !html.includes('__LOGO_DD__') && !html.includes('__CONTA_JS__') && !html.includes('__ORIGENS_CW__'), 'nenhum marcador sobrou');
  assert.ok(html.includes('family=Inter') && html.includes('prefers-color-scheme:dark') && html.includes('--brand:#2781f6'), 'o mesmo molde das telas Disparos/Robôs');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(scriptDaPagina()), 'dado do servidor entra por textContent');
  assert.ok(html.includes('X-CW-Token') && html.includes('comConta('), 'login do Chatwoot e ?conta=N em toda chamada');
});

test('o JS da página não usa sintaxe nova demais (crase, ${}, ?., ??, lookbehind, ??=, fromEntries…): um iPhone antigo derruba o script inteiro', () => {
  const js = scriptDaPagina();
  assert.ok(!js.includes('`') && !js.includes('${'), 'a página é um String.raw: sem crase nem ${');
  assert.ok(!/\?\./.test(js), 'sem optional chaining');
  assert.ok(!/\?\?/.test(js), 'sem nullish coalescing');
  assert.ok(!/\(\?<[=!]/.test(js), 'sem lookbehind');
  assert.ok(!/Object\.fromEntries|\.flatMap\(|\.at\(|replaceAll|structuredClone|\.\.\.[A-Za-z_]/.test(js), 'sem APIs/sintaxe recentes (spread, flatMap, at, replaceAll)');
});

test('a página usa as rotas das Tarefas, e elas existem no roteador e no servidor', () => {
  const js = scriptDaPagina();
  for (const rota of ["'/api/public/tarefas?slug='", "'/api/public/tarefas/contexto?slug='", "'/api/public/tarefas/buscar?slug='", "'/api/public/tarefas/modelos?slug='", "'/api/public/tarefas'", "'/api/public/tarefas/zap'", "'/resultado'", "'/cancelar'", "'/confirmar'", "'/feita'", "'/editar'", "'/api/public/testar-ia/unidades'"]) {
    assert.ok(js.includes(rota), rota);
  }
  assert.ok(js.includes('chatwoot-dashboard-app:fetch-info') && js.includes("d.event === 'appContext'"), 'dentro da conversa recebe a conversa aberta');
  const rotas = readFileSync(new URL('../routes/api.routes.ts', import.meta.url), 'utf8');
  for (const r of [
    "apiRouter.get('/public/tarefas', tarefasHandler)",
    "apiRouter.get('/public/tarefas/contexto', tarefasContextoHandler)",
    "apiRouter.get('/public/tarefas/buscar', tarefasBuscarHandler)",
    "apiRouter.get('/public/tarefas/modelos', tarefasModelosHandler)",
    "apiRouter.post('/public/tarefas', tarefasCriarHandler)",
    "apiRouter.post('/public/tarefas/zap', tarefasZapHandler)",
    "apiRouter.post('/public/tarefas/:id/editar', tarefasEditarHandler)",
    "apiRouter.post('/public/tarefas/:id/cancelar', tarefasCancelarHandler)",
    "apiRouter.post('/public/tarefas/:id/confirmar', tarefasConfirmarHandler)",
    "apiRouter.post('/public/tarefas/:id/feita', tarefasFeitaHandler)",
    "apiRouter.post('/public/tarefas/:id/resultado', tarefasResultadoHandler)",
  ]) assert.ok(rotas.includes(r), r);
  const servidor = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(servidor.includes("app.get('/funil/tarefas', paginaTarefasHandler)"));
  assert.ok(servidor.includes('startCrmTarefasWorker();') && servidor.includes('stopCrmTarefasWorker();'), 'o worker sobe e desce com o servidor');
});

test('a página explica o modo seco, mostra que falta o WhatsApp da menina e obriga o modelo quando a janela não é garantida', () => {
  const js = scriptDaPagina();
  assert.ok(js.includes('Modo seco:') && js.includes('o robô ainda não manda nada'));
  assert.ok(js.includes('Falta o seu WhatsApp:'));
  assert.ok(js.includes('Modelo aprovado (obrigatório neste horário)') && js.includes('exigeModelo(F) && !ok'));
  assert.ok(js.includes('Registrar resultado') && js.includes('Não atendeu') && js.includes('Quer marcar a próxima tentativa?'));
});

test('o menu do Chatwoot ganha «Tarefas» (url /funil/tarefas, ícone próprio) e o menu.js continua parseando', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("nome: 'Tarefas'") && js.includes("url: '/funil/tarefas'") && js.includes("marca: 'data-tarefas-menu'"));
  assert.ok(js.includes('ICONES.tarefas'));
  assert.ok(js.includes("nome: 'Disparos'") && js.includes("nome: 'Robôs'") && js.includes("nome: 'Agente'"), 'as outras telas continuam');
});

test('o kit cria a aba «Tarefas» (Dashboard App da conversa) junto com a do Funil, com ?conta= e sem chave na URL', () => {
  const abas = abasDaConta('https://agente.exemplo.test', 7);
  assert.deepEqual(abas.map((a) => a.title), ['Funil', 'Tarefas']);
  assert.equal(abas[1]!.content[0]!.url, 'https://agente.exemplo.test/funil/tarefas?conta=7');
  assert.ok(!JSON.stringify(abas).includes('k='));
});

// ── o servidor de verdade, com Chatwoot e banco de mentira ──────────────────────────────────────────────────────

const PARAU = U.SEMENTE_PARAUAPEBAS.slug;
const AMBIENTE = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test', KIT_ADMINS_DD: 'suzanne.mychelly1@gmail.com,doutordigitalconsultoria@gmail.com' };
const SALVO = { ...process.env };
const PERFIS: Record<string, { id: number; name: string; email: string; accounts: Array<{ id: number; role: string }> }> = {
  'tok-agente': { id: 7, name: 'Ana Souza', email: 'ana@clinica.com', accounts: [{ id: 1, role: 'agent' }] },
  'tok-dd': { id: 9, name: 'Suzanne', email: 'suzanne.mychelly1@gmail.com', accounts: [{ id: 1, role: 'administrator' }] },
};
const INBOX_DA_CONVERSA: Record<number, number> = { 40: 3, 41: 2, 50: 9, 60: 4 };
let chamadas: string[] = [];
let ultimaMensagemEm: number | null = null;
const fetchReal = globalThis.fetch;
const MODELO_OK = { name: 'parau_retorno', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Oi {{1}}, tudo bem?' }] };

function chatwootDeMentira() {
  return (async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(String(url));
    chamadas.push(`${o.method ?? 'GET'} ${u.pathname}`);
    const resp = (status: number, j: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(j), json: async () => j }) as Response;
    if (u.pathname === '/api/v1/profile') {
      const p = PERFIS[o.headers?.['access-token'] ?? ''];
      return p ? resp(200, p) : resp(401, { error: 'x' });
    }
    if (/\/inboxes$/.test(u.pathname)) return resp(200, { payload: [{ id: 3, name: 'WhatsApp Parauapebas', channel_type: 'Channel::Whatsapp', provider: 'whatsapp_cloud' }, { id: 2, name: 'Celular', channel_type: 'Channel::Api' }, { id: 4, name: 'Histórico', channel_type: 'Channel::Api' }] });
    if (/\/inboxes\/3\/message_templates$/.test(u.pathname)) return resp(200, { payload: [MODELO_OK, { ...MODELO_OK, name: 'parau_pausado', status: 'PAUSED' }] });
    if (/\/inbox_members\/3$/.test(u.pathname)) return resp(200, { payload: [{ id: 7, name: 'Ana Souza' }, { id: 8, name: 'Bia Lima' }, { id: 77, name: '📱 Celular da unidade' }] });
    if (/\/inbox_members\/\d+$/.test(u.pathname)) return resp(200, { payload: [] });
    if (/\/agents$/.test(u.pathname)) return resp(200, [{ id: 7, name: 'Ana Souza' }]);
    const conv = /\/conversations\/(\d+)$/.exec(u.pathname);
    if (conv) {
      const inbox = INBOX_DA_CONVERSA[Number(conv[1])];
      return inbox ? resp(200, { id: Number(conv[1]), inbox_id: inbox, labels: [], meta: { sender: { id: 55, name: 'Maria Silva', phone_number: '+5594999990000' } }, custom_attributes: {}, created_at: 1760000000 }) : resp(404, { error: 'nao' });
    }
    if (/\/conversations\/\d+\/messages$/.test(u.pathname)) return resp(200, { payload: ultimaMensagemEm ? [{ id: 5, message_type: 0, created_at: Math.floor(ultimaMensagemEm / 1000) }] : [] });
    if (/\/contacts\/search$/.test(u.pathname)) return resp(200, { payload: [{ id: 55, name: 'Maria Silva', phone_number: '+5594999990000' }, { id: 56, name: '', phone_number: '' }] });
    if (/\/contacts\/55\/conversations$/.test(u.pathname)) return resp(200, { payload: [{ id: 40, inbox_id: 3, last_activity_at: 100 }, { id: 50, inbox_id: 9, last_activity_at: 900 }, { id: 60, inbox_id: 4, last_activity_at: 800 }] });
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

type Linha = Record<string, any>;
let tarefas: Linha[] = [];
let zaps: Linha[] = [];
let consultas: Linha[] = [];
const bate = (l: Linha, where: Linha): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('in' in v) return v.in.includes(l[k]);
      if ('notIn' in v) return !v.notIn.includes(l[k]);
      if ('gte' in v) return l[k] >= v.gte;
      if ('lte' in v) return l[k] <= v.lte;
      if ('gt' in v) return l[k] > v.gt;
      return true;
    }
    return v instanceof Date ? l[k]?.getTime() === v.getTime() : l[k] === v;
  });

function preparar() {
  Object.assign(process.env, AMBIENTE);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  R.esquecerContextoDoAmbiente();
  chamadas = [];
  tarefas = [];
  zaps = [];
  consultas = [];
  ultimaMensagemEm = Date.now() - 3_600_000;
  mock.method(globalThis, 'fetch', (async (url: string, o: never) => (String(url).startsWith(base) ? fetchReal(url, o) : chatwootDeMentira()(url, o))) as never);
  falso('unit', { findUnique: async (a: { where: { slug: string } }) => (a.where.slug === PARAU ? { id: 'u1', slug: PARAU, name: 'Doutor Hérnia Parauapebas', isActive: true, spineTimezone: 'America/Belem' } : null) });
  falso('unitAutomacao', { findMany: async () => [] });
  if (!originais.has('$transaction')) originais.set('$transaction', Object.getOwnPropertyDescriptor(prisma, '$transaction'));
  Object.defineProperty(prisma, '$transaction', { value: async (fn: (tx: unknown) => unknown) => fn(prisma), configurable: true, writable: true });
  falso('crmTarefa', {
    findMany: async (a: { where: Linha; orderBy?: Linha; take?: number }) => {
      consultas.push(a.where);
      let l = tarefas.filter((t) => bate(t, a.where));
      const campo = a.orderBy ? Object.keys(a.orderBy)[0] : null;
      if (campo) l = [...l].sort((x, y) => (a.orderBy![campo] === 'desc' ? -1 : 1) * (x[campo] - y[campo]));
      return a.take ? l.slice(0, a.take) : l;
    },
    findFirst: async (a: { where: Linha }) => (consultas.push(a.where), tarefas.find((t) => bate(t, a.where)) ?? null),
    count: async (a: { where: Linha }) => tarefas.filter((t) => bate(t, a.where)).length,
    create: async (a: { data: Linha }) => {
      const t = { id: `nova-${tarefas.length + 1}-abcdefgh`, estado: 'pendente', motivo: null, simuladoEm: null, simulado: null, lembreteEm: null, lembreteResumo: null, enviadaEm: null, resultado: null, resultadoPor: null, atualizadoEm: new Date(), criadoEm: new Date(), ...a.data };
      tarefas.push(t);
      return t;
    },
    updateMany: async (a: { where: Linha; data: Linha }) => {
      const alvo = tarefas.filter((t) => bate(t, a.where));
      alvo.forEach((t) => Object.assign(t, a.data));
      return { count: alvo.length };
    },
  });
  falso('crmTarefaZap', {
    findMany: async (a: { where: Linha }) => zaps.filter((z) => bate(z, a.where)),
    upsert: async (a: { where: { conta_agenteId: Linha }; create: Linha; update: Linha }) => {
      const k = a.where.conta_agenteId;
      const i = zaps.findIndex((z) => z.conta === k.conta && z.agenteId === k.agenteId);
      if (i >= 0) Object.assign(zaps[i]!, a.update);
      else zaps.push({ ...a.create });
      return {};
    },
    deleteMany: async (a: { where: Linha }) => {
      const antes = zaps.length;
      zaps = zaps.filter((z) => !bate(z, a.where));
      return { count: antes - zaps.length };
    },
  });
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

async function pedir(metodo: 'GET' | 'POST', caminho: string, token: string, corpo?: unknown) {
  const url = `${base}/api${caminho}`;
  const r = await fetchReal(url, { method: metodo, headers: { 'content-type': 'application/json', 'X-CW-Token': token, 'X-CW-Client': 'c', 'X-CW-Uid': 'x@x.com' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  return { status: r.status, corpo: (await r.json().catch(() => ({}))) as any };
}
/** «2026-11-…T10:00» no relógio da unidade (America/Belem) daqui a `ms` */
const local = (ms: number): string => Regras.utcParaLocal(new Date(Date.now() + ms), 'America/Belem');
const HORA = 3_600_000;
const nada_de_post = () => assert.deepEqual(chamadas.filter((c) => c.startsWith('POST') && !c.includes('/profile')), [], 'a tela nunca escreve no CRM: só grava a tarefa');

test('GET /tarefas: a unidade nasce em SECO; lista quem atende (sem o «📱 Celular»), mostra quem não tem WhatsApp e só a Doutor Digital vê os finais dos números', async () => {
  preparar();
  zaps.push({ conta: 1, agenteId: 7, telefone: '5594999990000' });
  const a = await pedir('GET', `/public/tarefas?slug=${PARAU}`, 'tok-agente');
  assert.equal(a.status, 200);
  assert.equal(a.corpo.modo, 'seco');
  assert.equal(a.corpo.fuso, 'America/Belem');
  assert.deepEqual(a.corpo.janela, { inicio: 8, fim: 20 });
  assert.equal(a.corpo.podeCadastrarZap, false);
  assert.deepEqual(a.corpo.atendentes.map((x: any) => [x.id, x.nome, x.temZap, x.zap]), [[7, 'Ana Souza', true, null], [8, 'Bia Lima', false, null]]);
  const dd = await pedir('GET', `/public/tarefas?slug=${PARAU}`, 'tok-dd');
  assert.equal(dd.corpo.podeCadastrarZap, true);
  assert.equal(dd.corpo.atendentes.find((x: any) => x.id === 7).zap, '…0000');
  assert.ok(!JSON.stringify(dd.corpo).includes('5594999990000'), 'o número inteiro nunca volta para a tela');
  nada_de_post();
});

test('criar mensagem com janela de 24 h aberta e texto livre: grava a tarefa (e NÃO manda nada ao paciente); a conversa vem com o login da pessoa', async () => {
  preparar();
  const r = await pedir('POST', '/public/tarefas', 'tok-agente', { slug: PARAU, tipo: 'mensagem', conversaId: 40, quandoLocal: local(3 * HORA), texto: 'Oi, Maria! Tudo certo para quinta?', responsavelId: 8 });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(tarefas.length, 1);
  assert.deepEqual([tarefas[0]!.unitId, tarefas[0]!.conta, tarefas[0]!.caixa, tarefas[0]!.conversaId, tarefas[0]!.contatoNome, tarefas[0]!.responsavelId, tarefas[0]!.responsavelNome, tarefas[0]!.criadoPor], ['u1', 1, 3, 40, 'Maria Silva', 8, 'Bia Lima', 'ana@clinica.com']);
  nada_de_post();
});

test('criar mensagem para depois da janela de 24 h SEM modelo → 422 «exigeModelo»; com modelo APROVADO grava (o texto do modelo vem do CRM, não do navegador)', async () => {
  preparar();
  const quando = local(40 * HORA);
  const sem = await pedir('POST', '/public/tarefas', 'tok-agente', { slug: PARAU, tipo: 'mensagem', conversaId: 40, quandoLocal: quando, texto: 'Oi!' });
  assert.equal(sem.status, 422);
  assert.equal(sem.corpo.exigeModelo, true);
  assert.match(sem.corpo.error, /janela de 24 h/);
  assert.equal(tarefas.length, 0);
  const pausado = await pedir('POST', '/public/tarefas', 'tok-agente', { slug: PARAU, tipo: 'mensagem', conversaId: 40, quandoLocal: quando, texto: '', modelo: { nome: 'parau_pausado', idioma: 'pt_BR', variaveis: ['primeiroNome'] } });
  assert.equal(pausado.status, 422, 'modelo pausado na Meta não serve');
  const ok = await pedir('POST', '/public/tarefas', 'tok-agente', { slug: PARAU, tipo: 'mensagem', conversaId: 40, quandoLocal: quando, texto: 'Oi!', modelo: { nome: 'parau_retorno', idioma: 'pt_BR', variaveis: ['primeiroNome'], texto: 'TEXTO FALSO DO NAVEGADOR' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  assert.equal(tarefas[0]!.modeloTexto, 'Oi {{1}}, tudo bem?', 'o texto do modelo é o do CRM');
  assert.deepEqual(tarefas[0]!.modeloVariaveis, ['primeiroNome']);
  // paciente que nunca escreveu: também só por modelo
  ultimaMensagemEm = null;
  const nunca = await pedir('POST', '/public/tarefas', 'tok-agente', { slug: PARAU, tipo: 'mensagem', conversaId: 40, quandoLocal: local(2 * HORA), texto: 'Oi' });
  assert.equal(nunca.status, 422);
  assert.equal(nunca.corpo.exigeModelo, true);
  nada_de_post();
});

test('o que o servidor recusa antes de gravar: horário que passou, data torta, responsável de fora, mensagem vazia, conversa de outra clínica ou do histórico', async () => {
  preparar();
  const base = { slug: PARAU, tipo: 'mensagem', conversaId: 40, quandoLocal: local(2 * HORA), texto: 'Oi' };
  const casos: Array<[string, Record<string, unknown>, number, RegExp]> = [
    ['passou', { quandoLocal: local(-24 * HORA) }, 400, /já passou/],
    ['data torta', { quandoLocal: '2026-02-31T10:00' }, 400, /dia e a hora/],
    ['responsável de fora', { responsavelId: 999 }, 422, /não atende esta unidade/],
    ['celular da unidade não é responsável', { responsavelId: 77 }, 422, /não atende esta unidade/],
    ['mensagem vazia', { texto: '   ' }, 422, /escreva a mensagem ou escolha um modelo/],
    ['outra clínica (caixa 9)', { conversaId: 50 }, 403, /não é de uma caixa desta unidade/],
    ['histórico (caixa 4: nem é caixa de envio da unidade)', { conversaId: 60 }, 403, /não é de uma caixa desta unidade/],
    ['conversa que não existe', { conversaId: 999 }, 404, /não tem acesso/],
    ['ligação com modelo', { tipo: 'ligacao', modelo: { nome: 'parau_retorno', idioma: 'pt_BR', variaveis: ['primeiroNome'] } }, 422, /só mensagem usa modelo/],
    ['tipo inventado', { tipo: 'whatsapp-em-massa' }, 400, /pedido inválido/],
  ];
  for (const [nome, extra, status, msg] of casos) {
    const r = await pedir('POST', '/public/tarefas', 'tok-agente', { ...base, ...extra });
    assert.equal(r.status, status, `${nome}: ${JSON.stringify(r.corpo)}`);
    assert.match(r.corpo.error, msg, nome);
  }
  assert.equal(tarefas.length, 0, 'nenhuma foi gravada');
});

test('criar pelo CONTATO escolhe a conversa mais recente DA UNIDADE (ignora outra clínica e o histórico); o mesmo pedido duas vezes não duplica', async () => {
  preparar();
  const corpo = { slug: PARAU, tipo: 'ligacao', contatoId: 55, quandoLocal: local(5 * HORA), texto: 'confirmar consulta' };
  const a = await pedir('POST', '/public/tarefas', 'tok-agente', corpo);
  assert.equal(a.status, 200, JSON.stringify(a.corpo));
  assert.equal(tarefas[0]!.conversaId, 40);
  const b = await pedir('POST', '/public/tarefas', 'tok-agente', corpo);
  assert.equal(b.corpo.repetida, true);
  assert.equal(b.corpo.id, a.corpo.id);
  assert.equal(tarefas.length, 1, 'toque duplo não vira duas tarefas');
  nada_de_post();
});

test('limite de tarefas abertas por conversa', async () => {
  preparar();
  for (let i = 0; i < 20; i++) tarefas.push({ id: `x${i}-abcdefgh`, unitId: 'u1', conta: 1, conversaId: 40, estado: 'pendente' });
  const r = await pedir('POST', '/public/tarefas', 'tok-agente', { slug: PARAU, tipo: 'lembrete', conversaId: 40, quandoLocal: local(2 * HORA), texto: 'ver' });
  assert.equal(r.status, 422);
  assert.match(r.corpo.error, /já tem 20 tarefas abertas/);
});

test('busca de contato e contexto da conversa (janela de 24 h): devolve o quanto a tela precisa e o telefone só mascarado', async () => {
  preparar();
  const b = await pedir('GET', `/public/tarefas/buscar?slug=${PARAU}&q=Maria`, 'tok-agente');
  assert.deepEqual(b.corpo.contatos, [{ id: 55, nome: 'Maria Silva', telefone: '…0000' }]);
  assert.deepEqual((await pedir('GET', `/public/tarefas/buscar?slug=${PARAU}&q=M`, 'tok-agente')).corpo.contatos, []);
  const c = await pedir('GET', `/public/tarefas/contexto?slug=${PARAU}&conversa=40`, 'tok-agente');
  assert.equal(c.status, 200);
  assert.deepEqual([c.corpo.conversaId, c.corpo.caixa, c.corpo.oficial, c.corpo.nome], [40, 3, true, 'Maria Silva']);
  assert.ok(c.corpo.modeloAPartirDe && new Date(c.corpo.modeloAPartirDe).getTime() > Date.now(), 'a janela está aberta agora');
  const m = await pedir('GET', `/public/tarefas/modelos?slug=${PARAU}&caixa=3`, 'tok-agente');
  assert.deepEqual(m.corpo.modelos.map((x: any) => x.nome), ['parau_retorno']);
  assert.equal((await pedir('GET', `/public/tarefas/modelos?slug=${PARAU}&caixa=99`, 'tok-agente')).status, 404);
  assert.equal((await pedir('GET', `/public/tarefas/contexto?slug=${PARAU}`, 'tok-agente')).status, 400);
  nada_de_post();
});

test('tarefa de OUTRA clínica/conta é «não encontrada» (a busca leva unidade E conta); id torto nem toca o banco', async () => {
  preparar();
  const r = await pedir('POST', '/public/tarefas/abcdefghij12/cancelar', 'tok-agente', { slug: PARAU });
  assert.equal(r.status, 404);
  assert.deepEqual(consultas[0], { id: 'abcdefghij12', unitId: 'u1', conta: 1 });
  consultas.length = 0;
  for (const id of ['1', 'a b c d e f g h', 'x'.repeat(80)]) {
    const t = await pedir('POST', `/public/tarefas/${encodeURIComponent(id)}/cancelar`, 'tok-agente', { slug: PARAU });
    assert.equal(t.status, 404, id);
  }
  assert.deepEqual(consultas, []);
});

test('cancelar, «já fiz», confirmar o atraso e editar respeitam o estado: o que está saindo não se mexe; o que terminou não se edita', async () => {
  preparar();
  const t = (estado: string, extra: Linha = {}) => (tarefas.push({ id: `t${tarefas.length}-abcdefgh`, unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoId: 55, contatoNome: 'Maria Silva', tipo: 'mensagem', quando: new Date(Date.now() + HORA), responsavelId: 7, responsavelNome: 'Ana Souza', texto: 'Oi', modeloNome: null, modeloVariaveis: [], estado, ...extra }), tarefas[tarefas.length - 1]!);
  const saindo = t('enviando');
  assert.equal((await pedir('POST', `/public/tarefas/${saindo.id}/cancelar`, 'tok-agente', { slug: PARAU })).status, 409);
  assert.equal((await pedir('POST', `/public/tarefas/${saindo.id}/feita`, 'tok-agente', { slug: PARAU })).status, 409);
  assert.equal(saindo.estado, 'enviando');
  const pronta = t('pendente');
  assert.equal((await pedir('POST', `/public/tarefas/${pronta.id}/confirmar`, 'tok-agente', { slug: PARAU })).status, 409, 'só quem está aguardando confirma');
  assert.equal((await pedir('POST', `/public/tarefas/${pronta.id}/cancelar`, 'tok-agente', { slug: PARAU })).status, 200);
  assert.equal(pronta.estado, 'cancelada');
  assert.equal((await pedir('POST', `/public/tarefas/${pronta.id}/cancelar`, 'tok-agente', { slug: PARAU })).status, 409, 'já terminou');
  assert.equal((await pedir('POST', `/public/tarefas/${pronta.id}/editar`, 'tok-agente', { slug: PARAU, tipo: 'mensagem', quandoLocal: local(2 * HORA), texto: 'novo' })).status, 409);
  const esperando = t('aguardando', { quando: new Date(Date.now() - 3 * HORA) });
  assert.equal((await pedir('POST', `/public/tarefas/${esperando.id}/confirmar`, 'tok-agente', { slug: PARAU })).status, 200);
  assert.equal(esperando.estado, 'pendente');
  assert.ok(esperando.confirmadaEm instanceof Date, 'o atraso passa a contar da confirmação');
  const feita = t('pendente');
  assert.equal((await pedir('POST', `/public/tarefas/${feita.id}/feita`, 'tok-agente', { slug: PARAU })).status, 200);
  assert.deepEqual([feita.estado, feita.resultadoPor], ['feita', 'ana@clinica.com']);
  nada_de_post();
});

test('editar uma tarefa pendente: o robô decide de novo (zera a decisão do seco, o lembrete e a confirmação); não troca o tipo', async () => {
  preparar();
  tarefas.push({ id: 'edit-1-abcdefgh', unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoId: 55, contatoNome: 'Maria Silva', tipo: 'ligacao', quando: new Date(Date.now() + HORA), responsavelId: 7, responsavelNome: 'Ana Souza', texto: 'velho', modeloNome: null, modeloVariaveis: [], estado: 'aguardando', simuladoEm: new Date(), simulado: 'x', lembreteEm: new Date(), lembreteResumo: 'y', confirmadaEm: new Date(), tentativas: 2 });
  const trocou = await pedir('POST', '/public/tarefas/edit-1-abcdefgh/editar', 'tok-agente', { slug: PARAU, tipo: 'mensagem', quandoLocal: local(2 * HORA), texto: 'Oi' });
  assert.equal(trocou.status, 400);
  const r = await pedir('POST', '/public/tarefas/edit-1-abcdefgh/editar', 'tok-agente', { slug: PARAU, tipo: 'ligacao', quandoLocal: local(4 * HORA), texto: 'novo', responsavelId: 8 });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  const t = tarefas[0]!;
  assert.deepEqual([t.estado, t.texto, t.responsavelNome, t.simuladoEm, t.lembreteEm, t.confirmadaEm, t.tentativas], ['pendente', 'novo', 'Bia Lima', null, null, null, 0]);
});

test('resultado da ligação: «atendeu» fecha; «não atendeu» pode criar a próxima tentativa; «remarcar» exige o novo horário; só ligação tem resultado', async () => {
  preparar();
  const lig = (extra: Linha = {}) => (tarefas.push({ id: `l${tarefas.length}-abcdefgh`, unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoId: 55, contatoNome: 'Maria Silva', tipo: 'ligacao', quando: new Date(Date.now() - HORA), responsavelId: 7, responsavelNome: 'Ana Souza', texto: 'confirmar', modeloNome: null, modeloVariaveis: [], estado: 'pendente', ...extra }), tarefas[tarefas.length - 1]!);
  const a = lig();
  assert.equal((await pedir('POST', `/public/tarefas/${a.id}/resultado`, 'tok-agente', { slug: PARAU, resultado: 'atendeu' })).status, 200);
  assert.deepEqual([a.estado, a.resultado], ['feita', 'atendeu']);
  assert.equal(tarefas.length, 1, 'atendeu não cria nada');
  assert.equal((await pedir('POST', `/public/tarefas/${a.id}/resultado`, 'tok-agente', { slug: PARAU, resultado: 'atendeu' })).status, 409, 'já tem resultado');

  const b = lig();
  const nao = await pedir('POST', `/public/tarefas/${b.id}/resultado`, 'tok-agente', { slug: PARAU, resultado: 'nao_atendeu', proximaLocal: local(26 * HORA) });
  assert.equal(nao.status, 200, JSON.stringify(nao.corpo));
  assert.ok(nao.corpo.proximaId);
  const prox = tarefas.find((t) => t.id === nao.corpo.proximaId)!;
  assert.deepEqual([prox.tipo, prox.estado, prox.conversaId, prox.responsavelId, prox.texto], ['ligacao', 'pendente', 40, 7, 'confirmar'], 'a próxima tentativa herda a conversa, a responsável e a anotação');

  const c = lig();
  assert.equal((await pedir('POST', `/public/tarefas/${c.id}/resultado`, 'tok-agente', { slug: PARAU, resultado: 'remarcar' })).status, 400, 'remarcar sem horário');
  assert.equal((await pedir('POST', `/public/tarefas/${c.id}/resultado`, 'tok-agente', { slug: PARAU, resultado: 'remarcar', proximaLocal: local(-5 * HORA) })).status, 400, 'remarcar para o passado');
  assert.equal(c.estado, 'pendente', 'recusado: nada mudou');
  assert.equal((await pedir('POST', `/public/tarefas/${c.id}/resultado`, 'tok-agente', { slug: PARAU, resultado: 'deu-ruim' })).status, 400);
  const msg = lig({ tipo: 'mensagem' });
  assert.equal((await pedir('POST', `/public/tarefas/${msg.id}/resultado`, 'tok-agente', { slug: PARAU, resultado: 'atendeu' })).status, 400);
  nada_de_post();
});

test('WhatsApp das meninas: só a administração da Doutor Digital cadastra; número torto é recusado; pessoa de fora é «não atende»; remover apaga', async () => {
  preparar();
  const nao = await pedir('POST', '/public/tarefas/zap', 'tok-agente', { slug: PARAU, agenteId: 7, telefone: '94 99999-0000' });
  assert.equal(nao.status, 403);
  assert.equal(zaps.length, 0);
  assert.equal((await pedir('POST', '/public/tarefas/zap', 'tok-dd', { slug: PARAU, agenteId: 7, telefone: '123' })).status, 400);
  assert.equal((await pedir('POST', '/public/tarefas/zap', 'tok-dd', { slug: PARAU, agenteId: 999, telefone: '94 99999-0000' })).status, 404);
  const ok = await pedir('POST', '/public/tarefas/zap', 'tok-dd', { slug: PARAU, agenteId: 7, telefone: '(94) 99999-0000' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.corpo, { ok: true, final: '…0000' });
  assert.deepEqual(zaps.map((z) => [z.conta, z.agenteId, z.telefone, z.atualizadoPor]), [[1, 7, '5594999990000', 'suzanne.mychelly1@gmail.com']]);
  const rem = await pedir('POST', '/public/tarefas/zap', 'tok-dd', { slug: PARAU, agenteId: 7, telefone: null });
  assert.equal(rem.status, 200);
  assert.equal(zaps.length, 0);
  nada_de_post();
});

test('com MAIS de 300 tarefas abertas (normal em seco) as de hoje e as próximas continuam na tela, e a tela diz quanto não coube', async () => {
  preparar();
  const agora = Date.now();
  // 300 atrasadas acumuladas em seco + 1 de hoje + 1 de amanhã + 1 esperando confirmação, a mais antiga de todas
  for (let i = 0; i < 300; i++) tarefas.push({ id: `velha${i}-abcdefgh`, unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoNome: 'Maria', tipo: 'ligacao', quando: new Date(agora - (i + 3) * 3_600_000), responsavelId: 7, responsavelNome: 'Ana Souza', texto: '', modeloNome: null, modeloVariaveis: [], estado: 'pendente' });
  tarefas.push({ id: 'hoje-1-abcdefgh', unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoNome: 'Maria', tipo: 'mensagem', quando: new Date(agora + 2 * 3_600_000), responsavelId: 7, responsavelNome: 'Ana Souza', texto: 'Oi', modeloNome: null, modeloVariaveis: [], estado: 'pendente' });
  tarefas.push({ id: 'amanha-1-abcdefgh', unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoNome: 'Maria', tipo: 'mensagem', quando: new Date(agora + 30 * 3_600_000), responsavelId: 7, responsavelNome: 'Ana Souza', texto: 'Oi', modeloNome: null, modeloVariaveis: [], estado: 'pendente' });
  tarefas.push({ id: 'espera-1-abcdefgh', unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoNome: 'Maria', tipo: 'mensagem', quando: new Date(agora - 900 * 3_600_000), responsavelId: 7, responsavelNome: 'Ana Souza', texto: 'Oi', modeloNome: null, modeloVariaveis: [], estado: 'aguardando' });
  assert.equal(tarefas.length, 303);
  const r = await pedir('GET', `/public/tarefas?slug=${PARAU}`, 'tok-agente');
  assert.equal(r.status, 200);
  const ids = r.corpo.tarefas.map((t: any) => t.id);
  assert.ok(ids.includes('hoje-1-abcdefgh') && ids.includes('amanha-1-abcdefgh'), 'hoje e amanhã NÃO somem por causa das atrasadas');
  assert.ok(ids.includes('espera-1-abcdefgh'), 'quem espera confirmação vem sempre, por mais antiga que seja');
  assert.equal(r.corpo.tarefas.filter((t: any) => t.id.startsWith('velha')).length, 150, 'das atrasadas, as 150 mais recentes');
  assert.ok(ids.includes('velha0-abcdefgh') && !ids.includes('velha299-abcdefgh'));
  assert.deepEqual(r.corpo.escondidas, { atrasadas: 150, proximas: 0 }, 'a tela diz quantas não couberam (301 atrasadas ou esperando − 151 mostradas)');
});
