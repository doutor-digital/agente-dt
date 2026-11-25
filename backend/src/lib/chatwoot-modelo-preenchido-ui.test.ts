/**
 * O bloco do menu.js que preenche as caixinhas do modelo do WhatsApp: acha o formulário pela estrutura do Chatwoot 4.19.1, pergunta ao servidor com o login da pessoa,
 * preenche SÓ as vazias que ela não tocou (valor + evento `input`), marca com atributo (dica por CSS), nunca envia nem aperta botão. DOM de mentira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { modeloPreenchidoJs, modeloPreenchidoLigado } = await import('./chatwoot-modelo-preenchido-ui.js');
const { montarMenuJs } = await import('../controllers/funil.controller.js');

// o valor mora num acessor do protótipo (como no navegador): o script chama o setter nativo e dispara `input`
class Input {
  attrs: Record<string, string> = { type: 'text' };
  parentNode: Node | null = null;
  tagName = 'INPUT';
  _v = '';
  eventos: Array<{ tipo: string; confiavel: boolean }> = [];
  constructor(ph: string) { this.attrs.placeholder = ph; }
  get value() { return this._v; }
  set value(v: string) { this._v = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  dispatchEvent(e: { type: string }) { this.eventos.push({ tipo: e.type, confiavel: false }); return true; }
  querySelector() { return null; }
}
class Node {
  attrs: Record<string, string> = {};
  filhos: Array<Node | Input> = [];
  parentNode: Node | null = null;
  texto = '';
  constructor(public tag: string, texto = '', cls = '') { this.texto = texto; if (cls) this.attrs.class = cls; }
  get tagName() { return this.tag.toUpperCase(); }
  set textContent(v: string) { this.texto = v; this.filhos = []; }
  get textContent(): string { return this.texto + this.filhos.map((f) => ('textContent' in f ? (f as Node).textContent : '')).join(''); }
  add<T extends Node | Input>(n: T): T { (n as { parentNode: Node | null }).parentNode = this; this.filhos.push(n); return n; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  contains(n: Node | Input): boolean { return this.todos().includes(n); }
  todos(): Array<Node | Input> { return [this, ...this.filhos.flatMap((f) => ('todos' in f ? (f as Node).todos() : [f]))]; }
  querySelector(sel: string): Node | null { return (this.querySelectorAll(sel)[0] as Node | undefined) ?? null; }
  querySelectorAll(sel: string): Array<Node | Input> {
    const todos = this.todos().filter((n) => n !== this);
    if (sel === 'h3') return todos.filter((n) => (n as Node).tag === 'h3');
    if (sel === 'p') return todos.filter((n) => (n as Node).tag === 'p');
    if (sel === 'input') return todos.filter((n) => n instanceof Input);
    if (sel === 'div[class*="whitespace-pre-wrap"]') return todos.filter((n) => (n as Node).tag === 'div' && String((n as Node).attrs.class ?? '').includes('whitespace-pre-wrap'));
    return [];
  }
}

interface Cenario {
  nome?: string;
  corpo?: string;
  placeholders?: string[];
  caminho?: string;
  cookie?: string;
  resposta?: { origem: string; valores: Record<string, string> } | null;
  respostaAtrasada?: boolean;
  env?: NodeJS.ProcessEnv;
}

function montar(c: Cenario = {}) {
  const body = new Node('body');
  const raiz = body.add(new Node('div'));
  const caixa = raiz.add(new Node('div', '', 'flex flex-col gap-4 p-4'));
  const h3 = caixa.add(new Node('h3', c.nome ?? 'timbo_confirmacao'));
  const previa = caixa.add(new Node('div')).add(new Node('div', c.corpo ?? 'Olá, {{1}}! Sua consulta.\n🗓 Data e horário: {{2}}', 'text-sm whitespace-pre-wrap text-n-slate-12'));
  const formulario = raiz.add(new Node('div')).add(new Node('div'));
  const titulo = formulario.add(new Node('p', 'Variáveis', 'mb-2.5 text-sm font-semibold'));
  const inputs = (c.placeholders ?? ['Insira o valor para 1', 'Insira o valor para 2']).map((ph) => {
    const i = new Input(ph);
    formulario.add(new Node('div', '', 'flex items-center mb-2.5')).add(new Node('div', '', 'relative flex flex-col min-w-0')).add(i);
    return i;
  });
  const estilos: Node[] = [];
  const doc = {
    body, documentElement: {}, head: { appendChild: (e: Node) => estilos.push(e) },
    createElement: () => new Node('style'),
    querySelector: (sel: string) => (sel.startsWith('style[') ? (estilos[0] ?? null) : null),
    querySelectorAll: (sel: string) => (sel === 'input[type="text"][placeholder]' ? body.querySelectorAll('input') : []),
    getElementById: (id: string) => (id === 'app' ? { __vue_app__: { config: { globalProperties: { $t: (k: string, p: { variable: string }) => (k.endsWith('VARIABLE_PLACEHOLDER') ? `Insira o valor para ${p.variable}` : k) } } } } : null),
    cookie: c.cookie ?? 'cw_d_session_info=' + encodeURIComponent(JSON.stringify({ 'access-token': 'tk', client: 'cl', uid: 'u@x' })),
    addEventListener: (tipo: string, f: (e: unknown) => void) => { ouvintes.push({ tipo, f }); },
  };
  const ouvintes: Array<{ tipo: string; f: (e: unknown) => void }> = [];
  const timers: Array<() => void> = [];
  const win: Record<string, unknown> = {}; win.top = win;
  const chamadas: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const liberadores: Array<() => void> = [];
  const fetchFalso = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    chamadas.push({ url, init });
    const resp = c.resposta === undefined ? { origem: 'externo', valores: { '1': 'Ana', '2': '02/12 às 15:00' } } : c.resposta;
    const entrega = () => ({ ok: resp !== null, json: async () => resp });
    return c.respostaAtrasada ? new Promise((r) => { liberadores.push(() => r(entrega())); }) : Promise.resolve(entrega());
  };
  class Obs { constructor(public f: () => void) { obs.push(this); } observe() {} }
  const obs: Obs[] = [];
  const loc = { pathname: c.caminho ?? '/app/accounts/3/conversations/55' };
  const js = modeloPreenchidoJs('https://agente.exemplo.test', c.env ?? ({} as NodeJS.ProcessEnv));
  assert.ok(js);
  class Evento { constructor(public type: string, public init?: unknown) {} }
  const HTMLInputElement = { prototype: Input.prototype };
  new Function('window', 'document', 'location', 'setTimeout', 'MutationObserver', 'fetch', 'Event', 'HTMLInputElement', js)(win, doc, loc, (f: () => void) => { timers.push(f); return 1; }, Obs, fetchFalso, Evento, HTMLInputElement);
  const rodar = async () => { for (let i = 0; i < 3; i++) { timers.splice(0).forEach((f) => f()); await new Promise((r) => setImmediate(r)); } };
  /** a pessoa digita (evento de verdade): o ouvinte da fase de captura vê `isTrusted` */
  const digitar = (inp: Input, texto: string) => { inp.value = texto; ouvintes.filter((o) => o.tipo === 'input').forEach((o) => o.f({ isTrusted: true, target: inp })); };
  const valores = () => inputs.map((i) => i.value);
  return { rodar, inputs, valores, chamadas, estilos, titulo, digitar, h3, previa, obs, liberar: (i = liberadores.length - 1) => liberadores[i]?.(), loc, ouvintes };
}

