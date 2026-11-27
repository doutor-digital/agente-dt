/**
 * O selo da Sofia no CRM: o bloco entra no `menu.js` (independente, num try), parseia, só LÊ, usa o mesmo nome de etiqueta que o servidor põe
 * e, rodando num DOM de mentira, marca o cartão da lista e a barra da conversa aberta — e tira os dois quando a etiqueta sai.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const S = await import('./chatwoot-selo-sofia.js');
const { ETIQUETA_SOFIA_ATENDENDO } = await import('./chatwoot-sofia-atendendo.js');
const { montarMenuJs } = await import('../controllers/funil.controller.js');

test('a etiqueta do selo é a mesma que o servidor põe na conversa', () => {
  assert.equal(S.ETIQUETA_DO_SELO, ETIQUETA_SOFIA_ATENDENDO);
});

test('o bloco: ligado por padrão, «0» desliga; parseia; só lê; nada de dado vira HTML; encaixes trocados', () => {
  assert.equal(S.seloDaSofiaLigado({} as NodeJS.ProcessEnv), true);
  assert.equal(S.seloDaSofiaLigado({ CHATWOOT_SELO_SOFIA: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(S.seloSofiaJs({ CHATWOOT_SELO_SOFIA: '0' } as NodeJS.ProcessEnv), '');
  const js = S.seloSofiaJs({} as NodeJS.ProcessEnv);
  assert.doesNotThrow(() => new Function(js));
  assert.doesNotMatch(js, /__ETIQUETA__/);
  assert.ok(js.includes(JSON.stringify(ETIQUETA_SOFIA_ATENDENDO)));
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|setAttribute\('on/i);
  // só lê: o único fetch é um GET da conversa aberta (reserva), sem método de escrita, sem armazenamento local
  assert.equal((js.match(/fetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(js, /method:\s*'(POST|PUT|PATCH|DELETE)'/i);
  assert.doesNotMatch(js, /localStorage|sessionStorage|XMLHttpRequest/);
  // sem relógio curto: nada de setInterval; o freio do observador é de 400 ms
  assert.doesNotMatch(js, /setInterval\(/);
  assert.match(js, /new MutationObserver/);
  // o freio de 400 ms entre passadas segue (a primeira mudança depois de uma pausa passa já, a rajada é contada)
  assert.match(js, /setTimeout\(passar, Math\.max\(0, 400 - \(Date\.now\(\) - ultima\)\)\)/);
  // textos do pedido do João
  assert.ok(js.includes('🤖 Sofia atendendo'));
  assert.ok(js.includes('🤖 A Sofia (IA) está atendendo esta conversa'));
  assert.ok(js.includes('#7C3AED'));
});

test('menu.js: o selo da Sofia está no arquivo, em bloco próprio com try, e o arquivo todo PARSEIA', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('__seloSofiaDD'), 'o bloco do selo está no menu.js');
  const i = js.indexOf('window.__seloSofiaDD');
  assert.match(js.slice(js.lastIndexOf(';try{', i), i), /^;try\{\s*\(function\(\)\{/, 'o bloco abre num try próprio');
  assert.match(js.trimEnd(), /\}catch\(e\)\{\}$/, 'e fecha com o catch');
  // o menu, a assistente e o guia continuam lá
  assert.ok(js.includes('window.__funilMenu') && js.includes('window.__guiaEtapaDD'));
});

// ── um DOM de mentira, só o que o bloco usa ───────────────────────────────────────────────────────────────────────
class No {
  children: No[] = [];
  parent: No | null = null;
  attrs: Record<string, string> = {};
  classes: string[];
  constructor(public tag: string, classes = '', private texto = '') {
    this.classes = classes.split(' ').filter(Boolean);
  }
  get textContent(): string {
    return this.texto + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.texto = v;
    this.children = [];
  }
  set title(_v: string) {}
  get firstChild() {
    return this.children[0] ?? null;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  add(n: No) {
    n.parent = this;
    this.children.push(n);
    return n;
  }
  appendChild(n: No) {
    n.parent?.children.splice(n.parent.children.indexOf(n), 1);
    return this.add(n);
  }
  insertBefore(n: No, ref: No | null) {
    n.parent?.children.splice(n.parent.children.indexOf(n), 1);
    n.parent = this;
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, n);
    return n;
  }
  remove() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k: string) {
    return k in this.attrs;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  todos(): No[] {
    return this.children.flatMap((c) => [c, ...c.todos()]);
  }
  querySelectorAll(sel: string): No[] {
    return this.todos().filter((n) => casa(n, sel));
  }
  querySelector(sel: string): No | null {
    if (sel.startsWith(':scope > ')) return this.children.find((n) => casa(n, sel.slice(9))) ?? null;
    return this.querySelectorAll(sel)[0] ?? null;
  }
}
function casa(n: No, sel: string): boolean {
  if (sel.includes(',')) return sel.split(',').some((x) => casa(n, x.trim()));
  if (sel.startsWith('.')) return n.classes.includes(sel.slice(1));
  const a = sel.match(/^\[([\w-]+)\]$/);
  if (a) return n.hasAttribute(a[1]);
  const e = sel.match(/^style\[([\w-]+)\]$/);
  if (e) return n.tag === 'style' && n.hasAttribute(e[1]);
  return false;
}

function mundo(labelsDoEstado: string[] | null, idUrl: number | null, rede?: (url: string) => Promise<unknown>) {
  const body = new No('body');
  const head = new No('head');
  const html = new No('html');
  html.add(head);
  html.add(body);
  const selecionada = { id: idUrl, labels: labelsDoEstado };
  const doc: any = Object.assign(body, {
    cookie: '',
    head,
    documentElement: html,
    visibilityState: 'visible',
    addEventListener: () => {},
    createElement: (t: string) => new No(t),
    getElementById: (id: string) => (id === 'app' ? { __vue_app__: { config: { globalProperties: { $store: { getters: { getSelectedChat: labelsDoEstado ? selecionada : null } } } } } } : null),
  });
  doc.querySelectorAll = (s: string) => html.querySelectorAll(s);
  doc.querySelector = (s: string) => html.querySelector(s);
  const timers: Array<{ f: () => void; ms: number }> = [];
  const atrasos: number[] = [];
  const relogio = { t: 1_000_000 };
  const sessaoCookie = encodeURIComponent(JSON.stringify({ 'access-token': 'a', client: 'c', uid: 'u' }));
  doc.cookie = `cw_d_session_info=${sessaoCookie}`;
  const idsBuscados: string[] = [];
  const loc = { pathname: idUrl ? `/app/accounts/2/conversations/${idUrl}` : '/app/accounts/2/dashboard' };
  let observador: (() => void) | null = null;
  class MO {
    constructor(f: () => void) {
      observador = f;
    }
    observe() {}
  }
  const janela: any = {};
  janela.top = janela;
  const rodar = (js: string) => new Function('window', 'document', 'location', 'MutationObserver', 'setTimeout', 'fetch', 'Date', js)(
    janela,
    doc,
    loc,
    MO,
    (f: () => void, ms: number) => {
      atrasos.push(ms);
      return timers.push({ f, ms });
    },
    (url: string) => {
      idsBuscados.push(url);
      return rede ? rede(url) : Promise.reject(new Error('sem rede no teste'));
    },
    { now: () => relogio.t },
  );
  // passa(): roda só os timers curtos (o freio de 400 ms); a tentativa da API (segundos) só dispara quando o teste mandar (disparar)
  const passa = () => {
    const curtos = timers.filter((t) => t.ms <= 400);
    curtos.forEach((t) => timers.splice(timers.indexOf(t), 1));
    curtos.forEach((t) => t.f());
  };
  const disparar = () => {
    const longos = timers.splice(0);
    longos.forEach((t) => t.f());
  };
  return { doc, body, rodar, passa, disparar, longosPendentes: () => timers.filter((t) => t.ms > 400).length, selecionada, loc, atrasos, relogio, idsBuscados, avisar: () => observador?.() };
}

/** Cartão CONDENSADO (ConversationCard.vue + ui/Label.vue): o 1º filho guarda o avatar; a pílula é `.label`. `semAvatar` = hide-thumbnail. */
function cartao(nome: string, etiquetas: string[], semAvatar = false) {
  const c = new No('div', 'conversation');
  const av = c.add(new No('div', 'relative'));
  if (!semAvatar) av.add(new No('span', 'avatar'));
  const corpo = c.add(new No('div', 'flex-1'));
  corpo.add(new No('h4', 'conversation--user', nome));
  const lab = corpo.add(new No('div'));
  for (const e of etiquetas) {
    const l = lab.add(new No('div', 'inline-flex label'));
    l.add(new No('span', 'label-color-dot'));
    l.add(new No('span', '', ` ${e} `));
  }
  return c;
}

