// Fase 3 (e o guia da 0.4.0) — o painel.js inteiro (os scripts na ordem do painel.html) no jsdom, com `chrome`,
// `fetch` e relógio falsos. Prova o caminho de verdade: "Começar a ligar" abre a conversa só pela URL com o telefone, espera o ritmo,
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
    { id: 'sem-resposta', etapa: 'entrada', rotulo: 'sem resposta', total: 2, itens: [item(1), item(2, { telefone: null, telefoneVisivel: null, semTelefone: true })] },
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

// 0.5.0: o que o content script responde ao "abrir sem recarregar". Padrão: o WhatsApp não tratou o link (os testes
// antigos continuam provando o jeito antigo, pela URL). 'rejeita' = aba com o script de uma versão antiga.
function montar({ conversa = { aberta: false }, rotas = {}, guardado = {}, abrir = { aberta: false, motivo: 'nao-tratou' } } = {}) {
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
  const mensagens = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: (t) => { copiados.push(t); return Promise.resolve(); } }, configurable: true });
  w.chrome = {
    storage: {
      local: {
        get: (chaves) => Promise.resolve(Object.fromEntries((Array.isArray(chaves) ? chaves : [chaves]).filter((k) => k in armazenado).map((k) => [k, JSON.parse(JSON.stringify(armazenado[k]))]))),
        set: (o) => { Object.assign(armazenado, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
      },
      onChanged: { addListener: (f) => { ouvintes.storage = f; } },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 7 }]),
      sendMessage: (id, m) => {
        mensagens.push({ id, ...m });
        if (m && m.tipo === 'ponte:abrir-conversa') return abrir === 'rejeita' ? Promise.reject(new Error('Could not establish connection')) : Promise.resolve(abrir);
        return Promise.resolve(conversa);
      },
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
    pedidos.push({ metodo, caminho, busca: u.search, corpo, chave: init.headers && init.headers['X-Widget-Key'] });
    const r = rotas[metodo + ' ' + caminho];
    const resposta = typeof r === 'function' ? r(corpo) : r;
    // 0.5.1: `{ __status, corpo }` responde com outro status (o servidor de antes, sem a rota da nota)
    if (resposta && resposta.__status) {
      return Promise.resolve({ ok: resposta.__status < 400, status: resposta.__status, json: () => (resposta.corpo === undefined ? Promise.reject(new Error('não é JSON')) : Promise.resolve(resposta.corpo)) });
    }
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
  return { w, doc, armazenado, atualizacoes, pedidos, copiados, ouvintes, tempo, mensagens };
}

describe('painel — abrir a conversa sem recarregar (0.5.0)', () => {
  async function comecar(p) {
    await esperar(10);
    p.doc.getElementById('aba-fila').click();
    await esperar(10);
    p.doc.querySelector('[data-acao="comecar-ligar"]').click();
    for (let i = 0; i < 6; i++) await esperar();
  }

  it('o link wa.me da Ponte abriu: a aba só vem para a frente, sem trocar a URL (não recarrega)', async () => {
    const p = montar({ rotas: { 'GET /ponte/fila': FILA }, abrir: { aberta: true } });
    try {
      await comecar(p);
      const pedidos = p.mensagens.filter((m) => m.tipo === 'ponte:abrir-conversa');
      assert.deepEqual(pedidos, [{ id: 7, tipo: 'ponte:abrir-conversa', telefone: '5599900000001' }]);
      assert.deepEqual(p.atualizacoes, [{ id: 7, active: true }], 'nenhuma URL: o WhatsApp Web não recarrega');
      assert.match(p.doc.getElementById('fila').textContent, /Clique no 📞 do WhatsApp para ligar/);
    } finally {
      p.w.close();
    }
  });

  it('não abriu pelo link (ou a aba tem o script antigo): cai para o jeito antigo, pela URL, e registra no console', async () => {
    for (const abrir of [{ aberta: false, motivo: 'nao-abriu' }, 'rejeita']) {
      const p = montar({ rotas: { 'GET /ponte/fila': FILA }, abrir });
      const avisos = [];
      p.w.console.info = (t) => avisos.push(String(t));
      try {
        await comecar(p);
        assert.deepEqual(p.atualizacoes, [{ id: 7, url: 'https://web.whatsapp.com/send?phone=5599900000001', active: true }]);
        assert.match(avisos.join(' '), /jeito antigo, com recarga/);
      } finally {
        p.w.close();
      }
    }
  });

  it('com a chave "Abrir conversa sem recarregar" desligada nas opções, vai direto pela URL', async () => {
    const p = montar({ rotas: { 'GET /ponte/fila': FILA }, guardado: { semRecarregar: false }, abrir: { aberta: true } });
    try {
      await comecar(p);
      assert.equal(p.mensagens.filter((m) => m.tipo === 'ponte:abrir-conversa').length, 0);
      assert.deepEqual(p.atualizacoes, [{ id: 7, url: 'https://web.whatsapp.com/send?phone=5599900000001', active: true }]);
    } finally {
      p.w.close();
    }
  });
});

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
      const { tentativa, ...semTentativa } = gravou.corpo;
      assert.deepEqual(semTentativa, { leadId: 1, resultado: 'nao-atendeu', por: 'Ana' });
      assert.match(tentativa, /^[A-Za-z0-9_-]{8,64}$/, 'o resultado leva o id da tentativa');
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

      // o que ficou guardado: só ids, horas e o id da tentativa
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

