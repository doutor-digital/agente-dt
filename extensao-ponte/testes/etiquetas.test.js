// Fase 3 — as etiquetas do cartão: a regra do ▶, a busca entre as etiquetas da conta, e o bloco do cartão (chips
// com ✕, "+ etiqueta", a confirmação da ▶ e o erro). O servidor confere a mesma regra do ▶ em
// backend/src/lib/ponte-etiquetas.test.ts, carregando este etiquetas.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const E = require('../etiquetas.js');
const D = require('../desenho.js');

const novoDoc = () => new JSDOM('<main></main>').window.document;
const tique = () => new Promise((r) => setTimeout(r, 0));

const DA_CONTA = [
  { nome: 'LOMBAR', robo: false },
  { nome: 'CERVICAL', robo: false },
  { nome: 'META', robo: false },
  { nome: '▶ Retomada', robo: true },
  { nome: '▶ Confirmação', robo: true },
  { nome: 'Retomada manual', robo: false },
  // sem ▶, mas dispara bot que manda modelo (o servidor diz `robo: true`)
  { nome: 'Aderência meio', robo: true },
];

const CARTAO = {
  achado: true,
  como: 'telefone',
  cartao: {
    id: 123,
    nome: 'MARIA SOUZA 03/10/2026',
    link: 'https://x.kommo.com/leads/detail/123',
    funil: 'COMERCIAL',
    etapa: 'EM ESPERA',
    fechado: false,
    etiquetas: ['LOMBAR', '▶ Confirmação'],
    sofia: { pausada: false, por: null, ate: null },
  },
};

describe('etiquetas — as regras (etiquetas.js)', () => {
  it('▶ é etiqueta de robô (e o ►, que parece igual); o resto não', () => {
    assert.equal(E.ehDeRobo('▶ Retomada'), true);
    assert.equal(E.ehDeRobo('  ▶Retomada'), true);
    assert.equal(E.ehDeRobo('► Retomada'), true);
    assert.equal(E.ehDeRobo('Retomada ▶'), false);
    assert.equal(E.ehDeRobo('LOMBAR'), false);
    assert.equal(E.ehDeRobo(null), false);
  });

  it('a lista da unidade (vinda do servidor) também é de robô, sem diferença de maiúscula ou acento', () => {
    assert.equal(E.ehDeRobo('Aderência meio', ['Aderência meio']), true);
    assert.equal(E.ehDeRobo('ADERENCIA MEIO', ['Aderência meio']), true);
    assert.equal(E.ehDeRobo('Aderência meio'), false, 'sem a lista, só o ▶ vale aqui — por isso o painel usa o que o servidor diz');
  });

  it('a busca acha sem acento e sem maiúscula, e o que começa com o texto vem primeiro', () => {
    assert.deepEqual(E.filtrar(DA_CONTA, 'retomada', [], 10).map((e) => e.nome), ['▶ Retomada', 'Retomada manual']);
    assert.deepEqual(E.filtrar(DA_CONTA, 'confirmacao', [], 10).map((e) => e.nome), ['▶ Confirmação']);
    assert.deepEqual(E.filtrar(DA_CONTA, 'manual', [], 10).map((e) => e.nome), ['Retomada manual']);
  });

  it('as que o cartão já tem saem da lista; ▶ Retomada e "Retomada" são etiquetas diferentes', () => {
    const nomes = E.filtrar(DA_CONTA, '', ['LOMBAR', '▶ Confirmação'], 30).map((e) => e.nome);
    assert.ok(!nomes.includes('LOMBAR'));
    assert.ok(!nomes.includes('▶ Confirmação'));
    assert.ok(nomes.includes('▶ Retomada'));
    assert.deepEqual(E.filtrar([{ nome: '▶ Retomada' }, { nome: 'Retomada' }], '', ['Retomada'], 9).map((e) => e.nome), ['▶ Retomada']);
  });

  it('corta no máximo pedido', () => {
    assert.equal(E.filtrar(DA_CONTA, '', [], 2).length, 2);
  });
});

