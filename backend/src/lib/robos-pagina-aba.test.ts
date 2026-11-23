/**
 * A tela «Robôs», aba «Automações», EXECUTADA de verdade (o script da página roda num contexto isolado com um DOM de mentira e um servidor de mentira):
 * 23/11 (sênior do #434): entrar de novo na aba não buscava nada, mas os avisos mandavam «abra a aba de novo» — quem obedecia via a mesma mensagem até o F5.
 * Agora: entrar na aba recarrega quando a última resposta veio incompleta (`parcial`), com erro ou com o histórico além do minuto que o servidor guarda;
 * a tela tenta sozinha mais 2 vezes (o servidor termina a leitura em segundo plano); e o aviso de estado some quando a leitura seguinte dá certo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
// a página só aceita a sessão vinda da origem do Chatwoot configurada
process.env.CHATWOOT_API_TOKEN = 'token-da-conta';
process.env.CHATWOOT_CONTA_ID = '1';
process.env.CHATWOOT_URL = 'https://atendimento.doutordigitalconsultoria.com';

const { paginaDosRobos } = await import('./robos-pagina.js');
const CW = 'https://atendimento.doutordigitalconsultoria.com';

class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  handlers: Record<string, Array<(e: unknown) => void>> = {};
  style = { setProperty() {}, removeProperty() {} };
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  hidden = false; className = ''; value = ''; disabled = false; type = ''; placeholder = ''; title = ''; id = '';
  private t = '';
  constructor(public tag = 'div') {}
  get textContent(): string { return this.t + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.t = String(v); this.children = []; }
  appendChild(c: El) { this.children.push(c); return c; }
  insertBefore(c: El) { this.children.push(c); return c; }
  removeChild() {}
  remove() {}
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(t: string, f: (e: unknown) => void) { (this.handlers[t] ??= []).push(f); }
  removeEventListener() {}
  click() { for (const f of this.handlers.click ?? []) f({ target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get scrollWidth() { return 0; }
  get clientWidth() { return 0; }
}

/** Sobe a página com um servidor de mentira; `respostas` = o que o GET das automações devolve, uma por pedido (a última se repete). */
async function subirPagina(respostas: Array<Record<string, unknown> | 'erro' | (() => Promise<Record<string, unknown>>)>) {
  const html = paginaDosRobos(CW);
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const els = new Map<string, El>();
  const pegar = (id: string) => { let e = els.get(id); if (!e) { e = new El(); e.id = id; els.set(id, e); } return e; };
  const pedidos: string[] = [];
  let agora = Date.parse('2026-11-23T18:00:00Z');
  const timers: Array<{ ms: number; fn: () => void; vivo: boolean }> = [];
  const mensagens: Array<(e: unknown) => void> = [];
  const pai = { postMessage() {} };
  const automacao = (i: number) => respostas[Math.min(i, respostas.length - 1)]!;
  const fetchFalso = async (url: string) => {
    pedidos.push(url);
    const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => v });
    if (url.includes('/testar-ia/unidades')) return json({ unidades: [{ slug: 'doutor-hernia-parauapebas', nome: 'Parauapebas' }] });
    if (url.includes('/robos/automacoes')) {
      const n = pedidos.filter((p) => p.includes('/robos/automacoes')).length - 1;
      const r = automacao(n);
      if (typeof r === 'function') return json(await r());
      return r === 'erro' ? json({ error: 'não consegui ler as automações agora' }, false) : json(r);
    }
    return json({ pode: true, robos: [] });
  };
  const FD = class extends Date { static now() { return agora; } constructor(a?: number | string | Date) { super(a === undefined ? agora : (a as number)); } };
  const contexto: Record<string, unknown> = {
    document: { getElementById: pegar, createElement: (t: string) => new El(t), createElementNS: (_n: string, t: string) => new El(t), createTextNode: (t: string) => { const e = new El('#text'); e.textContent = t; return e; }, addEventListener() {}, removeEventListener() {}, referrer: '' },
    window: { parent: pai, addEventListener: (t: string, f: (e: unknown) => void) => { if (t === 'message') mensagens.push(f); }, open() {}, innerWidth: 1200 },
    location: { search: '', ancestorOrigins: [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchFalso,
    setTimeout: (fn: () => void, ms: number) => { const t = { ms, fn, vivo: true }; timers.push(t); return t; },
    clearTimeout: (t: { vivo: boolean } | undefined) => { if (t) t.vivo = false; },
    Date: FD, URL, URLSearchParams, JSON, Math, Promise, Array, Object, String, Number, Error, RegExp, encodeURIComponent, parseInt, parseFloat, isNaN, console,
  };
  contexto.window = Object.assign(contexto.window as object, { Date: FD });
  vm.runInNewContext(script, contexto);
  const soltar = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  // a sessão chega pelo menu do Chatwoot e a página entra sozinha (unidade → robôs)
  for (const f of mensagens) f({ origin: CW, source: pai, data: { event: 'funil-sessao', sessao: { token: 't', client: 'c', uid: 'u' } } });
  await soltar();
  return {
    pedidosAuto: () => pedidos.filter((p) => p.includes('/robos/automacoes')).length,
    clicar: async (id: string) => { pegar(id).click(); await soltar(); },
    passar: (ms: number) => { agora += ms; },
    /** dispara os timers de 4 s (a nova tentativa sozinha) que ainda estão vivos */
    dispararNovaTentativa: async () => { for (const t of timers.filter((x) => x.vivo && x.ms === 4000)) { t.vivo = false; t.fn(); } await soltar(); },
    novaTentativaPendente: () => timers.some((t) => t.vivo && t.ms === 4000),
    texto: (id: string) => pegar(id).textContent,
    unidades: () => pegar('unidadeNome').textContent,
  };
}

const completa = (o: Record<string, unknown> = {}) => ({ pode: true, automacoes: [], parcial: [], historicoEm: '2026-11-23T18:00:00.000Z', historicoIdadeMs: 1000, historicoVelho: false, historicoValeMs: 60_000, nativas: { regras: [], lidas: true, link: null }, ...o });

test('entrar de novo na aba NÃO busca outra vez quando a última resposta veio completa e recente', async () => {
  const p = await subirPagina([completa()]);
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 1, 'a 1ª entrada busca');
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 1, 'completa e recente: nada de buscar de novo');
  assert.equal(p.novaTentativaPendente(), false);
});