describe('painel — revisão: gravação dupla e telefone não lido', () => {
  it('resultado pendente: trocar de aba e voltar NÃO destrava os botões, e o segundo clique não manda nada', async () => {
    let soltar;
    const pendente = new Promise((r) => { soltar = r; });
    const p = montar({
      rotas: {
        'GET /ponte/fila': FILA,
        'POST /ponte/ligacao': () => pendente,
      },
    });
    // a rota devolve uma promessa pendente: o json() do fetch falso só resolve quando ela soltar
    try {
      await esperar(10);
      p.doc.getElementById('aba-fila').click();
      await esperar(10);
      p.doc.querySelector('[data-acao="comecar-ligar"]').click();
      await esperar();
      await esperar();
      p.doc.querySelector('[data-resultado="atendeu"]').click();
      await esperar();
      // redesenho pela aba
      p.doc.getElementById('aba-conversa').click();
      p.doc.getElementById('aba-fila').click();
      await esperar();
      const botoes = [...p.doc.querySelectorAll('[data-acao="resultado"]')];
      assert.ok(botoes.length && botoes.every((b) => b.disabled), 'continuam travados');
      botoes[1].click();
      await esperar();
      assert.equal(p.pedidos.filter((x) => x.caminho === '/ponte/ligacao').length, 1, 'um pedido só');
      soltar({ leadId: 1, resultado: 'atendeu', campos: true, nota: false, tentativas: 1, avisos: [] });
      await esperar();
      await esperar();
      assert.match(p.doc.getElementById('fila').textContent, /Gravado no Kommo: Paciente 1 · atendeu/);
    } finally {
      p.w.close();
    }
  });

  it('o Kommo não deu os telefones: ninguém é marcado como feito e a tela não diz que acabou', async () => {
    const semLeitura = {
      ...FILA,
      avisoTelefones: 'Não consegui ler os telefones agora: tente de novo (Atualizar).',
      grupos: [{ id: 'retomar', etapa: 'EM ESPERA', rotulo: 'retomar contato', total: 2, itens: [
        item(3, { telefone: null, telefoneVisivel: null, semTelefone: false }),
        item(4, { telefone: null, telefoneVisivel: null, semTelefone: false }),
      ] }],
    };
    const p = montar({ rotas: { 'GET /ponte/fila': semLeitura } });
    try {
      await esperar(10);
      p.doc.getElementById('aba-fila').click();
      await esperar(10);
      const fila = p.doc.getElementById('fila');
      assert.match(fila.querySelector('[data-papel="aviso-telefones"]').textContent, /Não consegui ler os telefones/);
      assert.match(fila.textContent, /telefone não lido agora/);
      fila.querySelector('[data-acao="comecar-ligar"]').click();
      await esperar();
      assert.doesNotMatch(fila.textContent, /Acabou a fila de hoje/);
      assert.match(fila.textContent, /2 pacientes ficaram sem o telefone lido/);
      assert.deepEqual(p.armazenado.ligacao.feitos, [], 'nada marcado como feito');
      assert.equal(p.atualizacoes.length, 0);
    } finally {
      p.w.close();
    }
  });
});