/** Cartão EXPANDIDO do 4.19.1 (ConversationCardExpanded.vue → CardLabelsV5.vue → components-next/label/Label.vue): a pílula é `div[data-label]`, SEM `.label`. */
function cartaoExpandido(nome: string, etiquetas: string[]) {
  const c = new No('div', 'conversation relative grid');
  const esquerda = c.add(new No('div', 'flex'));
  esquerda.add(new No('div', 'checkbox'));
  esquerda.add(new No('h4', 'text-heading-3', nome)); // no expandido o nome NÃO tem a classe conversation--user
  const dir = c.add(new No('div', 'flex'));
  const caixa = dir.add(new No('div', 'flex', ''));
  caixa.attrs['data-labels-container'] = '';
  for (const e of etiquetas) {
    const l = caixa.add(new No('div', 'rounded-lg inline-flex bg-n-label-color'));
    l.attrs['data-label'] = '';
    l.add(new No('span', 'rounded-sm'));
    l.add(new No('span', 'whitespace-nowrap text-label-small', `\n      ${e}\n    `));
  }
  return c;
}

test('lista: o cartão com a pílula «sofia-atendendo» é marcado (condensado e expandido); os outros não; some quando a etiqueta sai', () => {
  const m = mundo(null, null);
  const lista = m.body.add(new No('div'));
  const a = lista.add(cartao('Maria', ['quente', 'sofia-atendendo']));
  const b = lista.add(cartao('João', ['alta']));
  const c = lista.add(cartaoExpandido('Ana', ['alta', 'sofia-atendendo']));
  const f = lista.add(cartao('Pedro (conversas anteriores)', ['sofia-atendendo'], true));
  const g = lista.add(cartaoExpandido('Caio', ['alta']));
  // uma mensagem de paciente que só diz o nome da etiqueta NÃO conta: só a pílula (.label)
  const d = lista.add(cartao('Rui', []));
  d.add(new No('p', '', 'sofia-atendendo'));
  // quase igual não conta
  const e = lista.add(cartao('Bia', ['sofia-atendendo-2', 'a-sofia-atendendo']));
  m.rodar(S.seloSofiaJs({}));
  m.passa();
  assert.equal(a.getAttribute('data-dd-sofia'), 'c');
  assert.equal(b.getAttribute('data-dd-sofia'), null);
  assert.equal(c.getAttribute('data-dd-sofia'), 'e', 'o expandido (div[data-label], sem .label) também é marcado');
  assert.equal(f.getAttribute('data-dd-sofia'), 'h', 'condensado sem avatar (painel do contato): selo mais à esquerda');
  assert.equal(g.getAttribute('data-dd-sofia'), null);
  assert.equal(d.getAttribute('data-dd-sofia'), null);
  assert.equal(e.getAttribute('data-dd-sofia'), null);
  assert.ok(m.doc.querySelector('style[data-dd-sofia-estilo]'), 'o CSS entrou uma vez');
  // a etiqueta sai do cartão (o Vue refaz as pílulas)
  a.children[1].children[1].children = [];
  m.avisar();
  m.passa();
  assert.equal(a.getAttribute('data-dd-sofia'), null, 'a marca some sozinha');
  assert.equal(c.getAttribute('data-dd-sofia'), 'e');
});