test('FORMULÁRIO ACHADO: pergunta ao servidor com o login da pessoa (conta da URL), manda nome do modelo + corpo cru, e preenche as caixinhas VAZIAS (valor + evento input)', async () => {
  const t = montar();
  await t.rodar();
  assert.equal(t.chamadas.length, 1);
  assert.equal(t.chamadas[0]!.url, 'https://agente.exemplo.test/api/public/assistente/modelo-preenchido?conta=3');
  assert.equal(t.chamadas[0]!.init.method, 'POST');
  assert.deepEqual(t.chamadas[0]!.init.headers, { 'Content-Type': 'application/json', 'X-CW-Token': 'tk', 'X-CW-Client': 'cl', 'X-CW-Uid': 'u@x' });
  assert.deepEqual(JSON.parse(t.chamadas[0]!.init.body), { conversa: 55, modelo: 'timbo_confirmacao', corpo: 'Olá, {{1}}! Sua consulta.\n🗓 Data e horário: {{2}}' });
  assert.deepEqual(t.valores(), ['Ana', '02/12 às 15:00']);
  for (const i of t.inputs) assert.ok(i.eventos.some((e) => e.tipo === 'input'), 'disparou o evento input (é o que atualiza o Vue e a prévia)');
  assert.ok(t.inputs.every((i) => i.hasAttribute('data-dd-preenchido')), 'caixinhas marcadas');
  assert.equal(t.titulo.getAttribute('data-dd-preenchido'), '1', 'a dica fica na linha «Variáveis» (CSS ::after, nenhum nó novo)');
  assert.equal(t.estilos.length, 1);
  assert.ok(t.estilos[0]!.texto.includes('preenchido pelo CRM — confira') && t.estilos[0]!.texto.includes('.dark '));
});

