// 0.4.0 — o número no ícone: quantos pacientes esperam resposta. As regras do `contador.js`, o script de fundo do
// Chrome (service worker com importScripts) e o do Firefox (background.scripts), com `chrome`/`browser` falsos.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../contador.js');

const raiz = path.join(__dirname, '..');
const esperar = () => new Promise((r) => setTimeout(r, 0));

/** Um `chrome` falso: o ícone (badge, cor, dica), o storage, os alarmes e os ouvintes. */
function apiFalsa(guardado = { slug: 'doutor-hernia-acailandia', chave: 'k' }) {
  const ouvintes = { alarme: [], storage: [], instalou: [], abriu: [], clique: [] };
  const icone = { texto: null, cor: null, dica: null, corTexto: null };
  const alarmes = new Map();
  const armazenado = { ...guardado };
  const api = {
    icone,
    alarmes,
    armazenado,
    ouvintes,
    action: {
      setBadgeText: ({ text }) => { icone.texto = text; return Promise.resolve(); },
      setBadgeBackgroundColor: ({ color }) => { icone.cor = color; return Promise.resolve(); },
      setBadgeTextColor: ({ color }) => { icone.corTexto = color; return Promise.resolve(); },
      setTitle: ({ title }) => { icone.dica = title; return Promise.resolve(); },
      onClicked: { addListener: (f) => ouvintes.clique.push(f) },
    },
    storage: {
      local: {
        get: (chaves) => Promise.resolve(Object.fromEntries(chaves.filter((k) => k in armazenado).map((k) => [k, JSON.parse(JSON.stringify(armazenado[k]))]))),
        set: (o) => { Object.assign(armazenado, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
      },
      onChanged: { addListener: (f) => ouvintes.storage.push(f) },
    },
    alarms: {
      get: (nome) => Promise.resolve(alarmes.get(nome)),
      create: (nome, o) => { alarmes.set(nome, { name: nome, ...o }); return Promise.resolve(); },
      onAlarm: { addListener: (f) => ouvintes.alarme.push(f) },
    },
    runtime: {
      onInstalled: { addListener: (f) => ouvintes.instalou.push(f) },
      onStartup: { addListener: (f) => ouvintes.abriu.push(f) },
      openOptionsPage: () => {},
    },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    sidebarAction: { toggle: () => {} },
  };
  return api;
}

function fetchFalso(respostas) {
  const pedidos = [];
  const f = (url, init) => {
    pedidos.push({ url, chave: init && init.headers && init.headers['X-Widget-Key'] });
    const r = respostas.shift();
    if (r instanceof Error) return Promise.reject(r);
    if (typeof r === 'number') return Promise.resolve({ ok: false, status: r, json: () => Promise.resolve({ error: 'x' }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(r) });
  };
  f.pedidos = pedidos;
  return f;
}

describe('contador — o que aparece no ícone', () => {
  it('N pacientes: o número e a dica "N pacientes esperando resposta"', () => {
    assert.deepEqual(C.badge({ total: 3, completo: true }, null), { texto: '3', cor: C.COR_ALERTA, dica: '3 pacientes esperando resposta', total: 3 });
    assert.equal(C.badge({ total: 1, completo: true }, null).dica, '1 paciente esperando resposta');
    assert.equal(C.badge({ total: 250, completo: true }, null).texto, '99+');
  });

  it('subiu: cor de alerta; igual ou desceu: laranja; zerou: sem número', () => {
    assert.equal(C.badge({ total: 4, completo: true }, 3).cor, C.COR_ALERTA);
    assert.equal(C.badge({ total: 3, completo: true }, 3).cor, C.COR_ATENCAO);
    assert.equal(C.badge({ total: 2, completo: true }, 3).cor, C.COR_ATENCAO);
    assert.equal(C.badge({ total: 0, completo: true }, 3).texto, '');
  });

  it('falha do Kommo (total null), resposta estranha ou 0 com leitura incompleta: "?" — nunca um 0 falso', () => {
    for (const r of [null, undefined, {}, { total: null, completo: false }, { total: 'x' }, { total: -1 }, { total: 0, completo: false }]) {
      const b = C.badge(r, 5);
      assert.equal(b.texto, '?', JSON.stringify(r));
      assert.notEqual(b.texto, '0');
      assert.equal(b.total, null);
      assert.match(b.dica, /Não consegui contar/);
    }
    assert.equal(C.badge({ total: 2, completo: false }, null).texto, '2+', 'leitura cortada: pode haver mais');
  });
});

describe('contador — atualizar o ícone', () => {
  it('pergunta ao servidor com a chave no header e põe número, cor e dica; guarda só o total e a unidade', async () => {
    const api = apiFalsa();
    const f = fetchFalso([{ total: 2, completo: true }]);
    await C.atualizar(api, { base: 'https://srv', fetch: f });
    assert.deepEqual(f.pedidos, [{ url: 'https://srv/api/public/widget/doutor-hernia-acailandia/ponte/contador', chave: 'k' }]);
    assert.deepEqual(api.icone, { texto: '2', cor: C.COR_ALERTA, dica: '2 pacientes esperando resposta', corTexto: '#ffffff' });
    assert.deepEqual(api.armazenado.contadorAnterior, { slug: 'doutor-hernia-acailandia', total: 2 });
  });

  it('servidor fora, erro HTTP ou Kommo fora: "?" e o último total bom continua guardado', async () => {
    for (const falha of [new Error('sem internet'), 502, { total: null, completo: false }]) {
      const api = apiFalsa({ slug: 'doutor-hernia-acailandia', chave: 'k', contadorAnterior: { slug: 'doutor-hernia-acailandia', total: 4 } });
      await C.atualizar(api, { base: 'https://srv', fetch: fetchFalso([falha]) });
      assert.equal(api.icone.texto, '?', String(falha));
      assert.equal(api.icone.cor, C.COR_SEM_SABER);
      assert.deepEqual(api.armazenado.contadorAnterior, { slug: 'doutor-hernia-acailandia', total: 4 });
    }
  });

  it('o "subiu" compara com a leitura anterior da MESMA unidade', async () => {
    const api = apiFalsa({ slug: 'doutor-hernia-acailandia', chave: 'k', contadorAnterior: { slug: 'doutor-hernia-acailandia', total: 2 } });
    await C.atualizar(api, { base: 'https://srv', fetch: fetchFalso([{ total: 2, completo: true }]) });
    assert.equal(api.icone.cor, C.COR_ATENCAO, 'igual: não é alerta');
    await C.atualizar(api, { base: 'https://srv', fetch: fetchFalso([{ total: 3, completo: true }]) });
    assert.equal(api.icone.cor, C.COR_ALERTA, 'subiu');
    const outra = apiFalsa({ slug: 'outra', chave: 'k', contadorAnterior: { slug: 'doutor-hernia-acailandia', total: 9 } });
    await C.atualizar(outra, { base: 'https://srv', fetch: fetchFalso([{ total: 3, completo: true }]) });
    assert.equal(outra.icone.cor, C.COR_ALERTA, 'a leitura de outra unidade não conta');
  });

  it('sem unidade configurada: não pergunta nada e o ícone fica sem número', async () => {
    const api = apiFalsa({});
    const f = fetchFalso([]);
    await C.atualizar(api, { base: 'https://srv', fetch: f });
    assert.equal(f.pedidos.length, 0);
    assert.equal(api.icone.texto, '');
  });

  it('ligar: alarme de 5 em 5 min; o alarme e a troca de unidade atualizam; outra mudança no storage não', async () => {
    const api = apiFalsa();
    const f = fetchFalso([{ total: 1, completo: true }, { total: 2, completo: true }, { total: 3, completo: true }]);
    C.ligar(api, { base: 'https://srv', fetch: f });
    await esperar();
    assert.equal(api.alarmes.get('ponte-contador').periodInMinutes, 5);
    api.ouvintes.alarme.forEach((o) => o({ name: 'ponte-contador' }));
    await esperar();
    await esperar();
    assert.equal(f.pedidos.length, 1);
    api.ouvintes.alarme.forEach((o) => o({ name: 'outro-alarme' }));
    api.ouvintes.storage.forEach((o) => o({ contadorAnterior: {} }, 'local'));
    await esperar();
    assert.equal(f.pedidos.length, 1, 'alarme de outro e mudança do próprio contador não perguntam');
    api.ouvintes.storage.forEach((o) => o({ slug: { newValue: 'x' } }, 'local'));
    await esperar();
    await esperar();
    assert.equal(f.pedidos.length, 2);
  });
});

/** Roda um script de fundo num contexto com a api falsa (como o navegador faria). */
function rodarFundo(arquivo, api, comImportScripts) {
  const fetchs = fetchFalso([{ total: 7, completo: true }]);
  const ctx = { console, Promise, setTimeout, fetch: fetchs };
  ctx.self = ctx;
  if (comImportScripts) {
    ctx.chrome = api;
    ctx.importScripts = (...arquivos) => arquivos.forEach((a) => vm.runInContext(fs.readFileSync(path.join(raiz, a), 'utf8'), ctx));
  } else {
    ctx.browser = api;
  }
  vm.createContext(ctx);
  if (!comImportScripts) {
    // Firefox: o manifest carrega config.js e contador.js antes do fundo.js
    for (const a of ['config.js', 'contador.js']) vm.runInContext(fs.readFileSync(path.join(raiz, a), 'utf8'), ctx);
  }
  vm.runInContext(fs.readFileSync(path.join(raiz, arquivo), 'utf8'), ctx);
  return fetchs;
}

describe('contador — os scripts de fundo e os manifests', () => {
  it('Chrome: o service worker carrega o contador, registra os ouvintes no topo e conta ao instalar', async () => {
    const api = apiFalsa();
    const f = rodarFundo('fundo.js', api, true);
    assert.equal(api.ouvintes.alarme.length, 1, 'o ouvinte do alarme fica no topo (o service worker dorme e acorda)');
    api.ouvintes.instalou.forEach((o) => o({ reason: 'update' }));
    await esperar();
    await esperar();
    await esperar();
    assert.equal(f.pedidos.length, 1);
    assert.match(f.pedidos[0].url, /\/ponte\/contador$/);
    assert.equal(api.icone.texto, '7');
  });

  it('Firefox: o mesmo contador, com browser.* (e o clique no ícone abre a barra lateral)', async () => {
    const api = apiFalsa();
    const f = rodarFundo('firefox/fundo.js', api, false);
    assert.equal(api.ouvintes.clique.length, 1);
    api.ouvintes.abriu.forEach((o) => o());
    await esperar();
    await esperar();
    await esperar();
    assert.equal(f.pedidos.length, 1);
    assert.equal(api.icone.texto, '7');
  });

  it('manifests: 0.5.1, permissão de alarmes, e o Firefox carrega config e contador antes do fundo', () => {
    const chrome = JSON.parse(fs.readFileSync(path.join(raiz, 'manifest.json'), 'utf8'));
    const firefox = JSON.parse(fs.readFileSync(path.join(raiz, 'firefox/manifest.json'), 'utf8'));
    for (const m of [chrome, firefox]) {
      assert.equal(m.version, '0.5.1');
      assert.ok(m.permissions.includes('alarms'));
      assert.ok(!m.permissions.includes('notifications'), 'sem notificação do sistema nesta versão');
      assert.ok(m.description.length <= 132, 'o Chrome limita a descrição a 132 letras');
    }
    assert.deepEqual(firefox.background.scripts, ['config.js', 'contador.js', 'fundo.js']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version, '0.5.1');
  });
});

describe('Firefox: a pasta montada (0.5.1)', () => {
  it('montar.sh leva a fonte do painel, o abrir.js e o manifest do Firefox', () => {
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    const saida = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-ff-'));
    try {
      execFileSync('bash', [path.join(raiz, 'firefox', 'montar.sh'), saida], { stdio: 'ignore' });
      assert.ok(fs.existsSync(path.join(saida, 'fontes', 'PlusJakartaSans-latin.woff2')));
      assert.ok(fs.existsSync(path.join(saida, 'fontes', 'OFL.txt')), 'a licença vai junto da fonte');
      for (const a of ['abrir.js', 'trilha.js', 'icones.js', 'painel.css']) assert.ok(fs.existsSync(path.join(saida, a)), a);
      const m = JSON.parse(fs.readFileSync(path.join(saida, 'manifest.json'), 'utf8'));
      assert.ok(m.browser_specific_settings, 'é o manifest do Firefox');
      assert.equal(m.version, '0.5.1');
      assert.ok(!fs.existsSync(path.join(saida, 'testes')), 'sem os testes');
    } finally {
      fs.rmSync(saida, { recursive: true, force: true });
    }
  });

  it('os dois manifests carregam o abrir.js antes do conteudo.js e não pedem permissão nova', () => {
    for (const arq of ['manifest.json', 'firefox/manifest.json']) {
      const m = JSON.parse(fs.readFileSync(path.join(raiz, arq), 'utf8'));
      const js = m.content_scripts[0].js;
      assert.deepEqual(js, ['seletores.js', 'impressao.js', 'leitor.js', 'abrir.js', 'conteudo.js'], arq);
      for (const p of ['tabs', 'scripting', 'webNavigation', 'clipboardRead']) assert.ok(!m.permissions.includes(p), `${arq} sem ${p}`);
    }
  });
});