// ── 0.4.0: o guia "O que eu faço agora?" no painel de verdade ──

const CAMPO_ESPERA = { id: 2454156, nome: '⊘ Motivo da espera', tipo: 'lista', opcoes: [{ id: 1852306, valor: 'Viajando' }], obrigatorio: true, editavel: true, quem: 'sdr', valor: null };
const CAMPO_RETOMAR = { id: 2454154, nome: '◷ Retomar em', tipo: 'data', obrigatorio: true, editavel: true, quem: 'sdr', valor: null };
const CAMPO_OBS = { id: 2449924, nome: '✎ Observações', tipo: 'texto-longo', obrigatorio: false, editavel: true, quem: 'sdr', valor: null };
const guiaDe = (leadId, extra = {}) => ({
  leadId,
  nome: 'MARIA SOUZA 03/10/2026',
  funil: 'COMERCIAL',
  etapa: 'EM QUALIFICAÇÃO',
  statusId: 106809907,
  pipelineId: 13795975,
  noComercial: true,
  pendencia: null,
  unidade: null,
  faltam: [CAMPO_OBS],
  saidas: [{ statusId: 111237819, nome: 'EM ESPERA', rotulo: 'Quer, mas depois', faltam: [CAMPO_ESPERA, CAMPO_RETOMAR], sugere: [], bloqueio: null, mensagens: [], dicas: [] }],
  semSaidas: null,
  avisoDosRobos: 'Ao mover, os robôs desta etapa podem mandar mensagem ao paciente.',
  link: 'https://x.kommo.com/leads/detail/' + leadId,
  ...extra,
});

function digitarNoPainel(doc, id, valor) {
  const c = doc.querySelector(`.guia__entrada[data-campo="${id}"]`);
  assert.ok(c, `campo ${id}`);
  c.value = valor;
  c.dispatchEvent(new doc.defaultView.Event('input'));
  c.dispatchEvent(new doc.defaultView.Event('change'));
}