test('o que a pessoa JÁ DIGITOU nunca é sobrescrito: caixinha com texto, e caixinha que ela tocou enquanto a resposta demorava', async () => {
  const a = montar();
  a.inputs[0]!.value = 'Ana Maria'; // já escreveu
  await a.rodar();
  assert.equal(a.inputs[0]!.value, 'Ana Maria');
  assert.equal(a.inputs[1]!.value, '02/12 às 15:00');
  assert.ok(!a.inputs[0]!.hasAttribute('data-dd-preenchido'));
  // a resposta demora; ela digita e APAGA (volta a vazio) antes de chegar: a caixinha é dela
  const b = montar({ respostaAtrasada: true });
  await b.rodar();
  b.digitar(b.inputs[0]!, 'X'); b.digitar(b.inputs[0]!, ''); // evento de verdade
  b.liberar(); await b.rodar();
  assert.equal(b.inputs[0]!.value, '', 'ela esvaziou: não preenche por cima');
  assert.equal(b.inputs[1]!.value, '02/12 às 15:00', 'a outra caixinha, intocada, recebe');
});

test('editar uma caixinha preenchida tira a marca dela; quando nenhuma tem marca, a dica sai', async () => {
  const t = await (async () => { const x = montar(); await x.rodar(); return x; })();
  assert.equal(t.titulo.getAttribute('data-dd-preenchido'), '1');
  t.digitar(t.inputs[0]!, 'Ana B');
  assert.ok(!t.inputs[0]!.hasAttribute('data-dd-preenchido'));
  assert.equal(t.titulo.getAttribute('data-dd-preenchido'), '1', 'ainda há uma preenchida');
  t.digitar(t.inputs[1]!, '03/12');
  assert.equal(t.titulo.getAttribute('data-dd-preenchido'), null, 'nenhuma marcada: a dica sai');
});

test('sem dado: caixinha fica VAZIA, sem marca nem dica (nunca inventa)', async () => {
  const t = montar({ resposta: { origem: 'externo', valores: {} } });
  await t.rodar();
  assert.deepEqual(t.valores(), ['', '']);
  assert.equal(t.titulo.getAttribute('data-dd-preenchido'), null);
  const so1 = montar({ resposta: { origem: 'crm', valores: { '2': '02/12 às 15:00' } } });
  await so1.rodar();
  assert.deepEqual(so1.valores(), ['', '02/12 às 15:00']);
});

