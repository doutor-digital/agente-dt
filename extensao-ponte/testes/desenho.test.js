// O desenho do painel a partir de respostas do servidor (formato de ponte.controller.ts).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const D = require('../desenho.js');
const A = require('../aprendiz.js');

const novoDoc = () => new JSDOM('<main></main>').window.document;

const ACHADO = {
  achado: true,
  como: 'telefone',
  incompleto: false,
  cartao: {
    id: 123,
    nome: 'MARIA SOUZA 03/10/2026',
    link: 'https://doutorherniaacailandia.kommo.com/leads/detail/123',
    funil: 'COMERCIAL',
    etapa: 'AGENDADO',
    fechado: false,
    barra: {
      funil: 'COMERCIAL',
      noFunil: true,
      etapas: [
        { id: 1, nome: 'EM QUALIFICAÇÃO', atual: false },
        { id: 2, nome: 'EM ESPERA', atual: false },
        { id: 3, nome: 'AGENDADO', atual: true },
        { id: 142, nome: 'GANHO / CONCLUIDO', atual: false },
        { id: 143, nome: 'PERDIDO', atual: false },
      ],
    },
    responsavel: 'Giulia',
    etiquetas: ['LOMBAR', 'META'],
    sofia: { pausada: true, por: 'caixinha', ate: null },
    anuncio: { titulo: 'Dor ciática tem tratamento sem cirurgia', anuncio: null, campanha: 'Ciática out', plataforma: 'Instagram', origem: 'Meta' },
    atualizadoEm: '2026-10-13T13:00:00.000Z',
  },
  outrosCartoes: [{ id: 99, nome: 'MARIA SOUZA 02/05/2026', funil: 'COMERCIAL', etapa: 'PERDIDO', fechado: true }],
  franquia: {
    unidade: 'Açailândia',
    franquia: true,
    paciente: { idClient: 1, nome: 'Maria Souza', whatsapp: '…1043', origem: 'vinculo' },
    agenda: { proximaConsulta: { dia: '15/10', hora: '08:00', status: 'AGENDADO', fisioterapeuta: 'Dra. Ana' }, ultimaConsulta: null, proximaSessao: null },
    tratamento: null,
  },
};

