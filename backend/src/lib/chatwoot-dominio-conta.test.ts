/**
 * O endereço da clínica abre a conta dela: chegada (redireciona), troca de propósito (faixa, nunca puxa de volta), sem laço, sem acesso = nada,
 * hash preservado, domínio principal e sem clínica = nada. DOM de mentira (sem navegador).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { dominioContaJs, mapaParaOMenu } = await import('./chatwoot-dominio-conta.js');
const U = await import('./chatwoot-unidades.js');
const { montarMenuJs } = await import('../controllers/funil.controller.js');

const MAPA = { drtimbo: 3, drherniaparauapebas: 1, demo: 2 };
const COOKIE = 'cw_d_session_info=' + encodeURIComponent(JSON.stringify({ 'access-token': 't', client: 'c', uid: 'u' }));

class No {
  filhos: No[] = [];
  atributos: Record<string, string> = {};
  textContent = '';
  className = '';
  id = '';
  type = '';
  title = '';
  parentNode: No | null = null;
  onclick: (() => void) | null = null;
  constructor(public tag: string) {}
  appendChild(n: No) { n.parentNode = this; this.filhos.push(n); return n; }
  removeChild(n: No) { this.filhos = this.filhos.filter((x) => x !== n); n.parentNode = null; return n; }
  setAttribute(k: string, v: string) { this.atributos[k] = v; }
  todos(): No[] { return [this, ...this.filhos.flatMap((f) => f.todos())]; }
}

interface Cenario { host: string; caminho: string; busca?: string; hash?: string; contas?: Array<{ id: number; name: string }> | 'falha' | 'sem-rede'; cookie?: boolean; estado?: unknown; semStorage?: boolean }

function montar(c: Cenario) {
  const body = new No('body');
  const head = new No('head');
  const storage = new Map<string, string>();
  if (c.estado !== undefined) storage.set('dd-dominio-conta', JSON.stringify(c.estado));
  const trocas: string[] = [];
  const loc = {
    hostname: c.host, pathname: c.caminho, search: c.busca ?? '', hash: c.hash ?? '',
    replace: (u: string) => trocas.push('replace ' + u),
    assign: (u: string) => trocas.push('assign ' + u),
  };
  const ouvintes: Record<string, Array<() => void>> = {};
  const timers: Array<() => void> = [];
  const hist: Record<string, (a: unknown, b: unknown, url: string) => void> = {
    pushState: (_a: unknown, _b: unknown, url: string) => { loc.pathname = url; },
    replaceState: (_a: unknown, _b: unknown, url: string) => { loc.pathname = url; },
  };
  const doc = {
    cookie: c.cookie === false ? '' : COOKIE,
    body, head, documentElement: new No('html'),
    createElement: (t: string) => new No(t),
    getElementById: (id: string) => [...head.todos(), ...body.todos()].find((n) => n.id === id) ?? null,
  };
  const win: Record<string, unknown> = { addEventListener: (k: string, f: () => void) => (ouvintes[k] ??= []).push(f) };
  win.top = win;
  let pedidosPerfil = 0;
  const fetchFalso = async (url: string) => {
    assert.equal(url, '/api/v1/profile');
    pedidosPerfil++;
    if (c.contas === 'sem-rede') throw new Error('offline');
    if (c.contas === 'falha') return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ accounts: c.contas ?? [] }) };
  };
  const sessionStorage = c.semStorage
    ? { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); }, removeItem: () => { throw new Error('bloqueado'); } }
    : { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  const js = dominioContaJs(MAPA);
  assert.ok(js, 'o bloco existe com um mapa');
  new Function('window', 'document', 'location', 'history', 'sessionStorage', 'fetch', 'setInterval', 'setTimeout', js)(win, doc, loc, hist, sessionStorage, fetchFalso, (f: () => void) => timers.push(f), (f: () => void) => f());
  return {
    trocas, loc, hist, doc, body, storage, pedidos: () => pedidosPerfil,
    estado: () => JSON.parse(storage.get('dd-dominio-conta') ?? 'null'),
    soltar: async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); },
    relogio: () => timers.forEach((f) => f()),
    popstate: () => (ouvintes.popstate ?? []).forEach((f) => f()),
    faixa: () => body.todos().find((n) => n.atributos['data-dd-dominio']) ?? null,
  };
}

const TODAS = [{ id: 1, name: 'Doutor Hérnia Parauapebas' }, { id: 3, name: 'Doutor Hérnia Timbó' }];

test('CHEGADA em outra conta no endereço da clínica (e a pessoa tem a conta dela): vai para a MESMA rota na conta da clínica, sem laço', async () => {
  const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS });
  await a.soltar();
  assert.deepEqual(a.trocas, ['replace /app/accounts/3/dashboard'], 'replace (sem entrada no histórico), uma vez');
  assert.equal(a.pedidos(), 1);
  assert.equal(a.estado().conta, 3);
  // a página recarrega já na conta certa (mesma aba): nada mais acontece
  const b = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/3/dashboard', contas: TODAS, estado: a.estado() });
  await b.soltar();
  assert.deepEqual(b.trocas, []);
  assert.equal(b.pedidos(), 0, 'já está na conta da clínica: nem pede o perfil');
});

test('o #hash e a busca ficam (abas Agente/Funil/Tarefas); rota com número de recurso (conversa) vai para o painel da conta da clínica', async () => {
  const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', busca: '?conta=1', hash: '#agente', contas: TODAS });
  await a.soltar();
  assert.deepEqual(a.trocas, ['replace /app/accounts/3/dashboard?conta=1#agente']);
  const b = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/settings/inbox/list', contas: TODAS });
  await b.soltar();
  assert.deepEqual(b.trocas, ['replace /app/accounts/3/settings/inbox/list']);
  const c = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/conversations/55', busca: '?x=1', hash: '#funil', contas: TODAS });
  await c.soltar();
  assert.deepEqual(c.trocas, ['replace /app/accounts/3/dashboard#funil'], 'o 55 é da conta 1: não existe na 3');
});

test('SEM acesso à conta da clínica (ou sem perfil/sessão/rede): nunca redireciona e não mostra faixa', async () => {
  for (const contas of [[{ id: 1, name: 'P' }], [], 'falha', 'sem-rede'] as const) {
    const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: contas as never });
    await a.soltar();
    assert.deepEqual(a.trocas, [], JSON.stringify(contas));
    assert.equal(a.faixa(), null);
  }
  const semSessao = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, cookie: false });
  await semSessao.soltar();
  assert.deepEqual(semSessao.trocas, []);
  assert.equal(semSessao.pedidos(), 0);
});

test('atendente com UMA conta só: nada muda (já está nela, ou não tem a da clínica)', async () => {
  const naDela = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/3/dashboard', contas: [{ id: 3, name: 'Timbó' }] });
  await naDela.soltar();
  assert.deepEqual(naDela.trocas, []);
  assert.equal(naDela.faixa(), null);
});

test('domínio principal, host fora do domínio e endereço sem clínica no mapa: o bloco não faz nada (nem pede o perfil)', async () => {
  for (const host of ['atendimento.doutordigitalconsultoria.com', 'desconhecida.doutordigitalconsultoria.com', 'doutordigitalconsultoria.com', 'drtimbo.outrodominio.com', 'localhost', 'drtimbo.doutordigitalconsultoria.com.evil.com']) {
    const a = montar({ host, caminho: '/app/accounts/1/dashboard', contas: TODAS });
    await a.soltar();
    assert.deepEqual(a.trocas, [], host);
    assert.equal(a.pedidos(), 0, host);
  }
});

test('TROCA DE PROPÓSITO pelo seletor (a conta da URL muda com a aba aberta): NÃO puxa de volta — mostra a faixa com os nomes e o botão; o botão vai para a clínica', async () => {
  const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/3/dashboard', contas: TODAS });
  await a.soltar();
  assert.equal(a.faixa(), null, 'na conta da clínica: sem faixa');
  a.hist.pushState(null, '', '/app/accounts/1/dashboard'); // o seletor de contas troca a rota sem recarregar
  a.relogio();
  await a.soltar();
  assert.deepEqual(a.trocas, [], 'não redireciona');
  const f = a.faixa();
  assert.ok(f, 'faixa aparece');
  const textos = f!.todos().map((n) => n.textContent).filter(Boolean);
  assert.ok(textos.includes('Você está no endereço de Doutor Hérnia Timbó vendo Doutor Hérnia Parauapebas — ir para Doutor Hérnia Timbó?'), textos.join(' | '));
  const botao = f!.todos().find((n) => n.className === 'dd-ir')!;
  assert.equal(botao.textContent, 'Ir para Doutor Hérnia Timbó');
  botao.onclick!();
  assert.deepEqual(a.trocas, ['assign /app/accounts/3/dashboard']);
  // voltou para a conta da clínica (pelo seletor): a faixa some
  a.loc.pathname = '/app/accounts/3/dashboard';
  a.relogio();
  await a.soltar();
  assert.equal(a.faixa(), null);
});

test('RECARREGAR depois da troca de propósito (a aba lembra): continua na outra conta, com faixa, sem puxar de volta', async () => {
  const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, estado: { conta: 1 } });
  await a.soltar();
  assert.deepEqual(a.trocas, []);
  assert.ok(a.faixa());
  // e quem trocou da clínica para a outra e recarrega
  const b = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, estado: { conta: 3 } });
  await b.soltar();
  assert.deepEqual(b.trocas, []);
  assert.ok(b.faixa());
});

test('SEM LAÇO: o Chatwoot devolve para a outra conta logo depois do redirecionamento → vira faixa, não redireciona de novo; sem sessionStorage nada acontece', async () => {
  const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, estado: { conta: 3, redirecionouEm: Date.now() } });
  await a.soltar();
  assert.deepEqual(a.trocas, []);
  assert.ok(a.faixa());
  // chegada «sem estado» mas com marca de redirecionamento recente (estado parcial): também não repete
  const b = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, estado: { redirecionouEm: Date.now() } });
  await b.soltar();
  assert.deepEqual(b.trocas, []);
  const c = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, semStorage: true });
  await c.soltar();
  assert.deepEqual(c.trocas, [], 'sem como lembrar a chegada, não redireciona (evita laço)');
});

test('chegada de uma aba que estava FORA de qualquer conta (login, perfil): a próxima conta vista conta como chegada e redireciona', async () => {
  const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/profile/settings', contas: TODAS });
  await a.soltar();
  assert.deepEqual(a.trocas, [], 'sem conta na URL: nada, mas lembra que estava fora');
  assert.equal(a.estado().conta, null);
  const b = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, estado: { conta: null } });
  await b.soltar();
  assert.deepEqual(b.trocas, ['replace /app/accounts/3/dashboard']);
});

test('fechar a faixa a dispensa para aquela conta, mesmo recarregando', async () => {
  const a = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, estado: { conta: 1 } });
  await a.soltar();
  a.faixa()!.todos().find((n) => n.className === 'dd-fechar')!.onclick!();
  assert.equal(a.faixa(), null);
  const b = montar({ host: 'drtimbo.doutordigitalconsultoria.com', caminho: '/app/accounts/1/dashboard', contas: TODAS, estado: a.estado() });
  await b.soltar();
  assert.equal(b.faixa(), null);
});

test('o menu.js leva o bloco (e PARSEIA) só com subdomínio → conta; mapa vazio = sem bloco; nada de nome de clínica, e-mail ou paciente', () => {
  const js = montarMenuJs('https://agente.exemplo.test', [], MAPA);
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('__dominioContaDD') && js.includes('{"drtimbo":3,"drherniaparauapebas":1,"demo":2}'));
  assert.ok(!js.includes('__MAPA__'));
  const sem = montarMenuJs('https://agente.exemplo.test', [], {});
  assert.ok(!sem.includes('__dominioContaDD'));
  assert.doesNotThrow(() => new Function(sem));
  assert.deepEqual(mapaParaOMenu({ drtimbo: 3, 'ruim/x': 4, ab: 5, ok123: -1, otimo: 2.5, certo: 9 } as never), { drtimbo: 3, certo: 9 }, 'só subdomínio válido → inteiro > 0');
  assert.ok(montarMenuJs('https://agente.exemplo.test').length > 1000);
});

test('o mapa do SERVIDOR: Parauapebas = conta do ambiente; Timbó (conta 3, SEM caixa) entra; linha crua sem conta própria nunca vira conta do ambiente; subdomínio repetido com contas diferentes fica de fora', () => {
  U.aplicarDominios([
    { subdominio: 'drtimbo', contaId: 3 },
    { subdominio: 'demo', contaId: 2 },
    { subdominio: 'semconta', contaId: null },
    { subdominio: 'repetido', contaId: 5 },
    { subdominio: 'repetido', contaId: 6 },
    { subdominio: 'Invalido', contaId: 7 },
  ]);
  try {
    assert.deepEqual(U.dominiosDasClinicas(1), { drherniaparauapebas: 1, drtimbo: 3, demo: 2 });
    assert.deepEqual(U.dominiosDasClinicas(null), { drtimbo: 3, demo: 2 }, 'sem conta do ambiente, Parauapebas não entra');
  } finally {
    U.aplicarDominios([]);
  }
});