test('NUNCA envia: o bloco não aperta botão nem submete (só o setter do valor e o evento input)', async () => {
  const t = montar();
  await t.rodar();
  for (const i of t.inputs) assert.deepEqual([...new Set(i.eventos.map((e) => e.tipo))], ['input']);
  assert.equal(t.chamadas.length, 1, 'uma pergunta ao servidor por formulário');
  const js = modeloPreenchidoJs('https://a.test');
  assert.ok(!/\.click\(|\.submit\(|requestSubmit|sendMessage/.test(js), 'nada de click, submit ou envio no código');
});

test('um formulário é atendido UMA vez (as passadas seguintes não repetem a pergunta); outro modelo no mesmo formulário limpa as marcas velhas e pergunta de novo', async () => {
  const t = montar();
  await t.rodar(); t.obs[0]!.f(); await t.rodar(); t.obs[0]!.f(); await t.rodar();
  assert.equal(t.chamadas.length, 1);
  // o Vue reaproveita as caixinhas para outro modelo (h3 muda): marcas velhas saem e a pergunta se repete
  t.h3.texto = 'timbo_outro'; t.inputs.forEach((i) => { i.value = ''; });
  t.obs[0]!.f(); await t.rodar();
  assert.equal(t.chamadas.length, 2);
  assert.equal(JSON.parse(t.chamadas[1]!.init.body).modelo, 'timbo_outro');
});

test('resposta que chega DEPOIS de o modelo mudar não vale; resposta com erro não quebra nem preenche', async () => {
  const t = montar({ respostaAtrasada: true });
  await t.rodar();
  t.h3.texto = 'timbo_outro';
  t.obs[0]!.f(); await t.rodar();
  t.liberar(0); await t.rodar(); // a resposta do modelo ANTIGO chega agora
  assert.deepEqual(t.valores(), ['', ''], 'a resposta do modelo antigo foi descartada');
  t.liberar(1); await t.rodar();
  assert.deepEqual(t.valores(), ['Ana', '02/12 às 15:00'], 'a do modelo atual vale');
  const erro = montar({ resposta: null });
  await erro.rodar();
  assert.deepEqual(erro.valores(), ['', '']);
});

test('não age fora de conversa, sem login do Chatwoot, com placeholder que não é o dos parâmetros, ou nome de modelo estranho', async () => {
  for (const c of [{ caminho: '/app/accounts/3/contacts' }, { cookie: '' }, { placeholders: ['Pesquisar modelos'] }, { nome: 'Nome Com Espaço' }] as Cenario[]) {
    const t = montar(c);
    await t.rodar();
    assert.equal(t.chamadas.length, 0, JSON.stringify(c));
    assert.ok(t.valores().every((v) => v === ''));
  }
});

test('modelo com parâmetros NOMEADOS ({{nome}}): a chave sai do placeholder; chave vem como o servidor mandou', async () => {
  const t = montar({ placeholders: ['Insira o valor para nome', 'Insira o valor para data'], resposta: { origem: 'externo', valores: { nome: 'Ana', data: '02/12' } } });
  await t.rodar();
  assert.deepEqual(t.valores(), ['Ana', '02/12']);
});

test('menu.js com TODOS os blocos (guia, selo, domínio, rótulo, cartão e modelo preenchido): cada um no seu try, na ordem, e o arquivo todo PARSEIA', () => {
  const js = montarMenuJs('https://agente.exemplo.test', [3, 11], { drtimbo: 3 });
  assert.doesNotThrow(() => new Function(js));
  const marcas = ['window.__funilMenu', 'window.__guiaEtapaDD', 'window.__seloSofiaDD', 'window.__dominioContaDD', 'window.__rotuloRoboDD', 'window.__cartaoEnxutoDD', 'window.__modeloPreenchidoDD'];
  const pos = marcas.map((m) => js.indexOf(m));
  assert.ok(pos.every((p) => p >= 0), 'todos os blocos estão no arquivo: ' + JSON.stringify(pos));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'na ordem: menu, guia, selo, domínio, rótulo, cartão, modelo');
  for (const m of marcas.slice(1)) assert.match(js.slice(js.lastIndexOf(';try{', js.indexOf(m)), js.indexOf(m)), /^;try\{\s*\(function\(\)\{/, m + ' em bloco próprio');
  assert.ok(js.includes('"semAntecipado":[3,11]') && js.includes('"drtimbo":3'));
});

test('chave CHATWOOT_MODELO_PREENCHIDO=0 tira o bloco; menu.js leva o bloco em try próprio e PARSEIA', () => {
  assert.equal(modeloPreenchidoLigado({} as NodeJS.ProcessEnv), true);
  assert.equal(modeloPreenchidoLigado({ CHATWOOT_MODELO_PREENCHIDO: ' 0 ' } as NodeJS.ProcessEnv), false);
  assert.equal(modeloPreenchidoJs('https://a.test', { CHATWOOT_MODELO_PREENCHIDO: '0' } as NodeJS.ProcessEnv), '');
  const js = montarMenuJs('https://agente.exemplo.test', [3], { drtimbo: 3 });
  assert.doesNotThrow(() => new Function(js));
  const i = js.indexOf('window.__modeloPreenchidoDD');
  assert.ok(i > 0);
  assert.match(js.slice(js.lastIndexOf(';try{', i), i), /^;try\{\s*\(function\(\)\{/);
  assert.ok(js.includes('window.__funilMenu') && js.includes('window.__rotuloRoboDD') && js.includes('window.__dominioContaDD') && js.includes('window.__guiaEtapaDD'), 'os outros blocos continuam');
  const antes = process.env.CHATWOOT_MODELO_PREENCHIDO;
  process.env.CHATWOOT_MODELO_PREENCHIDO = '0';
  try {
    const sem = montarMenuJs('https://agente.exemplo.test');
    assert.ok(!sem.includes('__modeloPreenchidoDD'));
    assert.doesNotThrow(() => new Function(sem));
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_MODELO_PREENCHIDO; else process.env.CHATWOOT_MODELO_PREENCHIDO = antes;
  }
});
