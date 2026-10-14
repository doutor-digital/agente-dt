// Fase 3 — o painel.js inteiro (os scripts na ordem do painel.html) no jsdom, com `chrome`, `fetch` e relógio
// falsos. Prova o caminho de verdade: "Começar a ligar" abre a conversa só pela URL com o telefone, espera o ritmo,
// grava o resultado, pula quem não tem telefone e guarda só ids e horas; as etiquetas vão com quem pôs; e a
// resposta pronta copiada sai com o nome do paciente DA TELA (nunca o do anterior).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'painel.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const esperar = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.parse('2026-10-14T13:00:00.000Z');

const item = (leadId, extra = {}) => ({
  leadId,
  nome: 'Paciente ' + leadId,
  etapa: 'EM ESPERA',
  motivo: 'retomar contato',
  detalhe: 'retomar hoje',
  telefone: '55999000000' + String(leadId).padStart(2, '0'),
  telefoneVisivel: '(99) 90000-00' + String(leadId).padStart(2, '0'),
  link: 'https://x.kommo.com/leads/detail/' + leadId,
  passado: false,
  quando: '2026-10-14T12:00:00.000Z',
  ...extra,
});

const FILA = {
  unidade: 'Açailândia',
  atualizadoEm: '2026-10-14T13:00:00.000Z',
  ritmo: { intervaloS: 40, tetoPorHora: 2 },
  grupos: [
    { id: 'sem-resposta', etapa: 'entrada', rotulo: 'sem resposta', total: 2, itens: [item(1), item(2, { telefone: null, telefoneVisivel: null })] },
    { id: 'retomar', etapa: 'EM ESPERA', rotulo: 'retomar contato', total: 2, itens: [item(3), item(4)] },
  ],
};

const cartaoDe = (id, primeiroNome, etiquetas = []) => ({
  achado: true,
  como: 'telefone',
  cartao: {
    id,
    nome: primeiroNome.toUpperCase() + ' SOUZA 03/10/2026',
    primeiroNome,
    link: 'https://x.kommo.com/leads/detail/' + id,
    funil: 'COMERCIAL',
    etapa: 'EM ESPERA',
    fechado: false,
    etiquetas,
    sofia: { pausada: false, por: null, ate: null },
  },
  duplicados: [],
});

function montar({ conversa = { aberta: false }, rotas = {}, guardado = {} } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/painel.html' });
  const w = dom.window;
  const relogio = { agora: T0, intervalos: new Map(), proximo: 1 };
  w.Date.now = () => relogio.agora;
  w.setInterval = (f) => { const id = relogio.proximo++; relogio.intervalos.set(id, f); return id; };
  w.clearInterval = (id) => { relogio.intervalos.delete(id); };
  const armazenado = { slug: 'doutor-hernia-acailandia', chave: 'k', nome: 'Ana', ...guardado };
  const atualizacoes = [];
  const pedidos = [];
  const copiados = [];
  const ouvintes = {};
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: (t) => { copiados.push(t); return Promise.resolve(); } }, configurable: true });
  w.chrome = {
    storage: {
      local: {
        get: (chaves) => Promise.resolve(Object.fromEntries((Array.isArray(chaves) ? chaves : [chaves]).filter((k) => k in armazenado).map((k) => [k, JSON.parse(JSON.stringify(armazenado[k]))]))),
        set: (o) => { Object.assign(armazenado, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 7 }]),
      sendMessage: () => Promise.resolve(conversa),
      update: (id, p) => { atualizacoes.push({ id, ...p }); return Promise.resolve({}); },
      onActivated: { addListener: () => {} },
    },
    runtime: { onMessage: { addListener: (f) => { ouvintes.mensagem = f; } }, openOptionsPage: () => {} },
  };
  w.fetch = (url, init = {}) => {
    const u = new URL(url);
    const caminho = u.pathname.replace('/api/public/widget/doutor-hernia-acailandia', '');
    const metodo = init.method || 'GET';
    const corpo = init.body ? JSON.parse(init.body) : null;
    pedidos.push({ metodo, caminho, corpo, chave: init.headers && init.headers['X-Widget-Key'] });
    const r = rotas[metodo + ' ' + caminho];
    const resposta = typeof r === 'function' ? r(corpo) : r;
    return Promise.resolve({ ok: !!resposta, status: resposta ? 200 : 500, json: () => Promise.resolve(resposta || { error: 'falhou' }) });
  };
  for (const s of scripts) w.eval(fs.readFileSync(path.join(raiz, s), 'utf8'));
  const tempo = async (ms) => {
    relogio.agora += ms;
    for (const f of [...relogio.intervalos.values()]) f();
    await esperar();
    await esperar();
  };
  const doc = w.document;
  return { w, doc, armazenado, atualizacoes, pedidos, copiados, ouvintes, tempo };
}