test('sênior #434: entrar de novo na aba BUSCA outra vez quando a última resposta veio incompleta (parcial), e tenta sozinha depois de 4 s', async () => {
  const p = await subirPagina([completa({ parcial: ['ultimas'] }), completa()]);
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 1);
  assert.equal(p.novaTentativaPendente(), true, 'tenta sozinha: o servidor termina a leitura em segundo plano');
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 2, 'quem obedece «troque de aba e volte» recebe uma leitura nova');
  assert.equal(p.novaTentativaPendente(), false, 'a leitura nova veio completa: sem nova tentativa');
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 2, 'e completa de novo não busca mais');
});

test('a nova tentativa sozinha acontece, no máximo 2 vezes, e para quando a leitura vem completa', async () => {
  const p = await subirPagina([completa({ parcial: ['ultimas'] }), completa({ parcial: ['ultimas'] }), completa()]);
  await p.clicar('mAuto');
  await p.dispararNovaTentativa();
  assert.equal(p.pedidosAuto(), 2);
  await p.dispararNovaTentativa();
  assert.equal(p.pedidosAuto(), 3);
  assert.equal(p.novaTentativaPendente(), false);
  const q = await subirPagina([completa({ parcial: ['mudancas'] })]);
  await q.clicar('mAuto');
  await q.dispararNovaTentativa();
  await q.dispararNovaTentativa();
  await q.dispararNovaTentativa();
  assert.equal(q.pedidosAuto(), 3, '1 + 2 tentativas, depois para (sem loop)');
  assert.match(q.texto('tela') + q.texto('avisos'), /./);
});