describe('painel — o guia "O que eu faço agora?" (0.4.0)', () => {
  const conversa = { aberta: true, tipo: 'individual', chave: 'c1', telefone: '5599900000043', nome: 'Maria Souza', fonteTelefone: 'jid', impressoes: [] };

  it('abre o guia do cartão, grava os campos e move a etapa só com confirmação; ao voltar, relê o cartão', async () => {
    let cartaoAtual = cartaoDe(123, 'Maria');
    const p = montar({
      conversa,
      rotas: {
        'POST /ponte/cartao': () => cartaoAtual,
        'GET /ponte/guia': guiaDe(123),
        'POST /ponte/campos': (c) => ({ leadId: c.leadId, gravados: [{ nome: '✎ Observações', texto: 'ligar à tarde' }], iguais: [], nota: true, guia: guiaDe(123, { faltam: [] }) }),
        'POST /ponte/mover': (c) => ({ leadId: c.leadId, de: 'EM QUALIFICAÇÃO', para: 'EM ESPERA', gravados: [{ nome: '⊘ Motivo da espera', texto: 'Viajando' }, { nome: '◷ Retomar em', texto: '20/10/2026' }], nota: true, guia: guiaDe(123, { etapa: 'EM ESPERA', statusId: 111237819, faltam: [], saidas: [] }) }),
      },
    });
    try {
      await esperar(600);
      const tela = p.doc.getElementById('conteudo');
      tela.querySelector('[data-acao="abrir-guia"]').click();
      await esperar();
      await esperar();
      const pedidoGuia = p.pedidos.find((x) => x.caminho === '/ponte/guia');
      assert.equal(pedidoGuia.busca, '?leadId=123');
      assert.equal(pedidoGuia.chave, 'k');
      assert.ok(tela.querySelector('[data-estado="guia"]'), 'o guia toma o lugar do cartão');

      // campos desta etapa: prévia → gravar, com quem
      digitarNoPainel(p.doc, CAMPO_OBS.id, 'ligar à tarde');
      tela.querySelector('[data-acao="revisar-campos"]').click();
      tela.querySelector('[data-passo="faltam"] [data-acao="confirmar"]').click();
      await esperar();
      await esperar();
      const gravou = p.pedidos.find((x) => x.caminho === '/ponte/campos');
      assert.deepEqual(gravou.corpo, { leadId: 123, campos: [{ id: CAMPO_OBS.id, valor: 'ligar à tarde' }], por: 'Ana' });
      assert.match(tela.querySelector('[data-papel="guia-ok"]').textContent, /Gravado no Kommo: ✎ Observações: ligar à tarde/);

      // mover: escolher a saída, preencher, revisar, confirmar
      tela.querySelector('[data-saida="111237819"]').click();
      digitarNoPainel(p.doc, CAMPO_ESPERA.id, '1852306');
      digitarNoPainel(p.doc, CAMPO_RETOMAR.id, '2026-10-20');
      tela.querySelector('[data-acao="revisar-mover"]').click();
      assert.equal(p.pedidos.filter((x) => x.caminho === '/ponte/mover').length, 0, 'revisar não move');
      tela.querySelector('[data-papel="area-mover"] [data-acao="confirmar"]').click();
      await esperar();
      await esperar();
      const moveu = p.pedidos.find((x) => x.caminho === '/ponte/mover');
      assert.deepEqual(moveu.corpo, {
        leadId: 123,
        de: 106809907,
        para: 111237819,
        campos: [{ id: CAMPO_ESPERA.id, valor: 1852306 }, { id: CAMPO_RETOMAR.id, valor: '2026-10-20' }],
        por: 'Ana',
        confirmado: true,
      });
      assert.match(tela.querySelector('[data-papel="guia-ok"]').textContent, /Movido para EM ESPERA\. Gravado junto: ⊘ Motivo da espera: Viajando; ◷ Retomar em: 20\/10\/2026/);

      // voltar ao cartão: o cartão mudou no Kommo, então é lido de novo (não sai do cache velho)
      const antes = p.pedidos.filter((x) => x.caminho === '/ponte/cartao').length;
      cartaoAtual = { ...cartaoDe(123, 'Maria'), cartao: { ...cartaoDe(123, 'Maria').cartao, etapa: 'EM ESPERA' } };
      tela.querySelector('[data-acao="voltar-guia"]').click();
      await esperar(600);
      assert.equal(p.pedidos.filter((x) => x.caminho === '/ponte/cartao').length, antes + 1);
      assert.match(tela.querySelector('[data-papel="etapa-atual"]').textContent, /EM ESPERA/);
    } finally {
      p.w.close();
    }
  });

  it('mensagem nova na MESMA conversa não fecha o guia; trocar de conversa fecha, e a resposta atrasada do guia não volta', async () => {
    let responderGuia;
    const p = montar({
      conversa,
      rotas: {
        'POST /ponte/cartao': (c) => (c.telefone === '5599900000044' ? cartaoDe(456, 'João') : cartaoDe(123, 'Maria')),
        'GET /ponte/guia': guiaDe(123),
      },
    });
    try {
      await esperar(600);
      const tela = p.doc.getElementById('conteudo');
      tela.querySelector('[data-acao="abrir-guia"]').click();
      await esperar();
      await esperar();
      digitarNoPainel(p.doc, CAMPO_OBS.id, 'rascunho');
      p.ouvintes.mensagem({ tipo: 'ponte:conversa', estado: { ...conversa, impressoes: ['h1'] } }, { tab: { id: 7 } });
      await esperar(600);
      assert.ok(tela.querySelector('[data-estado="guia"]'), 'o guia continua aberto');
      assert.equal(tela.querySelector(`.guia__entrada[data-campo="${CAMPO_OBS.id}"]`).value, 'rascunho');

      // a resposta do guia vai demorar; a atendente troca de conversa no meio
      p.w.fetch = ((orig) => (url, init) => (String(url).includes('/ponte/guia') ? new Promise((r) => { responderGuia = () => r({ ok: true, status: 200, json: () => Promise.resolve(guiaDe(123)) }); }) : orig(url, init)))(p.w.fetch);
      tela.querySelector('[data-acao="atualizar-guia"]').click();
      p.ouvintes.mensagem({ tipo: 'ponte:conversa', estado: { ...conversa, chave: 'c2', telefone: '5599900000044', nome: 'João Lima' } }, { tab: { id: 7 } });
      await esperar(600);
      responderGuia();
      await esperar();
      await esperar();
      assert.equal(tela.querySelector('[data-estado="guia"]'), null, 'o guia do paciente anterior não volta');
      assert.match(tela.textContent, /JOÃO SOUZA/);
    } finally {
      p.w.close();
    }
  });

  it('trocar de aba e voltar: o que foi digitado no guia volta junto quando ele é reaberto', async () => {
    const p = montar({ conversa, rotas: { 'POST /ponte/cartao': cartaoDe(123, 'Maria'), 'GET /ponte/guia': guiaDe(123) } });
    try {
      await esperar(600);
      const tela = p.doc.getElementById('conteudo');
      tela.querySelector('[data-acao="abrir-guia"]').click();
      await esperar();
      await esperar();
      digitarNoPainel(p.doc, CAMPO_OBS.id, 'ligar depois das 17h');
      // outra conversa e de volta para a mesma
      p.ouvintes.mensagem({ tipo: 'ponte:conversa', estado: { ...conversa, chave: 'c2', telefone: '5599900000044' } }, { tab: { id: 7 } });
      p.ouvintes.mensagem({ tipo: 'ponte:conversa', estado: conversa }, { tab: { id: 7 } });
      await esperar(600);
      tela.querySelector('[data-acao="abrir-guia"]').click();
      await esperar();
      await esperar();
      assert.equal(tela.querySelector(`.guia__entrada[data-campo="${CAMPO_OBS.id}"]`).value, 'ligar depois das 17h');
    } finally {
      p.w.close();
    }
  });
});