describe('painel — "Começar a ligar" (fase 3)', () => {
  it('abre a conversa pela URL, espera o ritmo, grava o resultado, pula sem telefone e respeita o teto', async () => {
    const p = montar({
      rotas: {
        'GET /ponte/fila': FILA,
        'POST /ponte/ligacao': (c) => ({ leadId: c.leadId, resultado: c.resultado, campos: true, nota: true, tentativas: 1, avisos: [] }),
      },
    });
    try {
      await esperar(10);
      p.doc.getElementById('aba-fila').click();
      await esperar(10);
      const comecar = p.doc.querySelector('[data-acao="comecar-ligar"]');
      assert.equal(comecar.textContent, 'Começar a ligar');
      comecar.click();
      await esperar();
      await esperar();

      // 1º: abre na hora, só com o telefone (navegação), e o painel fica na fila
      assert.deepEqual(p.atualizacoes, [{ id: 7, url: 'https://web.whatsapp.com/send?phone=5599900000001', active: true }]);
      assert.equal(p.doc.getElementById('fila').hidden, false);
      assert.match(p.doc.getElementById('fila').textContent, /Clique no 📞 do WhatsApp para ligar/);

      // resultado → POST com o cartão, o resultado e quem
      p.doc.querySelector('[data-resultado="nao-atendeu"]').click();
      await esperar();
      await esperar();
      const gravou = p.pedidos.find((x) => x.caminho === '/ponte/ligacao');
      assert.deepEqual(gravou.corpo, { leadId: 1, resultado: 'nao-atendeu', por: 'Ana' });
      assert.equal(gravou.chave, 'k');

      // o 2 não tem telefone: pulado com aviso; o 3 espera os 40 s do ritmo
      const fila = p.doc.getElementById('fila');
      assert.match(fila.querySelector('[data-bloco="pulados"]').textContent, /Paciente 2/);
      assert.match(fila.querySelector('.ligacao__nome').textContent, /Paciente 3/);
      assert.equal(fila.querySelector('[data-papel="espera"]').textContent, 'próximo em 40 s');
      assert.equal(p.atualizacoes.length, 1, 'não abre antes do intervalo');
      await p.tempo(15_000);
      assert.equal(fila.querySelector('[data-papel="espera"]').textContent, 'próximo em 25 s');
      await p.tempo(25_000);
      assert.equal(p.atualizacoes.length, 2);
      assert.equal(p.atualizacoes[1].url, 'https://web.whatsapp.com/send?phone=5599900000003');

      // "Pular" não grava nada; o teto (2 por hora) segura o 4 até a 1ª abertura sair da janela
      fila.querySelector('.ligacao__resultados [data-acao="pular-ligacao"]').click();
      await esperar();
      assert.equal(p.pedidos.filter((x) => x.caminho === '/ponte/ligacao').length, 1);
      assert.match(fila.textContent, /teto de 2 conversas na última hora/);
      await p.tempo(60_000);
      assert.equal(p.atualizacoes.length, 2, 'o teto ainda segura');
      await p.tempo(60 * 60_000);
      assert.equal(p.atualizacoes.length, 3);
      assert.equal(p.atualizacoes[2].url, 'https://web.whatsapp.com/send?phone=5599900000004');

      // o que ficou guardado: só ids e horas
      const guardado = JSON.stringify(p.armazenado.ligacao);
      assert.deepEqual(p.armazenado.ligacao.feitos, [1, 2, 3]);
      assert.equal(p.armazenado.ligacao.atual, 4);
      for (const t of ['Paciente', '559990000', '(99)']) assert.ok(!guardado.includes(t), `vazou "${t}" no storage`);
      // nenhuma URL com texto
      assert.ok(p.atualizacoes.every((a) => !/text=/.test(a.url)));
    } finally {
      p.w.close();
    }
  });

  it('fechar e reabrir o painel: continua do mesmo paciente, sem abrir a conversa de novo', async () => {
    // o storage como ficou quando o painel fechou: 1 e 2 feitos, a conversa do 3 aberta há 10 s
    const p = montar({
      rotas: { 'GET /ponte/fila': FILA },
      guardado: { ligacao: { v: 1, dia: '2026-10-14', slug: 'doutor-hernia-acailandia', feitos: [1, 2], atual: 3, aberturas: [T0 - 10_000] } },
    });
    try {
      await esperar(10);
      p.doc.getElementById('aba-fila').click();
      await esperar(10);
      const b = p.doc.querySelector('[data-acao="comecar-ligar"]');
      assert.equal(b.textContent, 'Continuar a ligar (2 feitos hoje)');
      b.click();
      await esperar();
      assert.match(p.doc.getElementById('fila').textContent, /Clique no 📞 do WhatsApp para ligar/);
      assert.match(p.doc.querySelector('.ligacao__nome').textContent, /Paciente 3/);
      assert.equal(p.atualizacoes.length, 0, 'a conversa já estava aberta');
      // "Abrir a conversa de novo" é a mesma conversa: abre na hora, sem contar no ritmo
      p.doc.querySelector('[data-acao="reabrir-ligacao"]').click();
      await esperar();
      await esperar();
      assert.equal(p.atualizacoes.length, 1);
      assert.deepEqual(p.armazenado.ligacao.aberturas, [T0 - 10_000]);
    } finally {
      p.w.close();
    }
  });
});

