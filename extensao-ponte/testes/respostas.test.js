// Fase 3 — respostas prontas para COPIAR: o nome entra no lugar do marcador, a busca, e a aba (lista, "Copiar",
// lacuna, anexo e a conta sem nenhuma). O servidor confere o mesmo respostas.js em
// backend/src/lib/ponte-respostas.test.ts.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const R = require('../respostas.js');
const D = require('../desenho.js');

const novoDoc = () => new JSDOM('<main></main>').window.document;
const tique = () => new Promise((r) => setTimeout(r, 0));

const LISTA = {
  respostas: [
    { id: 1, nome: '⚡ Consulta dados pix', texto: 'Olá, {{contact.name}}! O Pix é a chave do CNPJ. Valor: [¤ Valor da Consulta].', temAnexo: false },
    { id: 2, nome: 'Endereço da clínica', texto: 'Oi {{contact.name}}, estamos na Rua das Flores, 100.', temAnexo: true },
    { id: 3, nome: 'Bom dia', texto: 'Bom dia! Como posso ajudar?', temAnexo: false },
  ],
  ondeCadastrar: 'No Kommo: Configurações › Modelos › Modelos gerais › Adicionar um novo modelo (só administrador).',
};

describe('respostas — as regras (respostas.js)', () => {
  it('troca os marcadores de nome pelo primeiro nome', () => {
    assert.equal(R.preencherNome('Olá, {{contact.name}}!', 'Maria'), 'Olá, Maria!');
    assert.equal(R.preencherNome('Oi {{ contact.first_name }}', 'Maria'), 'Oi Maria');
    assert.equal(R.preencherNome('Oi [Nome do contato], [nome], {nome} e {{nome}}', 'Ana'), 'Oi Ana, Ana, Ana e Ana');
  });

  it('sem nome conhecido, deixa "[nome]" para completar (nunca "Olá, !")', () => {
    assert.equal(R.preencherNome('Olá, {{contact.name}}!', null), 'Olá, [nome]!');
    assert.equal(R.preencherNome('Olá, {{contact.name}}!', '  '), 'Olá, [nome]!');
    assert.ok(R.temLacuna(R.preencherNome('Olá, {{contact.name}}!', null)));
  });

  it('não mexe no resto do texto', () => {
    assert.equal(R.preencherNome('Valor: [¤ Valor da Consulta]', 'Maria'), 'Valor: [¤ Valor da Consulta]');
    assert.equal(R.temLacuna('Bom dia!'), false);
    assert.equal(R.temLacuna('Valor: [¤ Valor da Consulta]'), true);
  });

  it('a busca olha nome e texto, sem acento, com todas as palavras', () => {
    assert.deepEqual(R.filtrar(LISTA.respostas, 'pix').map((r) => r.id), [1]);
    assert.deepEqual(R.filtrar(LISTA.respostas, 'endereco').map((r) => r.id), [2]);
    assert.deepEqual(R.filtrar(LISTA.respostas, 'rua flores').map((r) => r.id), [2]);
    assert.deepEqual(R.filtrar(LISTA.respostas, '').map((r) => r.id), [1, 2, 3]);
  });
});