test('histórico com mais de 1 min (o servidor o servia como velho) recarrega ao entrar; entre 10 s e 1 min não adianta recarregar (a leitura é a mesma)', async () => {
  const p = await subirPagina([completa({ historicoIdadeMs: 20_000, historicoVelho: true })]);
  await p.clicar('mAuto');
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 1, '20 s: o servidor devolveria a mesma leitura guardada');
  p.passar(50_000); // agora o histórico tem ~70 s
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 2, 'passou do minuto guardado: busca de novo');
});

test('resposta com ERRO também busca de novo ao entrar na aba', async () => {
  const p = await subirPagina(['erro', completa()]);
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 1);
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 2);
});

test('o aviso vermelho de «estado desatualizado» some quando a leitura seguinte dá certo', async () => {
  const p = await subirPagina([completa({ parcial: ['estado'] }), completa()]);
  await p.clicar('mAuto');
  assert.match(p.texto('avisos'), /desatualizado/);
  await p.dispararNovaTentativa();
  assert.equal(p.texto('avisos'), '', 'leitura seguinte completa: o aviso sai');
});

test('o aviso de estado só promete «tentando de novo» quando há tentativa agendada; esgotadas as 2, manda trocar de aba', async () => {
  const p = await subirPagina([completa({ parcial: ['estado'] })]);
  await p.clicar('mAuto');
  assert.match(p.texto('avisos'), /Estou tentando de novo/);
  await p.dispararNovaTentativa();
  await p.dispararNovaTentativa();
  assert.equal(p.pedidosAuto(), 3);
  assert.doesNotMatch(p.texto('avisos'), /Estou tentando de novo/, 'sem tentativa agendada, não promete');
  assert.match(p.texto('avisos'), /troque de aba e volte/);
  assert.equal(p.novaTentativaPendente(), false);
  // quem obedece («troque de aba e volte») ganha mais 2 tentativas
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.pedidosAuto(), 4);
  assert.equal(p.novaTentativaPendente(), true);
});

test('o banner de ERRO também some quando a leitura seguinte dá certo', async () => {
  const p = await subirPagina(['erro', completa()]);
  await p.clicar('mAuto');
  assert.match(p.texto('avisos'), /não consegui ler as automações/);
  await p.clicar('mRobos');
  await p.clicar('mAuto');
  assert.equal(p.texto('avisos'), '');
});

test('resposta antiga que chega DEPOIS de uma mais nova é descartada (não sobrescreve a tela)', async () => {
  let soltaA!: (v: Record<string, unknown>) => void;
  const lenta = () => new Promise<Record<string, unknown>>((r) => { soltaA = r; });
  const velha = completa({ parcial: ['estado'] });
  const p = await subirPagina([lenta, completa()]);
  await p.clicar('mAuto'); // pedido 1 (lento) em voo; AUTO ainda nulo
  await p.clicar('mRobos');
  await p.clicar('mAuto'); // AUTO nulo de novo: pedido 2, que responde na hora
  assert.equal(p.pedidosAuto(), 2);
  soltaA(velha); // a 1ª só chega agora
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(p.texto('avisos'), '', 'a resposta velha (com aviso de estado) não pode aparecer por cima da nova');
});

test('mudar o estado de uma automação (ação do usuário) zera as tentativas sozinhas gastas', async () => {
  const fonteDaPagina = paginaDosRobos(CW);
  assert.match(fonteDaPagina, /carregarAuto\(true\); toast/, 'gravar recarrega como ação do usuário');
  assert.match(fonteDaPagina, /if \(MODO === 'auto'\) carregarAuto\(true\); return carregar\(\)/, 'trocar de unidade também');
});