// ── 0.5.1: o que o vídeo de Petrópolis e Caxias (unidades sem a Sofia) mostrou errado ──

describe('painel — 0.5.1: nome da unidade, Sofia só com a IA e busca pelo telefone', () => {
  const comTelefone = { aberta: true, tipo: 'individual', chave: 'c1', telefone: '5599900000043', nome: 'Maria Souza', fonteTelefone: 'jid', impressoes: [] };
  const soNome = { aberta: true, tipo: 'individual', chave: 'c1', nome: 'Maria Souza', impressoes: [] };

  it('o nome da unidade vem do servidor, curto e com acento — nunca o do slug —, fica guardado, e a fila não o troca', async () => {
    const p = montar({ rotas: { 'GET /ping': { ok: true, unidade: 'Doutor Hérnia Açailândia' }, 'GET /ponte/fila': { ...FILA, unidade: 'Doutor Hérnia Açailândia' } } });
    try {
      await esperar(10);
      const topo = p.doc.getElementById('unidade');
      assert.equal(topo.textContent, 'Açailândia');
      assert.deepEqual(p.armazenado.unidadeVista, { slug: 'doutor-hernia-acailandia', nome: 'Açailândia' }, 'só o nome da unidade: nada de paciente');
      p.doc.getElementById('aba-fila').click();
      await esperar(10);
      assert.equal(topo.textContent, 'Açailândia', 'a fila manda o nome inteiro, e o topo continua igual');
    } finally {
      p.w.close();
    }
  });

  it('com o nome já guardado, o topo abre com ele e não pergunta de novo', async () => {
    const p = montar({ guardado: { unidadeVista: { slug: 'doutor-hernia-acailandia', nome: 'Açailândia' } } });
    try {
      await esperar(10);
      assert.equal(p.doc.getElementById('unidade').textContent, 'Açailândia');
      assert.equal(p.pedidos.filter((x) => x.caminho === '/ping').length, 0);
    } finally {
      p.w.close();
    }
  });

  it('nome guardado de OUTRA unidade não vale; e o do slug (sem acento) só quando o servidor não responde', async () => {
    const p = montar({ guardado: { unidadeVista: { slug: 'doutor-hernia-serra', nome: 'Serra' } } });
    try {
      await esperar(10);
      assert.equal(p.pedidos.filter((x) => x.caminho === '/ping').length, 1);
      assert.equal(p.doc.getElementById('unidade').textContent, 'Acailandia');
    } finally {
      p.w.close();
    }
  });

  it('unidade SEM a IA: nem o rodapé, nem o modo aprendiz, nem o cartão falam da Sofia', async () => {
    const p = montar({ conversa: comTelefone, rotas: { 'POST /ponte/cartao': { ...cartaoDe(123, 'Maria'), sofiaNaUnidade: false } } });
    try {
      await esperar(600);
      assert.equal(p.doc.getElementById('rodape-pausa').hidden, true);
      assert.doesNotMatch(p.doc.getElementById('aprendiz').textContent, /Sofia/);
      assert.doesNotMatch(p.doc.getElementById('conteudo').textContent, /Sofia/);
      assert.equal(p.armazenado.unidadeVista.sofia, false);
    } finally {
      p.w.close();
    }
  });

  it('antes de saber (nenhum cartão ainda): sem Sofia; unidade COM a IA: o rodapé e a dica da pausa aparecem', async () => {
    const p = montar({ conversa: comTelefone, rotas: { 'POST /ponte/cartao': { ...cartaoDe(123, 'Maria'), sofiaNaUnidade: true } } });
    try {
      await esperar(10);
      assert.equal(p.doc.getElementById('rodape-pausa').hidden, true, 'ainda não sei se a unidade tem a IA');
      await esperar(600);
      assert.equal(p.doc.getElementById('rodape-pausa').hidden, false);
      assert.match(p.doc.getElementById('aprendiz').textContent, /Pausar a Sofia/);
      assert.equal(p.armazenado.unidadeVista.sofia, true);
    } finally {
      p.w.close();
    }
  });

  it('a busca manual: nome vai como nome; telefone com DDD vai como telefone; e o cartão achado assim é relido pelo id', async () => {
    const p = montar({
      conversa: soNome,
      rotas: {
        'POST /ponte/cartao': (c) => (c.telefone === '24999991234' || c.lead === 123 ? cartaoDe(123, 'Maria') : { achado: false }),
        'GET /ponte/guia': guiaDe(123),
        'POST /ponte/campos': (c) => ({ leadId: c.leadId, gravados: [{ nome: '✎ Observações', texto: 'x' }], iguais: [], nota: true, guia: guiaDe(123, { faltam: [] }) }),
      },
    });
    const buscar = (texto) => {
      const tela = p.doc.getElementById('conteudo');
      tela.querySelector('.busca__campo').value = texto;
      tela.querySelector('form.busca').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    };
    const ultimaBusca = () => p.pedidos.filter((x) => x.caminho === '/ponte/cartao').pop().corpo;
    try {
      await esperar(600);
      buscar('Maria Souza');
      await esperar(10);
      assert.deepEqual(ultimaBusca(), { nome: 'Maria Souza', manual: true });
      // não achou: o número digitado volta na caixa (para corrigir, não redigitar)
      buscar('(24) 99999-0000');
      await esperar(10);
      assert.deepEqual(ultimaBusca(), { telefone: '24999990000' });
      assert.equal(p.doc.querySelector('#conteudo .busca__campo').value, '(24) 99999-0000');
      buscar('(24) 99999-1234');
      await esperar(10);
      assert.deepEqual(ultimaBusca(), { telefone: '24999991234' });
      const tela = p.doc.getElementById('conteudo');
      assert.match(tela.textContent, /MARIA SOUZA/);

      // gravou pelo guia e voltou: relê o MESMO cartão pelo id (a conversa só tem o nome, que não acha)
      tela.querySelector('[data-acao="abrir-guia"]').click();
      await esperar(10);
      digitarNoPainel(p.doc, CAMPO_OBS.id, 'x');
      tela.querySelector('[data-acao="revisar-campos"]').click();
      tela.querySelector('[data-passo="faltam"] [data-acao="confirmar"]').click();
      await esperar(10);
      tela.querySelector('[data-acao="voltar-guia"]').click();
      await esperar(10);
      assert.deepEqual(ultimaBusca(), { lead: 123 });
      assert.match(tela.textContent, /MARIA SOUZA/);
    } finally {
      p.w.close();
    }
  });

  it('a resposta que chega DEPOIS de trocar a unidade nas opções não vale para a nova (nem o nome, nem a Sofia)', async () => {
    const p = montar({ conversa: comTelefone });
    const pendentes = [];
    const orig = p.w.fetch;
    p.w.fetch = (url, init) => (String(url).includes('/ponte/cartao')
      ? new Promise((r) => pendentes.push(() => r({ ok: true, status: 200, json: () => Promise.resolve({ ...cartaoDe(123, 'Maria'), sofiaNaUnidade: true, unidadeDaConta: 'Açailândia' }) })))
      : orig(url, init));
    try {
      await esperar(600);
      assert.equal(pendentes.length, 1, 'o cartão da Açailândia está a caminho');
      // a atendente troca a unidade nas opções antes de ele chegar; a aba do WhatsApp demora a responder (a janela
      // entre a configuração nova e a conversa ser perguntada de novo)
      p.w.chrome.tabs.query = () => new Promise((r) => setTimeout(() => r([{ id: 7 }]), 80));
      p.armazenado.slug = 'doutor-hernia-petropolis';
      p.ouvintes.storage({ slug: { newValue: 'doutor-hernia-petropolis' } }, 'local');
      await esperar(10);
      pendentes[0]();
      await esperar(10);
      assert.notEqual(p.doc.getElementById('unidade').textContent, 'Açailândia');
      assert.equal(p.doc.getElementById('rodape-pausa').hidden, true);
      const vista = p.armazenado.unidadeVista;
      assert.ok(!vista || vista.slug !== 'doutor-hernia-petropolis' || (vista.nome !== 'Açailândia' && vista.sofia !== true), JSON.stringify(vista));
    } finally {
      p.w.close();
    }
  });
});