describe('respostas — a aba', () => {
  it('lista com o nome do paciente no lugar do marcador; "Copiar" copia o texto já com o nome', async () => {
    const doc = novoDoc();
    const copiados = [];
    const n = D.respostas(doc, LISTA, { copiar: (t) => { copiados.push(t); return Promise.resolve(); } }, 'Maria', '');
    assert.match(n.querySelector('[data-papel="para-quem"]').textContent, /"Maria"/);
    const item = n.querySelector('[data-resposta="1"]');
    assert.match(item.textContent, /Olá, Maria! O Pix/);
    item.querySelector('[data-acao="copiar-resposta"]').click();
    await tique();
    assert.deepEqual(copiados, ['Olá, Maria! O Pix é a chave do CNPJ. Valor: [¤ Valor da Consulta].']);
    assert.equal(item.querySelector('[data-acao="copiar-resposta"]').textContent, 'Copiado');
  });

  it('lacuna entre colchetes e anexo ganham aviso', () => {
    const doc = novoDoc();
    const n = D.respostas(doc, LISTA, { copiar: () => Promise.resolve() }, 'Maria', '');
    assert.match(n.querySelector('[data-resposta="1"]').textContent, /Complete o que está entre colchetes/);
    assert.match(n.querySelector('[data-resposta="2"]').textContent, /copia só o texto/);
    assert.doesNotMatch(n.querySelector('[data-resposta="3"]').textContent, /colchetes|anexo/);
  });

  it('sem paciente na tela: avisa e deixa [nome]', () => {
    const doc = novoDoc();
    const n = D.respostas(doc, LISTA, { copiar: () => Promise.resolve() }, null, '');
    assert.match(n.querySelector('[data-papel="para-quem"]').textContent, /Abra a conversa do paciente/);
    assert.match(n.querySelector('[data-resposta="2"]').textContent, /Oi \[nome\], estamos/);
  });

  it('a busca filtra a lista e avisa o painel (para não perder ao redesenhar)', () => {
    const doc = novoDoc();
    const buscas = [];
    const n = D.respostas(doc, LISTA, { copiar: () => Promise.resolve(), aoBuscar: (t) => buscas.push(t) }, 'Maria', '');
    const campo = n.querySelector('input[type="search"]');
    campo.value = 'bom dia';
    campo.dispatchEvent(new doc.defaultView.Event('input'));
    assert.deepEqual([...n.querySelectorAll('[data-resposta]')].map((li) => li.getAttribute('data-resposta')), ['3']);
    assert.deepEqual(buscas, ['bom dia']);
    const outra = D.respostas(doc, LISTA, { copiar: () => Promise.resolve() }, 'Maria', 'endereco');
    assert.deepEqual([...outra.querySelectorAll('[data-resposta]')].map((li) => li.getAttribute('data-resposta')), ['2']);
  });

  it('conta sem nenhuma: "Nenhuma resposta pronta cadastrada no Kommo" e onde cadastrar', () => {
    const doc = novoDoc();
    const n = D.respostas(doc, { respostas: [], ondeCadastrar: LISTA.ondeCadastrar }, {}, 'Maria', '');
    assert.match(n.textContent, /Nenhuma resposta pronta cadastrada no Kommo/);
    assert.match(n.textContent, /Configurações › Modelos › Modelos gerais/);
  });

  it('texto do Kommo entra como texto, nunca como HTML', () => {
    const doc = novoDoc();
    const n = D.respostas(doc, { respostas: [{ id: 9, nome: '<b>x</b>', texto: '<img src=x onerror=alert(1)>', temAnexo: false }] }, { copiar: () => Promise.resolve() }, 'Maria', '');
    assert.equal(n.querySelector('img'), null);
    assert.equal(n.querySelector('b'), null);
  });

  it('a aba só copia: nada de colar, digitar ou enviar (busca no código)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const arq of ['respostas.js', 'desenho.js', 'painel.js']) {
      const codigo = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
      assert.ok(!/execCommand\(\s*['"](paste|insertText)/.test(codigo), `${arq} não pode colar`);
      assert.ok(!/chrome\.(scripting|tabs\.executeScript)/.test(codigo), `${arq} não pode injetar script na página`);
    }
  });
});

describe('respostas sugeridas para a etapa (0.5.0)', () => {
  const R2 = require('../respostas.js');
  const L = [
    { id: 1, nome: 'consulta_confirmar_presenca' },
    { id: 2, nome: 'Petropolis_Consulta_Endereco' },
    { id: 3, nome: 'caxias_consulta_endereco' },
    { id: 4, nome: 'espera_retomar' },
    { id: 5, nome: '⚡ Lead boas-vindas' },
    { id: 6, nome: 'primeiro_contato' },
    { id: 7, nome: 'consultas antigas' },
    { id: 8, nome: 'Bom dia' },
  ];
  const ids = (l) => l.map((r) => r.id);

  it('casa pelo começo do nome do modelo, sem acento nem caixa, depois do prefixo da unidade', () => {
    assert.deepEqual(ids(R2.sugeridas(L, 'agendado', 'Petrópolis')), [1, 2]);
    assert.deepEqual(ids(R2.sugeridas(L, 'agendado', 'Caxias')), [1, 3]);
    assert.deepEqual(ids(R2.sugeridas(L, 'espera', null)), [4]);
    assert.deepEqual(ids(R2.sugeridas(L, 'qualificacao', null)), [5, 6]);
    assert.deepEqual(R2.sugeridas(L, null, null), []);
    assert.ok(!ids(R2.sugeridas(L, 'agendado', null)).includes(7), '"consultas" não é "consulta_"');
  });

  it('modelo de unidade: só no cartão da MESMA unidade; sem unidade conhecida, fica na lista e fora das sugeridas', () => {
    assert.equal(R2.unidadeDoModelo('caxias_consulta_endereco'), 'caxias');
    assert.equal(R2.unidadeDoModelo('consulta_caxias'), null, 'o prefixo é que manda');
    assert.deepEqual(R2.daUnidade(L, 'Petrópolis'), { lista: L.filter((r) => r.id !== 3), escondidas: 1 });
    assert.deepEqual(R2.daUnidade(L, null), { lista: L, escondidas: 0 });
    assert.deepEqual(ids(R2.sugeridas(L, 'agendado', null)), [1]);
    assert.equal(R2.unidadeDoModelo('serra_x', ['Serra']), 'serra', 'a conta pode mandar as suas unidades');
  });
});
