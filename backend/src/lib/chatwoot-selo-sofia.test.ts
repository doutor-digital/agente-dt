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
  assert.doesNotMatch(js, /setInterval/);
  assert.match(js, /new MutationObserver/);
  assert.match(js, /setTimeout\(passar, 400\)/);
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
  if (sel.startsWith('.')) return n.classes.includes(sel.slice(1));
  const a = sel.match(/^\[([\w-]+)\]$/);
  if (a) return n.hasAttribute(a[1]);
  const e = sel.match(/^style\[([\w-]+)\]$/);
  if (e) return n.tag === 'style' && n.hasAttribute(e[1]);
  return false;
}

function mundo(labelsDoEstado: string[] | null, idUrl: number | null) {
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
    createElement: (t: string) => new No(t),
    getElementById: (id: string) => (id === 'app' ? { __vue_app__: { config: { globalProperties: { $store: { getters: { getSelectedChat: labelsDoEstado ? selecionada : null } } } } } } : null),
  });
  doc.querySelectorAll = (s: string) => html.querySelectorAll(s);
  doc.querySelector = (s: string) => html.querySelector(s);
  const timers: Array<() => void> = [];
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
  const rodar = (js: string) => new Function('window', 'document', 'location', 'MutationObserver', 'setTimeout', 'fetch', js)(
    janela,
    doc,
    loc,
    MO,
    (f: () => void) => timers.push(f),
    () => Promise.reject(new Error('sem rede no teste')),
  );
  const passa = () => {
    const t = timers.splice(0);
    t.forEach((f) => f());
  };
  return { doc, body, rodar, passa, selecionada, loc, avisar: () => observador?.() };
}

function cartao(nome: string, etiquetas: string[], compacto = true) {
  const c = new No('div', 'conversation');
  if (compacto) c.add(new No('h4', 'conversation--user', nome));
  const lab = c.add(new No('div'));
  for (const e of etiquetas) {
    const l = lab.add(new No('div', 'inline-flex label'));
    l.add(new No('span', 'label-color-dot'));
    l.add(new No('span', '', ` ${e} `));
  }
  return c;
}

test('lista: o cartão com a pílula «sofia-atendendo» é marcado (condensado e expandido); os outros não; some quando a etiqueta sai', () => {
  const m = mundo(null, null);
  const lista = m.body.add(new No('div'));
  const a = lista.add(cartao('Maria', ['quente', 'sofia-atendendo']));
  const b = lista.add(cartao('João', ['alta']));
  const c = lista.add(cartao('Ana', ['sofia-atendendo'], false));
  // uma mensagem de paciente que só diz o nome da etiqueta NÃO conta: só a pílula (.label)
  const d = lista.add(cartao('Rui', []));
  d.add(new No('p', '', 'sofia-atendendo'));
  // quase igual não conta
  const e = lista.add(cartao('Bia', ['sofia-atendendo-2', 'a-sofia-atendendo']));
  m.rodar(S.seloSofiaJs({}));
  m.passa();
  assert.equal(a.getAttribute('data-dd-sofia'), 'c');
  assert.equal(b.getAttribute('data-dd-sofia'), null);
  assert.equal(c.getAttribute('data-dd-sofia'), 'e');
  assert.equal(d.getAttribute('data-dd-sofia'), null);
  assert.equal(e.getAttribute('data-dd-sofia'), null);
  assert.ok(m.doc.querySelector('style[data-dd-sofia-estilo]'), 'o CSS entrou uma vez');
  // a etiqueta sai do cartão (o Vue refaz as pílulas)
  a.children[1].children = [];
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