describe('desenho do painel', () => {
  it('cartão achado: nome, chip de "como achei", barrinha com a etapa atual, Sofia, franquia e link', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, ACHADO, {});
    const t = n.textContent;
    assert.equal(n.getAttribute('data-estado'), 'achado');
    assert.match(t, /MARIA SOUZA 03\/10\/2026/);
    assert.match(t, /COMERCIAL › AGENDADO/);
    assert.equal(n.querySelector('[data-como]').textContent, 'achei pelo telefone');
    const etapas = [...n.querySelectorAll('.barra__etapa')];
    assert.equal(etapas.length, 5);
    assert.ok(etapas[2].classList.contains('barra__etapa--atual'));
    assert.ok(etapas[0].classList.contains('barra__etapa--feita'));
    assert.match(t, /Giulia/);
    assert.match(t, /pausada neste cartão/);
    assert.match(t, /Consulta marcada15\/10 às 08:00 · AGENDADO · Dra\. Ana/);
    assert.match(t, /Dor ciática tem tratamento sem cirurgia/);
    const link = n.querySelector('a.botao--primario');
    assert.equal(link.href, 'https://doutorherniaacailandia.kommo.com/leads/detail/123');
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener/);
  });

  it('nome achado só pelo nome vem marcado como "confira"; outro cartão é clicável', () => {
    const doc = novoDoc();
    const escolhidos = [];
    const n = D.cartao(doc, { ...ACHADO, como: 'nome' }, { escolher: (id) => escolhidos.push(id) });
    assert.match(n.querySelector('[data-como]').className, /chip--fraco/);
    n.querySelector('[data-lead="99"]').click();
    assert.deepEqual(escolhidos, [99]);
  });

  it('cartão fora do funil COMERCIAL avisa; franquia sem consulta aparece como alerta', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(ACHADO));
    r.cartao.barra.noFunil = false;
    r.cartao.barra.etapas.forEach((e) => { e.atual = false; });
    r.franquia.agenda.proximaConsulta = null;
    const t = D.cartao(doc, r, {}).textContent;
    assert.match(t, /não está no funil COMERCIAL/);
    assert.match(t, /Consulta marcadanenhuma/);
  });

  it('barrinha: cartão PERDIDO não pinta nada como feito, e GANHO nunca aparece como "feito"', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(ACHADO));
    r.cartao.barra.etapas.forEach((e) => { e.atual = e.id === 143; });
    let etapas = [...D.cartao(doc, r, {}).querySelectorAll('.barra__etapa')];
    assert.equal(etapas.filter((e) => e.classList.contains('barra__etapa--feita')).length, 0);
    assert.ok(etapas[4].classList.contains('barra__etapa--atual'));
    r.cartao.barra.etapas.forEach((e) => { e.atual = e.id === 142; }); // GANHO: o caminho todo foi feito
    etapas = [...D.cartao(doc, r, {}).querySelectorAll('.barra__etapa')];
    assert.deepEqual(etapas.map((e) => e.classList.contains('barra__etapa--feita')), [true, true, true, false, false]);
  });

  it('Sofia quieta por horário aparece como tal', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(ACHADO));
    r.cartao.sofia = { pausada: true, por: 'horario', ate: null };
    assert.match(D.cartao(doc, r, {}).textContent, /fora do horário em que ela atende/);
  });

  it('número dividido pela família: a lista diz que é o mesmo número', () => {
    const doc = novoDoc();
    const n = D.candidatos(doc, { achado: false, como: 'telefone', candidatos: [{ id: 1, nome: 'Maria' }, { id: 2, nome: 'João' }] }, {});
    assert.match(n.textContent, /Este número tem mais de um contato no Kommo/);
  });

  it('candidatos: um botão por cartão, e o clique escolhe aquele cartão', () => {
    const doc = novoDoc();
    const escolhidos = [];
    const r = { achado: false, como: 'nome', candidatos: [{ id: 1, nome: 'Maria A', funil: 'COMERCIAL', etapa: 'EM ESPERA' }, { id: 2, nome: 'Maria B', funil: 'TRATAMENTO', etapa: 'EM TRATAMENTO' }] };
    const n = D.candidatos(doc, r, { escolher: (id) => escolhidos.push(id) });
    assert.equal(n.querySelectorAll('.lista__botao').length, 2);
    n.querySelector('[data-lead="2"]').click();
    assert.deepEqual(escolhidos, [2]);
  });

  it('nada achado: a busca manual manda o nome digitado', () => {
    const doc = novoDoc();
    const buscas = [];
    const n = D.nada(doc, { achado: false }, { buscar: (t) => buscas.push(t) }, 'Joana Prado');
    const campo = n.querySelector('input');
    assert.equal(campo.value, 'Joana Prado');
    campo.value = '  Joana P  ';
    n.querySelector('form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
    assert.deepEqual(buscas, ['Joana P']);
  });

  it('dado do servidor entra como TEXTO, nunca como HTML', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(ACHADO));
    r.cartao.nome = '<img src=x onerror="alert(1)">';
    r.cartao.etiquetas = ['<b>x</b>'];
    const n = D.cartao(doc, r, {});
    assert.equal(n.querySelector('img'), null);
    assert.equal(n.querySelector('b'), null);
    assert.match(n.textContent, /<img src=x/);
  });

  it('modo aprendiz: as dicas estáticas da fase 1, com id estável para a fase 3', () => {
    const doc = novoDoc();
    const n = D.aprendiz(doc, A.DICAS);
    assert.equal(n.tagName, 'DETAILS');
    assert.match(n.textContent, /No Kommo, a etapa fica em: Cartão › topo › funil/);
    assert.ok(n.querySelector('[data-dica="etapa"]'));
  });
});