describe('etiquetas — o bloco do cartão', () => {
  function acoesFalsas(registro, opcoes = {}) {
    return {
      listarEtiquetas: () => { registro.push(['listar']); return opcoes.listaFalha ? Promise.reject(new Error('Não consegui ler as etiquetas do Kommo agora.')) : Promise.resolve(DA_CONTA); },
      porEtiqueta: (id, nome, confirmado) => { registro.push(['por', id, nome, confirmado]); return opcoes.porFalha ? Promise.reject(new Error(opcoes.porFalha)) : Promise.resolve(); },
      tirarEtiqueta: (id, nome) => { registro.push(['tirar', id, nome]); return Promise.resolve(); },
    };
  }

  it('chips com ✕; a ▶ aparece marcada como robô', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, CARTAO, acoesFalsas([]));
    const chips = [...n.querySelectorAll('[data-bloco="etiquetas"] .etiqueta')];
    assert.deepEqual(chips.map((c) => c.getAttribute('data-etiqueta')), ['LOMBAR', '▶ Confirmação']);
    assert.ok(chips[1].classList.contains('etiqueta--robo'));
    assert.equal(chips[0].querySelector('[data-acao="tirar-etiqueta"]').getAttribute('aria-label'), 'Tirar a etiqueta LOMBAR');
  });

  it('tirar não pede confirmação (nem da ▶): chama com o cartão e o nome', async () => {
    const doc = novoDoc();
    const reg = [];
    const n = D.cartao(doc, CARTAO, acoesFalsas(reg));
    n.querySelector('[data-etiqueta="▶ Confirmação"] [data-acao="tirar-etiqueta"]').click();
    await tique();
    assert.deepEqual(reg, [['tirar', 123, '▶ Confirmação']]);
    assert.equal(n.querySelector('[data-papel="confirmar-etiqueta"]').hidden, true);
  });

  it('"+ etiqueta" lê a lista da conta, sem as que o cartão já tem, e a busca filtra', async () => {
    const doc = novoDoc();
    const reg = [];
    const n = D.cartao(doc, CARTAO, acoesFalsas(reg));
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    const opcoes = () => [...n.querySelectorAll('[data-papel="opcoes-etiqueta"] [data-etiqueta]')].map((b) => b.getAttribute('data-etiqueta'));
    assert.deepEqual(reg, [['listar']]);
    assert.ok(!opcoes().includes('LOMBAR'));
    assert.ok(opcoes().includes('▶ Retomada'));
    const busca = n.querySelector('[data-papel="escolher-etiqueta"] input');
    busca.value = 'cerv';
    busca.dispatchEvent(new doc.defaultView.Event('input'));
    assert.deepEqual(opcoes(), ['CERVICAL']);
    busca.value = 'nao existe';
    busca.dispatchEvent(new doc.defaultView.Event('input'));
    assert.match(n.querySelector('[data-papel="opcoes-etiqueta"]').textContent, /não cria etiqueta nova/);
  });

  it('etiqueta comum: um clique põe (sem confirmação)', async () => {
    const doc = novoDoc();
    const reg = [];
    const n = D.cartao(doc, CARTAO, acoesFalsas(reg));
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    n.querySelector('[data-papel="opcoes-etiqueta"] [data-etiqueta="CERVICAL"]').click();
    await tique();
    assert.deepEqual(reg.slice(1), [['por', 123, 'CERVICAL', false]]);
  });

  it('etiqueta ▶: pergunta antes, com o texto combinado; só põe depois de "Pôr mesmo assim"', async () => {
    const doc = novoDoc();
    const reg = [];
    const n = D.cartao(doc, CARTAO, acoesFalsas(reg));
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    n.querySelector('[data-papel="opcoes-etiqueta"] [data-etiqueta="▶ Retomada"]').click();
    await tique();
    assert.deepEqual(reg.slice(1), [], 'o clique na ▶ NÃO põe');
    const caixa = n.querySelector('[data-papel="confirmar-etiqueta"]');
    assert.equal(caixa.hidden, false);
    assert.match(caixa.textContent, /Esta etiqueta faz o robô mandar uma mensagem para o paciente\. Pôr mesmo assim\?/);
    assert.match(caixa.textContent, /▶ Retomada/);
    caixa.querySelector('[data-acao="confirmar-robo"]').click();
    await tique();
    assert.deepEqual(reg.slice(1), [['por', 123, '▶ Retomada', true]]);
  });

  it('"Aderência meio" (sem ▶, mas o servidor diz que é de robô): também pergunta antes de pôr', async () => {
    const doc = novoDoc();
    const reg = [];
    const n = D.cartao(doc, CARTAO, acoesFalsas(reg));
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    const opcao = n.querySelector('[data-papel="opcoes-etiqueta"] [data-etiqueta="Aderência meio"]');
    assert.match(opcao.textContent, /manda mensagem/);
    opcao.click();
    await tique();
    assert.deepEqual(reg.slice(1), []);
    assert.equal(n.querySelector('[data-papel="confirmar-etiqueta"]').hidden, false);
    n.querySelector('[data-acao="confirmar-robo"]').click();
    await tique();
    assert.deepEqual(reg.slice(1), [['por', 123, 'Aderência meio', true]]);
  });

  it('o servidor recusou pedindo confirmação (robô que o painel não sabia): o painel pergunta e manda de novo confirmado', async () => {
    const doc = novoDoc();
    const reg = [];
    const acoes = {
      listarEtiquetas: () => Promise.resolve([{ nome: 'Lembrete novo', robo: false }]),
      porEtiqueta: (id, nome, confirmado) => {
        reg.push([id, nome, confirmado]);
        if (confirmado) return Promise.resolve();
        const e = new Error('Esta etiqueta faz o robô mandar uma mensagem para o paciente: confirme antes.');
        e.precisaConfirmar = true;
        return Promise.reject(e);
      },
      tirarEtiqueta: () => Promise.resolve(),
    };
    const n = D.cartao(doc, CARTAO, acoes);
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    n.querySelector('[data-papel="opcoes-etiqueta"] [data-etiqueta="Lembrete novo"]').click();
    await tique();
    await tique();
    assert.equal(n.querySelector('[data-papel="confirmar-etiqueta"]').hidden, false);
    assert.equal(n.querySelector('[data-papel="msg-etiqueta"]').textContent, '');
    n.querySelector('[data-acao="confirmar-robo"]').click();
    await tique();
    assert.deepEqual(reg, [[123, 'Lembrete novo', false], [123, 'Lembrete novo', true]]);
  });

  it('chip de robô no cartão segue o servidor (`etiquetasRobo`)', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(CARTAO));
    r.cartao.etiquetas = ['Aderência meio', 'LOMBAR'];
    r.cartao.etiquetasRobo = ['Aderência meio'];
    const chips = [...D.cartao(doc, r, acoesFalsas([])).querySelectorAll('[data-bloco="etiquetas"] .etiqueta')];
    assert.deepEqual(chips.map((c) => c.classList.contains('etiqueta--robo')), [true, false]);
  });

  it('etiqueta ▶: "Cancelar" não põe nada e volta para a lista', async () => {
    const doc = novoDoc();
    const reg = [];
    const n = D.cartao(doc, CARTAO, acoesFalsas(reg));
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    n.querySelector('[data-papel="opcoes-etiqueta"] [data-etiqueta="▶ Retomada"]').click();
    n.querySelector('[data-acao="cancelar-robo"]').click();
    await tique();
    assert.deepEqual(reg.slice(1), []);
    assert.equal(n.querySelector('[data-papel="confirmar-etiqueta"]').hidden, true);
    assert.equal(n.querySelector('[data-papel="opcoes-etiqueta"]').hidden, false);
  });

  it('erro do servidor aparece no bloco', async () => {
    const doc = novoDoc();
    const n = D.cartao(doc, CARTAO, acoesFalsas([], { porFalha: 'Essa etiqueta não existe no Kommo.' }));
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    n.querySelector('[data-papel="opcoes-etiqueta"] [data-etiqueta="META"]').click();
    await tique();
    await tique();
    assert.match(n.querySelector('[data-papel="msg-etiqueta"]').textContent, /não existe no Kommo/);
  });

  it('lista da conta que não veio: o erro aparece', async () => {
    const doc = novoDoc();
    const n = D.cartao(doc, CARTAO, acoesFalsas([], { listaFalha: true }));
    n.querySelector('[data-acao="abrir-etiquetas"]').click();
    await tique();
    await tique();
    assert.match(n.querySelector('[data-papel="msg-etiqueta"]').textContent, /Não consegui ler as etiquetas/);
  });

  it('nome de etiqueta entra como texto, nunca como HTML', async () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(CARTAO));
    r.cartao.etiquetas = ['<img src=x onerror=alert(1)>'];
    const n = D.cartao(doc, r, acoesFalsas([]));
    assert.equal(n.querySelector('img'), null);
    assert.match(n.querySelector('[data-bloco="etiquetas"]').textContent, /<img src=x/);
  });
});