test('conversa aberta: a barra entra no topo com a etiqueta no estado do Chatwoot, não duplica e sai quando a etiqueta sai', () => {
  const m = mundo(['sofia-atendendo', 'quente'], 9101);
  const wrap = m.body.add(new No('div', 'conversation-details-wrap'));
  const cabecalho = wrap.add(new No('div', 'cabecalho'));
  m.rodar(S.seloSofiaJs({}));
  m.passa();
  const barra = wrap.children[0];
  assert.ok(barra.hasAttribute('data-dd-sofia-barra'), 'a barra é o primeiro filho');
  assert.equal(barra.textContent, '🤖 A Sofia (IA) está atendendo esta conversa');
  assert.equal(wrap.children[1], cabecalho);
  m.avisar();
  m.passa();
  assert.equal(wrap.querySelectorAll('[data-dd-sofia-barra]').length, 1, 'não duplica');
  m.selecionada.labels = ['quente'];
  m.avisar();
  m.passa();
  assert.equal(wrap.querySelectorAll('[data-dd-sofia-barra]').length, 0, 'sai sozinha');
  // outra conversa selecionada no estado (a URL ainda é a anterior): não mostra a barra errada
  m.selecionada.labels = ['sofia-atendendo'];
  m.selecionada.id = 5;
  m.avisar();
  m.passa();
  assert.equal(wrap.querySelectorAll('[data-dd-sofia-barra]').length, 0);
});