// ── 0.5.1: Observações — vira uma nota comum no cartão (nunca no WhatsApp) ──

describe('painel — 0.5.1: Observações', () => {
  const conversa = { aberta: true, tipo: 'individual', chave: 'c1', telefone: '5599900000043', nome: 'Maria Souza', fonteTelefone: 'jid', impressoes: [] };

  function escrever(p, texto) {
    const campo = p.doc.querySelector('#conteudo [data-papel="observacao"]');
    assert.ok(campo, 'a caixa Observações está no cartão');
    campo.value = texto;
    campo.dispatchEvent(new p.w.Event('input'));
    return campo;
  }

  it('escreve, revisa a prévia, confirma: vai para POST /ponte/nota com quem escreveu; "Salvo no cartão." e a caixa limpa', async () => {
    const p = montar({ conversa, rotas: { 'POST /ponte/cartao': cartaoDe(123, 'Maria'), 'POST /ponte/nota': (c) => ({ ok: true, leadId: c.leadId, notaId: 900, repetido: false }) } });
    try {
      await esperar(600);
      const tela = p.doc.getElementById('conteudo');
      const campo = escrever(p, 'Prefere ligação depois das 17h.');
      tela.querySelector('[data-acao="salvar-observacao"]').click();
      assert.equal(p.pedidos.filter((x) => x.caminho === '/ponte/nota').length, 0, 'a prévia vem antes: nada gravado ainda');
      const previa = tela.querySelector('[data-bloco="observacao"] [data-papel="previa"]');
      assert.match(previa.textContent, /Observação pela Ponte · Ana · \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:/);
      assert.match(previa.textContent, /Prefere ligação depois das 17h\./);
      previa.querySelector('[data-acao="confirmar"]').click();
      await esperar(10);
      const gravou = p.pedidos.filter((x) => x.caminho === '/ponte/nota');
      assert.equal(gravou.length, 1);
      assert.deepEqual(gravou[0].corpo, { leadId: 123, texto: 'Prefere ligação depois das 17h.', por: 'Ana' });
      assert.equal(gravou[0].chave, 'k');
      assert.match(tela.querySelector('[data-papel="observacao-ok"]').textContent, /Salvo no cartão/);
      assert.equal(campo.value, '');
      // nunca escreve no WhatsApp: nenhuma mensagem para a aba além de "qual conversa", nenhuma troca de URL
      assert.deepEqual(p.mensagens.filter((m) => m.tipo !== 'ponte:qual-conversa'), []);
      assert.deepEqual(p.atualizacoes, []);
    } finally {
      p.w.close();
    }
  });

  it('servidor de antes da 0.5.1 (a rota não existe: 401 do login, ou 404 sem a mensagem da Ponte): "Disponível depois da atualização do servidor."', async () => {
    for (const semRota of [{ __status: 401, corpo: { error: 'unauthenticated' } }, { __status: 404 }]) {
      const p = montar({ conversa, rotas: { 'POST /ponte/cartao': cartaoDe(123, 'Maria'), 'POST /ponte/nota': semRota } });
      try {
        await esperar(600);
        const tela = p.doc.getElementById('conteudo');
        const campo = escrever(p, 'Prefere tarde.');
        tela.querySelector('[data-acao="salvar-observacao"]').click();
        tela.querySelector('[data-bloco="observacao"] [data-acao="confirmar"]').click();
        await esperar(10);
        assert.equal(tela.querySelector('[data-papel="msg-observacao"]').textContent, 'Disponível depois da atualização do servidor.', String(semRota.__status));
        assert.equal(campo.value, 'Prefere tarde.', 'o texto não se perde');
      } finally {
        p.w.close();
      }
    }
  });

  it('um 401 que NÃO é o do login (um proxy, por exemplo) mostra o erro de verdade, não "atualização do servidor"', async () => {
    const p = montar({ conversa, rotas: { 'POST /ponte/cartao': cartaoDe(123, 'Maria'), 'POST /ponte/nota': { __status: 401, corpo: { error: 'token do proxy expirou' } } } });
    try {
      await esperar(600);
      const tela = p.doc.getElementById('conteudo');
      escrever(p, 'x');
      tela.querySelector('[data-acao="salvar-observacao"]').click();
      tela.querySelector('[data-bloco="observacao"] [data-acao="confirmar"]').click();
      await esperar(10);
      assert.equal(tela.querySelector('[data-papel="msg-observacao"]').textContent, 'Token do proxy expirou.');
    } finally {
      p.w.close();
    }
  });

  it('erro do servidor com mensagem da Ponte: aparece legível (ex.: cartão de outra conta)', async () => {
    const p = montar({ conversa, rotas: { 'POST /ponte/cartao': cartaoDe(123, 'Maria'), 'POST /ponte/nota': { __status: 404, corpo: { ok: false, error: 'cartão não encontrado no Kommo desta unidade' } } } });
    try {
      await esperar(600);
      const tela = p.doc.getElementById('conteudo');
      escrever(p, 'x');
      tela.querySelector('[data-acao="salvar-observacao"]').click();
      tela.querySelector('[data-bloco="observacao"] [data-acao="confirmar"]').click();
      await esperar(10);
      assert.equal(tela.querySelector('[data-papel="msg-observacao"]').textContent, 'Cartão não encontrado no Kommo desta unidade.');
    } finally {
      p.w.close();
    }
  });

  it('o que foi digitado volta depois de trocar de conversa e voltar (só na memória do painel, nunca no storage)', async () => {
    const p = montar({
      conversa,
      rotas: { 'POST /ponte/cartao': (c) => (c.telefone === '5599900000044' ? cartaoDe(456, 'João') : cartaoDe(123, 'Maria')) },
    });
    try {
      await esperar(600);
      escrever(p, 'rascunho da observação');
      p.ouvintes.mensagem({ tipo: 'ponte:conversa', estado: { ...conversa, chave: 'c2', telefone: '5599900000044' } }, { tab: { id: 7 } });
      await esperar(600);
      assert.equal(p.doc.querySelector('#conteudo [data-papel="observacao"]').value, '', 'outro paciente: caixa vazia');
      p.ouvintes.mensagem({ tipo: 'ponte:conversa', estado: conversa }, { tab: { id: 7 } });
      await esperar(600);
      assert.equal(p.doc.querySelector('#conteudo [data-papel="observacao"]').value, 'rascunho da observação');
      assert.doesNotMatch(JSON.stringify(p.armazenado), /rascunho da observação/);
    } finally {
      p.w.close();
    }
  });
});