describe('painel — etiquetas e respostas prontas (fase 3)', () => {
  it('pôr etiqueta manda quem pôs e redesenha com a lista RELIDA do servidor', async () => {
    const conversa = { aberta: true, tipo: 'individual', chave: 'c1', telefone: '5599900000043', nome: 'Maria Souza', fonteTelefone: 'jid', impressoes: [] };
    const p = montar({
      conversa,
      rotas: {
        'POST /ponte/cartao': cartaoDe(123, 'Maria', ['LOMBAR']),
        'GET /ponte/etiquetas': { etiquetas: [{ nome: 'LOMBAR', robo: false }, { nome: 'META', robo: false }] },
        'POST /ponte/etiquetas': (c) => ({ leadId: c.leadId, nome: c.nome, mudou: true, etiquetas: ['LOMBAR', 'META'] }),
      },
    });
    try {
      await esperar(600); // a espera de 400 ms do painel antes de procurar o cartão
      const cart = p.doc.getElementById('conteudo');
      assert.match(cart.textContent, /MARIA SOUZA/);
      cart.querySelector('[data-acao="abrir-etiquetas"]').click();
      await esperar();
      await esperar();
      cart.querySelector('[data-papel="opcoes-etiqueta"] [data-etiqueta="META"]').click();
      await esperar();
      await esperar();
      const pos = p.pedidos.find((x) => x.metodo === 'POST' && x.caminho === '/ponte/etiquetas');
      assert.deepEqual(pos.corpo, { leadId: 123, nome: 'META', por: 'Ana', confirmado: false });
      assert.deepEqual([...p.doc.querySelectorAll('[data-bloco="etiquetas"] .etiqueta')].map((c) => c.getAttribute('data-etiqueta')), ['LOMBAR', 'META']);
    } finally {
      p.w.close();
    }
  });

  it('a resposta copiada sai com o nome do paciente da tela; trocando de conversa, nunca com o nome do anterior', async () => {
    const conversa = { aberta: true, tipo: 'individual', chave: 'c1', telefone: '5599900000043', nome: 'Maria Souza', fonteTelefone: 'jid', impressoes: [] };
    let cartaoAtual = cartaoDe(123, 'Maria');
    const p = montar({
      conversa,
      rotas: {
        'POST /ponte/cartao': () => cartaoAtual,
        'GET /ponte/respostas': { respostas: [{ id: 1, nome: 'Bom dia', texto: 'Bom dia, {{contact.name}}!', temAnexo: false }], ondeCadastrar: 'x' },
      },
    });
    try {
      await esperar(600);
      p.doc.getElementById('aba-respostas').click();
      await esperar();
      await esperar();
      const aba = p.doc.getElementById('respostas');
      assert.equal(aba.hidden, false);
      aba.querySelector('[data-acao="copiar-resposta"]').click();
      await esperar();
      assert.deepEqual(p.copiados, ['Bom dia, Maria!']);

      // a atendente troca de conversa: enquanto o cartão novo não chega, o nome some
      cartaoAtual = cartaoDe(456, 'João');
      p.ouvintes.mensagem({ tipo: 'ponte:conversa', estado: { ...conversa, chave: 'c2', telefone: '5599900000044', nome: 'João Lima' } }, { tab: { id: 7 } });
      p.doc.getElementById('respostas').querySelector('[data-acao="copiar-resposta"]').click();
      await esperar();
      assert.equal(p.copiados[1], 'Bom dia, [nome]!');
      await esperar(600);
      p.doc.getElementById('respostas').querySelector('[data-acao="copiar-resposta"]').click();
      await esperar();
      assert.equal(p.copiados[2], 'Bom dia, João!');
    } finally {
      p.w.close();
    }
  });
});