test('fora das contas do Chatwoot (login, por exemplo) o bloco não mexe em nada', () => {
  const m = mundo(['sofia-atendendo'], 7);
  m.loc.pathname = '/app/login';
  const wrap = m.body.add(new No('div', 'conversation-details-wrap'));
  m.rodar(S.seloSofiaJs({}));
  m.passa();
  assert.equal(wrap.children.length, 0);
  assert.equal(m.doc.querySelector('style[data-dd-sofia-estilo]'), null);
});

const soltar = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

test('reserva pela API: trocou de conversa dentro da janela de 20 s → esquece a resposta da anterior e agenda UMA nova tentativa para o que falta', async () => {
  const etiquetas: Record<string, string[]> = {
    '/api/v1/accounts/2/conversations/1': ['sofia-atendendo'],
    '/api/v1/accounts/2/conversations/2': ['sofia-atendendo', 'quente'],
  };
  const m = mundo(null, 1, async (url) => ({ ok: true, json: async () => ({ labels: etiquetas[url] ?? [] }) }));
  const wrap = m.body.add(new No('div', 'conversation-details-wrap'));
  m.rodar(S.seloSofiaJs({}));
  m.passa(); // 1ª passada: pergunta pela conversa 1
  await soltar();
  m.passa();
  assert.deepEqual(m.idsBuscados, ['/api/v1/accounts/2/conversations/1']);
  assert.equal(wrap.querySelectorAll('[data-dd-sofia-barra]').length, 1, 'a conversa 1 mostra a barra pela API');

  // 5 s depois o usuário abre a conversa 2: dentro da janela de 20 s
  m.relogio.t += 5000;
  m.loc.pathname = '/app/accounts/2/conversations/2';
  m.atrasos.length = 0;
  m.avisar();
  m.passa();
  m.avisar();
  m.passa();
  assert.equal(m.idsBuscados.length, 1, 'ainda não pergunta (janela)');
  assert.equal(wrap.querySelectorAll('[data-dd-sofia-barra]').length, 0, 'a resposta da conversa 1 não vale para a 2');
  // um timer só, que vence exatamente quando a janela de 20 s (contada do último GET) acaba; várias passadas não criam outros
  assert.equal(m.longosPendentes(), 1, 'UMA tentativa agendada, mesmo com várias passadas');
  assert.deepEqual(m.atrasos.filter((ms) => ms > 400), [], 'e nenhum timer novo foi criado depois da troca de conversa');

  // passou o tempo: o timer dispara, pergunta pela conversa 2 e a barra aparece
  m.relogio.t += 15000;
  m.disparar(); // o timer da tentativa → agenda a passada
  m.passa(); // a passada → pergunta
  await soltar();
  m.passa();
  assert.deepEqual(m.idsBuscados, ['/api/v1/accounts/2/conversations/1', '/api/v1/accounts/2/conversations/2']);
  assert.equal(wrap.querySelectorAll('[data-dd-sofia-barra]').length, 1, 'a barra da conversa 2 aparece depois da tentativa');
});

test('reserva pela API: a resposta que chega tarde de uma conversa antiga não vale para a conversa nova', async () => {
  let solta: (v: unknown) => void = () => {};
  const m = mundo(null, 1, () => new Promise((r) => (solta = r)));
  const wrap = m.body.add(new No('div', 'conversation-details-wrap'));
  m.rodar(S.seloSofiaJs({}));
  m.passa(); // pergunta pela 1 (a resposta ainda não veio)
  m.loc.pathname = '/app/accounts/2/conversations/2';
  m.avisar();
  m.passa(); // conversa 2: a chave mudou
  solta({ ok: true, json: async () => ({ labels: ['sofia-atendendo'] }) }); // chega a resposta da 1
  await soltar();
  m.passa();
  assert.equal(wrap.querySelectorAll('[data-dd-sofia-barra]').length, 0, 'a etiqueta da conversa 1 não aparece na 2');
});
