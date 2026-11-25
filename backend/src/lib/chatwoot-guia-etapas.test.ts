/**
 * O guia «O que fazer agora»: o mapa cobre todas as etapas do atributo, o conteúdo é só texto, o script é seguro (nada de dado vira HTML) e,
 * rodando num DOM de mentira, troca sozinho quando a etapa muda, só lê (nunca grava), mostra o modal do vídeo e o Esc fecha.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const G = await import('./chatwoot-guia-etapas.js');
const AGENTE = 'https://agente.exemplo.test';

test('o mapa cobre TODAS as etapas do atributo (e só elas), cada uma com passos e uma aula válida', () => {
  assert.deepEqual(Object.keys(G.GUIA_DAS_ETAPAS).sort(), [...G.ETAPAS_DO_CRM].sort());
  assert.equal(G.ETAPAS_DO_CRM.length, 11);
  assert.ok((G.ETAPAS_DO_CRM as readonly string[]).includes(G.ETAPA_PADRAO_DO_GUIA));
  for (const etapa of G.ETAPAS_DO_CRM) {
    const g = G.GUIA_DAS_ETAPAS[etapa];
    assert.ok(g.passos.length >= 3 && g.passos.length <= 4, `${etapa}: de 3 a 4 passos`);
    for (const p of g.passos) {
      assert.ok(p.trim().length > 5 && p.length <= 90, `${etapa}: passo curto e não vazio`);
      assert.doesNotMatch(p, /[<>]/, `${etapa}: passo é texto, não HTML`);
    }
    assert.match(g.aula.slug, /^c\d{2}-[a-z0-9-]+$/, `${etapa}: slug`);
    assert.match(g.aula.num, /^\d\.\d$/);
    assert.match(g.aula.duracao, /^\d:\d{2}$/);
    assert.ok(g.aula.titulo.length > 3);
  }
});

test('as aulas das telas (Funil, Hoje, Oportunidades, Agente) existem e o conteúdo entregue ao script não leva segredo nem HTML', () => {
  assert.deepEqual(Object.keys(G.AULAS_DAS_TELAS).sort(), ['agente', 'funil', 'hoje', 'oportunidades']);
  assert.deepEqual(['funil', 'hoje', 'oportunidades', 'agente'].map((t) => G.AULAS_DAS_TELAS[t as 'funil'].slug), ['c41-funil', 'c42-hoje', 'c43-oportunidades', 'c24-tela-agente']);
  const c = G.conteudoDoGuia();
  assert.equal(c.base, G.BASE_DOS_VIDEOS);
  assert.ok(c.base.startsWith('https://treinamento.doutordigitalconsultoria.com/crmdoutordigital-duvidas/videos/'));
  const json = JSON.stringify(c);
  assert.doesNotMatch(json, /<|token|senha|password/i);
  assert.equal(c.padrao, 'Novo lead');
});

test('o script: ligado por padrão, «0» desliga; parseia; nada de dado vira HTML (sem innerHTML, eval ou document.write); os dois encaixes foram trocados', () => {
  assert.equal(G.guiaJs(JSON.stringify(AGENTE), { CHATWOOT_GUIA_ETAPA: '0' } as NodeJS.ProcessEnv), '');
  assert.notEqual(G.guiaJs(JSON.stringify(AGENTE), {} as NodeJS.ProcessEnv), '');
  assert.equal(G.guiaDaEtapaLigado({} as NodeJS.ProcessEnv), true);
  assert.equal(G.guiaDaEtapaLigado({ CHATWOOT_GUIA_ETAPA: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(G.guiaDaEtapaLigado({ CHATWOOT_GUIA_ETAPA: '0' } as NodeJS.ProcessEnv), false);
  const js = G.guiaJs(JSON.stringify(AGENTE), {} as NodeJS.ProcessEnv);
  assert.doesNotThrow(() => new Function(js));
  assert.match(js, /stopImmediatePropagation/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\('on/i);
  assert.doesNotMatch(js, /__AGENTE__|__GUIA__/);
  assert.ok(js.includes(JSON.stringify(AGENTE)));
  // o guia só LÊ do Chatwoot: um único fetch, sem método de escrita
  assert.equal((js.match(/fetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(js, /method:\s*'(POST|PUT|PATCH|DELETE)'/i);
  assert.doesNotMatch(js, /localStorage|sessionStorage|XMLHttpRequest/);
  // visual nativo: a fonte do CRM, cores pelas variáveis dele, sem amarelo/degradê
  assert.ok(js.includes('Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif'));
  assert.doesNotMatch(js, /gradient|#f5b700|#fff6d6|▶/i);
});

// ── um DOM de mentira, só o que o script usa ─────────────────────────────────────────────────────────────────────

type Ouvinte = (ev: any) => void;
class No {
  children: No[] = [];
  parentElement: No | null = null;
  attrs: Record<string, string> = {};
  ouvintes: Record<string, Ouvinte[]> = {};
  style: Record<string, string> = {};
  className = '';
  shadowRoot: No | null = null;
  fechamentos: Record<string, No | null> = {};
  src = '';
  controls = false;
  autoplay = false;
  preload = '';
  paused = false;
  checked = false;
  href = '';
  target = '';
  rel = '';
  type = '';
  title = '';
  hidden = false;
  constructor(public tag: string, private texto = '') {}
  get parentNode() {
    return this.parentElement;
  }
  get isConnected() {
    for (let p: No | null = this; p; p = p.parentElement) if (p.tag === 'body') return true;
    return false;
  }
  get textContent(): string {
    return this.texto + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.texto = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  appendChild(n: No) {
    n.parentElement?.removeFilho(n);
    n.parentElement = this;
    this.children.push(n);
    return n;
  }
  removeFilho(n: No) {
    this.children = this.children.filter((c) => c !== n);
  }
  replaceChild(novo: No, velho: No) {
    const i = this.children.indexOf(velho);
    if (i >= 0) {
      this.children[i] = novo;
      novo.parentElement = this;
      velho.parentElement = null;
    }
  }
  remove() {
    this.parentElement?.removeFilho(this);
    this.parentElement = null;
  }
  addEventListener(t: string, f: Ouvinte) {
    (this.ouvintes[t] ??= []).push(f);
  }
  attachShadow() {
    this.shadowRoot = new No('#shadow');
    return this.shadowRoot;
  }
  closest(sel: string) {
    return this.fechamentos[sel] ?? null;
  }
  focus() {}
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(k: string) {
    if (k === 'src') this.src = '';
  }
  procura(pred: (n: No) => boolean): No[] {
    const achados: No[] = [];
    const ande = (n: No) => {
      for (const c of n.children) {
        if (pred(c)) achados.push(c);
        ande(c);
      }
    };
    ande(this);
    return achados;
  }
  querySelector(sel: string): No | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): No[] {
    if (sel.startsWith('.')) return this.procura((n) => n.className.split(' ').includes(sel.slice(1)));
    if (sel === 'a') return this.procura((n) => n.tag === 'a');
    if (sel === 'video') return this.procura((n) => n.tag === 'video');
    if (sel === 'input[type=checkbox]') return this.procura((n) => n.tag === 'input');
    if (sel === 'label') return this.procura((n) => n.tag === 'label');
    return [];
  }
  dispara(t: string, ev: any = {}) {
    for (const f of this.ouvintes[t] ?? []) f({ target: this, ...ev });
  }
}

let ultimoImpedido = false;

function montar(opcoes: { etapa?: () => string; painel?: boolean; logado?: boolean; contasSemAntecipado?: number[]; conta?: number } = {}) {
  const intervalos: Array<() => void> = [];
  const pedidos: Array<{ url: string; metodo: string }> = [];
  const body = new No('body');
  const doc = {
    cookie: opcoes.logado === false ? '' : `cw_d_session_info=${encodeURIComponent(JSON.stringify({ 'access-token': 'tk', client: 'cl', uid: 'u@x' }))}`,
    visibilityState: 'visible',
    body,
    ouvintes: {} as Record<string, Ouvinte[]>,
    painel: null as No | null,
    createElement: (t: string) => new No(t),
    createElementNS: (_ns: string, t: string) => new No(t),
    createTextNode: (t: string) => new No('#text', t),
    addEventListener(t: string, f: Ouvinte) {
      (this.ouvintes[t] ??= []).push(f);
    },
    removeEventListener(t: string, f: Ouvinte) {
      this.ouvintes[t] = (this.ouvintes[t] ?? []).filter((x) => x !== f);
    },
    contains: (n: No) => {
      for (let p: No | null = n; p; p = p.parentElement) if (p === body) return true;
      return false;
    },
    querySelectorAll(sel: string): No[] {
      return sel === '.list-group button' && this.painel ? [this.painel.children[0]!] : [];
    },
  };
  // o painel: embrulho > (seção .text-sm > botão «Informação da conversa»)
  const embrulho = new No('div');
  const secao = new No('div');
  const botao = new No('button', 'Informação da conversa');
  secao.appendChild(botao);
  embrulho.appendChild(secao);
  botao.fechamentos['.text-sm'] = secao;
  const lista = new No('div');
  lista.appendChild(embrulho);
  // `painel` devolve o botão como primeiro filho para o querySelectorAll acima
  const painel = new No('div');
  painel.appendChild(botao);
  if (opcoes.painel !== false) doc.painel = painel;
  const janela: any = {
    ouvintes: {} as Record<string, Ouvinte[]>,
    addEventListener(t: string, f: Ouvinte) {
      (this.ouvintes[t] ??= []).push(f);
    },
  };
  janela.top = janela;
  const loc = { pathname: `/app/accounts/${opcoes.conta ?? 1}/conversations/5` };
  const fetchFalso = async (url: string, o: any = {}) => {
    pedidos.push({ url: String(url), metodo: String(o?.method ?? 'GET').toUpperCase() });
    return { ok: true, json: async () => ({ custom_attributes: { etapa: opcoes.etapa ? opcoes.etapa() : 'Agendado' } }) };
  };
  const js = G.guiaJs(JSON.stringify(AGENTE), {} as NodeJS.ProcessEnv, opcoes.contasSemAntecipado ?? []);
  new Function('window', 'document', 'location', 'fetch', 'setInterval', 'setTimeout', js)(janela, doc, loc, fetchFalso, (f: () => void) => intervalos.push(f), (f: () => void) => f());
  // o botão do painel está dentro do embrulho de verdade: o script sobe por closest('.text-sm') até o embrulho
  secao.parentElement = embrulho;
  return {
    embrulho,
    doc,
    janela,
    loc,
    pedidos,
    body,
    async tick() {
      for (const f of intervalos) f();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    cartao: () => embrulho.children.find((c) => c.attrs['data-guia-etapa']) ?? null,
    texto: () => embrulho.children.find((c) => c.attrs['data-guia-etapa'])?.shadowRoot?.textContent ?? '',
    modal: () => body.children.find((c) => c.attrs['data-guia-modal']) ?? null,
    tecla: (key: string) => {
      let parou = false;
      let impediu = false;
      for (const f of doc.ouvintes.keydown ?? []) f({ key, stopPropagation: () => (parou = true), stopImmediatePropagation: () => (parou = true), preventDefault: () => (impediu = true) });
      ultimoImpedido = impediu;
      return parou;
    },
  };
}

test('no DOM: entra logo abaixo de «Informação da conversa», mostra os passos da etapa e a aula; só faz GET', async () => {
  const t = montar({ etapa: () => 'Agendado' });
  await t.tick();
  assert.ok(t.cartao(), 'o cartão entrou no embrulho do item');
  assert.equal(t.cartao()!.parentElement, t.embrulho);
  const txt = t.texto();
  assert.match(txt, /O que fazer agora/);
  assert.match(txt, /Agendado/);
  assert.match(txt, /Confira Data, Hora \(HH:MM\) e Situação da consulta/);
  assert.match(txt, /Aula 3\.2 · Marcar a consulta/);
  assert.match(txt, /1:17/);
  assert.match(txt, /Ver o curso inteiro/);
  assert.equal(G.URL_DO_CURSO, 'https://treinamento.doutordigitalconsultoria.com/kommo-duvidas/#crm-01');
  assert.equal(t.cartao()!.shadowRoot!.querySelector('a')?.href, G.URL_DO_CURSO);
  assert.deepEqual(t.pedidos.map((p) => p.metodo), ['GET']);
  assert.match(t.pedidos[0]!.url, /^\/api\/v1\/accounts\/1\/conversations\/5$/);
});

test('no DOM: trocou a etapa, o cartão troca sozinho (sem recarregar); sem etapa ou etapa desconhecida vale o guia de «Novo lead»', async () => {
  let etapa = 'Agendado';
  const agora = mock.method(Date, 'now', () => 1_000_000);
  try {
    const t = montar({ etapa: () => etapa });
    await t.tick();
    assert.match(t.texto(), /Aula 3\.2/);
    // dentro dos 4 s não pergunta de novo
    etapa = 'Perdido';
    agora.mock.mockImplementation(() => 1_002_000);
    await t.tick();
    assert.match(t.texto(), /Aula 3\.2/, 'ainda não passou o prazo da próxima leitura');
    agora.mock.mockImplementation(() => 1_005_000);
    await t.tick();
    assert.match(t.texto(), /Escolha o Motivo do não agendamento/);
    assert.match(t.texto(), /Aula 3\.7 · Perdido/);
    etapa = '';
    agora.mock.mockImplementation(() => 1_010_000);
    await t.tick();
    assert.match(t.texto(), /Veja se a Sofia já respondeu/);
    assert.match(t.texto(), /Sem etapa/);
    etapa = 'Etapa que não existe';
    agora.mock.mockImplementation(() => 1_015_000);
    await t.tick();
    assert.match(t.texto(), /Veja se a Sofia já respondeu/);
    assert.match(t.texto(), /Etapa que não existe · guia geral/);
    assert.ok(t.pedidos.every((p) => p.metodo === 'GET'));
  } finally {
    agora.mock.restore();
  }
});

test('no DOM: sem o painel da direita, sem login ou fora de uma conversa, o cartão não aparece (e nada é lido sem sessão)', async () => {
  const semPainel = montar({ painel: false });
  await semPainel.tick();
  assert.equal(semPainel.cartao(), null);
  const deslogado = montar({ logado: false });
  await deslogado.tick();
  assert.equal(deslogado.cartao(), null);
  assert.equal(deslogado.pedidos.length, 0);
  const fora = montar();
  fora.loc.pathname = '/app/accounts/1/dashboard';
  await fora.tick();
  assert.equal(fora.cartao(), null);
  assert.equal(fora.pedidos.length, 0);
});

test('as caixinhas dos passos são só visuais: marcar não faz pedido nenhum e vale só para aquela conversa e etapa', async () => {
  const t = montar({ etapa: () => 'Confirmado' });
  await t.tick();
  const antes = t.pedidos.length;
  const raiz = t.cartao()!.shadowRoot!;
  const cb = raiz.querySelectorAll('input[type=checkbox]')[0]!;
  cb.checked = true;
  cb.dispara('change');
  assert.equal(raiz.querySelectorAll('label')[0]!.className, 'passo feito');
  assert.equal(t.pedidos.length, antes, 'nada foi enviado');
});

test('modal: o botão da aula abre o vídeo por cima da conversa; Esc, o X e o clique fora fecham (e o vídeo para)', async () => {
  const t = montar({ etapa: () => 'Compareceu' });
  await t.tick();
  const aula = t.cartao()!.shadowRoot!.querySelector('.aula')!;
  assert.match(aula.textContent, /Aula 3\.5 · Compareceu e fechou/);
  aula.dispara('click');
  const m = t.modal();
  assert.ok(m, 'o modal abriu no body');
  // acima do painel das telas do menu (z-index 2147483000): o «?» não pode abrir o vídeo por baixo da tela
  const z = Number(/z-index:(\d+)/.exec(m!.style.cssText)?.[1]);
  assert.ok(z > 2147483000 && z <= 2147483647, `z-index do modal (${z}) tem de passar o do painel do menu`);
  // e passa o painel REAL do menu, lido do código dele (se alguém subir o painel, este teste avisa)
  const painelDoMenu = Number(/cam\.style\.cssText = '[^']*z-index:(\d+)/.exec(readFileSync(new URL('../controllers/funil.controller.ts', import.meta.url), 'utf8'))?.[1]);
  assert.ok(painelDoMenu > 0 && z > painelDoMenu, `o modal (${z}) tem de ficar acima do painel das telas (${painelDoMenu})`);
  const v = m!.shadowRoot!.querySelector('video')!;
  assert.equal(v.src, `${G.BASE_DOS_VIDEOS}c35-compareceu-fechou.mp4`);
  assert.equal(v.controls, true);
  assert.match(m!.shadowRoot!.textContent, /Aula 3\.5 · Compareceu e fechou/);
  // outra tecla não fecha
  t.tecla('a');
  assert.ok(t.modal());
  // o Tab fica dentro do modal (não vai para a conversa por baixo)
  t.tecla('Tab');
  assert.equal(ultimoImpedido, true, 'o Tab é segurado enquanto o modal está aberto');
  assert.ok(t.modal());
  // Esc fecha, para o vídeo e não deixa o Esc seguir para o Chatwoot
  assert.equal(t.tecla('Escape'), true);
  assert.equal(t.modal(), null);
  assert.equal(v.paused, true);
  assert.equal(v.src, '', 'o endereço foi tirado: o vídeo não baixa em segundo plano');
  assert.equal((t.doc.ouvintes.keydown ?? []).length, 0, 'o ouvinte do Esc saiu junto');
  // o X fecha
  aula.dispara('click');
  t.modal()!.shadowRoot!.querySelector('.fechar')!.dispara('click');
  assert.equal(t.modal(), null);
  // o clique fora (no véu) fecha; o clique dentro do modal não
  aula.dispara('click');
  const veu = t.modal()!.shadowRoot!.querySelector('.veu')!;
  veu.dispara('mousedown', { target: t.modal()!.shadowRoot!.querySelector('.modal')! });
  assert.ok(t.modal(), 'clique dentro do modal não fecha');
  veu.dispara('mousedown', { target: veu });
  assert.equal(t.modal(), null);
});

test('modal: erro ao carregar o vídeo mostra um link para abrir em outra aba, sem HTML', async () => {
  const t = montar({ etapa: () => 'Fechou' });
  await t.tick();
  t.cartao()!.shadowRoot!.querySelector('.aula')!.dispara('click');
  const v = t.modal()!.shadowRoot!.querySelector('video')!;
  v.dispara('error');
  const raiz = t.modal()!.shadowRoot!;
  assert.equal(raiz.querySelector('video'), null);
  assert.match(raiz.textContent, /Não consegui abrir o vídeo aqui/);
  assert.match(raiz.textContent, /Abrir o vídeo em outra aba/);
});

test('o «?» das telas: a mensagem do nosso servidor abre a aula da tela; outra origem, tela desconhecida ou nome estranho são ignorados', async () => {
  const t = montar();
  await t.tick();
  const msg = (origin: string, data: unknown) => t.janela.ouvintes.message!.forEach((f: Ouvinte) => f({ origin, data }));
  msg('https://outro.exemplo.test', { event: 'guia:tela', tela: 'funil' });
  assert.equal(t.modal(), null, 'origem errada');
  msg(AGENTE, { event: 'guia:tela', tela: 'nao-existe' });
  msg(AGENTE, { event: 'guia:tela', tela: '__proto__' });
  msg(AGENTE, { event: 'guia:tela', tela: 'constructor' });
  msg(AGENTE, { event: 'outra-coisa', tela: 'funil' });
  msg(AGENTE, null);
  assert.equal(t.modal(), null);
  for (const [tela, esperado] of [['funil', 'c41-funil'], ['hoje', 'c42-hoje'], ['oportunidades', 'c43-oportunidades'], ['agente', 'c24-tela-agente']] as const) {
    msg(AGENTE, { event: 'guia:tela', tela });
    assert.equal(t.modal()!.shadowRoot!.querySelector('video')!.src, `${G.BASE_DOS_VIDEOS}${esperado}.mp4`, tela);
    t.tecla('Escape');
    assert.equal(t.modal(), null);
  }
});

test('a tela Agente tem o «?» no cabeçalho, escondido fora do CRM, e pede a aula «agente» ao menu', async () => {
  const { paginaDoAgente } = await import('./agente-pagina.js');
  const html = paginaDoAgente('https://crm.exemplo.test');
  assert.match(html, /<button class="aj" id="ajuda" type="button" hidden/);
  assert.match(html, /window\.parent\.postMessage\(\{ event: 'guia:tela', tela: 'agente' \}, CW\)/);
  assert.match(html, /if \(window\.parent !== window && GUIA_LIGADO\) \{\s*\$\('ajuda'\)\.hidden = false;/);
  assert.match(html, /var GUIA_LIGADO = true;/);
  assert.doesNotMatch(html, /__GUIA_LIGADO__/);
  // com CHATWOOT_GUIA_ETAPA=0 a página sai com o guia desligado: o «?» nunca aparece
  assert.match(paginaDoAgente('https://crm.exemplo.test', { CHATWOOT_GUIA_ETAPA: '0' } as NodeJS.ProcessEnv), /var GUIA_LIGADO = false;/);
});

test('o menu.js leva o guia como um bloco independente (um erro dele não derruba o menu) e some com CHATWOOT_GUIA_ETAPA=0', async () => {
  const { montarMenuJs } = await import('../controllers/funil.controller.js');
  const ligado = montarMenuJs(AGENTE);
  assert.ok(ligado.includes('window.__guiaEtapaDD'));
  assert.doesNotThrow(() => new Function(ligado));
  const antes = process.env.CHATWOOT_GUIA_ETAPA;
  process.env.CHATWOOT_GUIA_ETAPA = '0';
  try {
    const desligado = montarMenuJs(AGENTE);
    assert.ok(!desligado.includes('__guiaEtapaDD'));
    assert.doesNotThrow(() => new Function(desligado));
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_GUIA_ETAPA;
    else process.env.CHATWOOT_GUIA_ETAPA = antes;
  }
});

test('com CHATWOOT_GUIA_ETAPA=0 o «?» do Funil/Hoje/Oportunidades também some (a página sai com GUIA_LIGADO=false)', async () => {
  const { paginaFunilHandler } = await import('../controllers/funil.controller.js');
  process.env.CHATWOOT_API_TOKEN = 'x';
  process.env.CHATWOOT_CONTA_ID = '1';
  process.env.CHATWOOT_URL = 'https://chatwoot.exemplo.test';
  const pagina = () => {
    let corpo = '';
    const res: any = { status: () => res, type: () => res, send: (h: string) => (corpo = h) };
    paginaFunilHandler({} as never, res);
    return corpo;
  };
  const antes = process.env.CHATWOOT_GUIA_ETAPA;
  try {
    delete process.env.CHATWOOT_GUIA_ETAPA;
    const ligada = pagina();
    assert.match(ligada, /var GUIA_LIGADO=true;/);
    assert.match(ligada, /if\(!aula\|\|!DENTRO\|\|!GUIA_LIGADO\) return;/);
    process.env.CHATWOOT_GUIA_ETAPA = '0';
    assert.match(pagina(), /var GUIA_LIGADO=false;/);
    assert.ok(!pagina().includes('__GUIA_LIGADO__'));
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_GUIA_ETAPA;
    else process.env.CHATWOOT_GUIA_ETAPA = antes;
  }
});

test('Agendado: o guia diz o que o robô do pré-pagamento lê — «Pagamento antecipado» = vai pagar antes; pagou = etiqueta «pagou-antecipado»', () => {
  const passos = G.GUIA_DAS_ETAPAS['Agendado'].passos.join(' | ');
  assert.match(passos, /Vai pagar antes\? Marque «Pagamento antecipado»/);
  assert.match(passos, /etiqueta «pagou-antecipado»/);
  assert.doesNotMatch(passos, /Pagou o sinal\? Marque «Pagamento antecipado»/, 'marcar o campo para quem já pagou faria o robô cobrar de novo');
});

test('unidade SEM pagamento antecipado (Timbó, conta 3): Agendado não mostra Pix nem «pagou-antecipado» e diz que a consulta é paga no dia; a aula e as outras etapas são as mesmas', async () => {
  const sem = montar({ etapa: () => 'Agendado', conta: 3, contasSemAntecipado: [3] });
  await sem.tick();
  const t = sem.texto();
  assert.match(t, /Confira Data, Hora \(HH:MM\) e Situação da consulta/);
  assert.match(t, /A consulta é paga no dia, na clínica: não ofereça Pix nem pagamento antecipado/);
  assert.match(t, /Aula 3\.2 · Marcar a consulta/);
  assert.doesNotMatch(t, /Marque «Pagamento antecipado»|pagou-antecipado|o robô pergunta|o robô para de cobrar/);
  assert.doesNotMatch(t, /Vai pagar antes/);
  // as outras etapas da mesma conta não mudam
  let etapa = 'Perdido';
  const outra = montar({ etapa: () => etapa, conta: 3, contasSemAntecipado: [3] });
  await outra.tick();
  assert.match(outra.texto(), /Escolha o Motivo do não agendamento/);
});

test('conta que ACEITA antecipado (ou que não está na lista): Agendado segue com os passos do Pix, como sempre', async () => {
  const aceita = montar({ etapa: () => 'Agendado', conta: 1, contasSemAntecipado: [3] });
  await aceita.tick();
  assert.match(aceita.texto(), /Vai pagar antes\? Marque «Pagamento antecipado»/);
  assert.match(aceita.texto(), /pagou-antecipado/);
  const semLista = montar({ etapa: () => 'Agendado', conta: 3 });
  await semLista.tick();
  assert.match(semLista.texto(), /Vai pagar antes\?/);
});

test('o conteúdo do guia leva só ids de conta inteiros e positivos, e os passos sem antecipado cobrem só etapas que existem', () => {
  const c = G.conteudoDoGuia([3, 0, -1, 2.5, 7]);
  assert.deepEqual(c.semAntecipado, [3, 7]);
  assert.deepEqual(G.conteudoDoGuia().semAntecipado, []);
  for (const e of Object.keys(G.PASSOS_SEM_ANTECIPADO)) assert.ok(G.ETAPAS_DO_CRM.includes(e as never), e);
  assert.doesNotMatch(G.PASSOS_SEM_ANTECIPADO.Agendado!.join(' '), /pagou-antecipado|Marque/);
  assert.equal(new Function(`return ${JSON.stringify(c)}`)().semAntecipado.length, 2);
});
