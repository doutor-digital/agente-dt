// 0.4.0 — o guia "O que eu faço agora?": a leitura do que a atendente digita (guia.js) e o desenho do guia
// (desenho.js) a partir da resposta do servidor (formato de `GET …/ponte/guia`, backend/src/lib/ponte-guia.ts).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const D = require('../desenho.js');
const G = require('../guia.js');

const novoDoc = () => new JSDOM('<main></main>').window.document;
const esperar = () => new Promise((r) => setTimeout(r, 0));

const ESPERA = { id: 2454156, nome: '⊘ Motivo da espera', tipo: 'lista', opcoes: [{ id: 1852302, valor: 'Exames' }, { id: 1852306, valor: 'Viajando' }], obrigatorio: true, editavel: true, quem: 'sdr', valor: null };
const RETOMAR = { id: 2454154, nome: '◷ Retomar em', tipo: 'data', obrigatorio: true, editavel: true, quem: 'sdr', valor: null };
const OBS = { id: 2449924, nome: '✎ Observações', tipo: 'texto-longo', obrigatorio: false, editavel: true, quem: 'sdr', valor: null };
const QUALI = { id: 2449912, nome: '★ Qualificação (Quente/Morno/Frio)', tipo: 'lista', opcoes: [{ id: 1845412, valor: 'Quente' }, { id: 1845414, valor: 'Morno' }], obrigatorio: false, editavel: true, quem: 'sdr', valor: null };
const DATA_CONSULTA = { id: 2449934, nome: '◷ Data da Consulta', tipo: 'data', obrigatorio: true, editavel: false, quem: 'franquia', dica: 'Marque a consulta primeiro: a data entra sozinha no cartão. Paciente novo: pelo widget "Assistente do cartão" do Kommo, em "Cadastrar e marcar na franquia" — nunca direto na franquia. Já cadastrado: na franquia ou pelo widget.', valor: null };
const MOTIVO = { id: 2449942, nome: '⊘ Motivo do não agendamento', tipo: 'lista', opcoes: [{ id: 1845472, valor: 'Sem interesse' }], obrigatorio: true, editavel: true, quem: 'sdr', valor: null };
const VALOR = { id: 2449930, nome: '¤ Valor da Consulta', tipo: 'dinheiro', obrigatorio: false, editavel: true, quem: 'sdr', valor: null };

const GUIA = {
  leadId: 28593652,
  nome: 'Janaína 14/10/2026',
  funil: 'COMERCIAL',
  etapa: 'EM QUALIFICAÇÃO',
  statusId: 106809907,
  pipelineId: 13795975,
  noComercial: true,
  pendencia: 'Fechou tratamento sem ¤ Valor do tratamento',
  unidade: null,
  faltam: [QUALI, OBS],
  saidas: [
    { statusId: 106809915, nome: 'AGENDADO', rotulo: 'Marcou a consulta', faltam: [DATA_CONSULTA], sugere: [], bloqueio: 'Ainda não dá para mover: ◷ Data da Consulta — Marque a consulta primeiro.', mensagens: [], dicas: [] },
    { statusId: 111237819, nome: 'EM ESPERA', rotulo: 'Quer, mas depois', faltam: [ESPERA, RETOMAR], sugere: [], bloqueio: null, mensagens: ['No dia do ◷ Retomar em (às 9 h), a mensagem do ⊘ Motivo da espera.'], dicas: [] },
    { statusId: 143, nome: 'PERDIDO', rotulo: 'Não vai seguir', faltam: [MOTIVO], sugere: [], bloqueio: null, mensagens: [], dicas: ['Se o paciente pediu para não receber mais mensagens, ponha antes a etiqueta NO_FOLLOW_UP.'] },
  ],
  semSaidas: null,
  avisoDosRobos: 'Ao mover, os robôs desta etapa podem mandar mensagem ao paciente.',
  link: 'https://doutorherniaacailandia.kommo.com/leads/detail/28593652',
};

function acoesFalsas() {
  const chamadas = [];
  return {
    chamadas,
    voltar: () => chamadas.push(['voltar']),
    atualizar: () => chamadas.push(['atualizar']),
    gravarCampos: (leadId, campos) => { chamadas.push(['campos', leadId, campos]); return Promise.resolve(); },
    mover: (leadId, de, para, campos) => { chamadas.push(['mover', leadId, de, para, campos]); return Promise.resolve(); },
  };
}

/** Digita num campo do guia como a atendente (o evento que o painel escuta). */
function digitar(raiz, id, valor) {
  const c = raiz.querySelector(`[data-campo="${id}"].guia__entrada`) || raiz.querySelector(`.guia__entrada[data-campo="${id}"]`);
  assert.ok(c, `campo ${id} na tela`);
  c.value = valor;
  c.dispatchEvent(new c.ownerDocument.defaultView.Event('input'));
  c.dispatchEvent(new c.ownerDocument.defaultView.Event('change'));
}

describe('guia.js — o que a atendente digita', () => {
  it('lê texto, número (com R$ e vírgula), data do calendário e opção da lista; vazio não vai', () => {
    assert.deepEqual(G.lerEntrada(OBS, '  ligar à tarde '), { ok: true, valor: 'ligar à tarde', texto: 'ligar à tarde' });
    assert.deepEqual(G.lerEntrada(VALOR, 'R$ 1.250,50'), { ok: true, valor: 1250.5, texto: 'R$ 1.250,50' });
    assert.deepEqual(G.lerEntrada(RETOMAR, '2026-10-20'), { ok: true, valor: '2026-10-20', texto: '20/10/2026' });
    assert.deepEqual(G.lerEntrada(ESPERA, '1852306'), { ok: true, valor: 1852306, texto: 'Viajando' });
    assert.deepEqual(G.lerEntrada(OBS, '   '), { vazio: true });
    assert.equal(G.lerEntrada(VALOR, 'duzentos').ok, false);
    assert.equal(G.lerEntrada(RETOMAR, '2026-02-30').ok, false);
    assert.equal(G.lerEntrada(ESPERA, '999').ok, false);
  });

  it('podeMover: falta o que é obrigatório para mover; bloqueio (campo da franquia) nunca deixa', () => {
    const espera = GUIA.saidas[1];
    assert.deepEqual(G.podeMover(espera, { [ESPERA.id]: '1852306' }).falta, ['◷ Retomar em']);
    const ok = G.podeMover(espera, { [ESPERA.id]: '1852306', [RETOMAR.id]: '2026-10-20' });
    assert.equal(ok.pode, true);
    assert.deepEqual(ok.alteracoes.campos, [{ id: ESPERA.id, valor: 1852306 }, { id: RETOMAR.id, valor: '2026-10-20' }]);
    assert.equal(G.podeMover(GUIA.saidas[0], {}).pode, false);
    assert.match(G.podeMover(GUIA.saidas[0], {}).bloqueio, /Data da Consulta/);
  });
});

describe('guia — o desenho', () => {
  it('mostra a ⚠ Pendência, o que falta nesta etapa (com a entrada certa) e as saídas', () => {
    const doc = novoDoc();
    const s = D.guia(doc, GUIA, acoesFalsas(), { valores: {} });
    assert.equal(s.getAttribute('data-estado'), 'guia');
    assert.match(s.querySelector('[data-bloco="pendencia"]').textContent, /⚠ Pendência do cartão.*Fechou tratamento sem ¤ Valor do tratamento/);
    assert.match(s.querySelector('[data-passo="faltam"] .guia__titulo').textContent, /Falta nesta etapa \(EM QUALIFICAÇÃO\)/);
    assert.equal(s.querySelector(`[data-campo="${QUALI.id}"].guia__entrada`).tagName, 'SELECT');
    assert.deepEqual([...s.querySelectorAll(`select[data-campo="${QUALI.id}"] option`)].map((o) => o.textContent), ['Escolha…', 'Quente', 'Morno']);
    assert.equal(s.querySelector(`[data-campo="${OBS.id}"].guia__entrada`).tagName, 'TEXTAREA');
    assert.deepEqual([...s.querySelectorAll('[data-saida] .guia__saida-nome')].map((b) => b.textContent), ['AGENDADO', 'EM ESPERA', 'PERDIDO']);
    assert.match(s.textContent, /nunca escreve no WhatsApp nem na franquia/);
  });

  it('gravar: "Revisar" mostra a PRÉVIA e só "Gravar no Kommo" grava (com o id e o valor)', async () => {
    const doc = novoDoc();
    const a = acoesFalsas();
    const s = D.guia(doc, GUIA, a, { valores: {} });
    s.querySelector('[data-acao="revisar-campos"]').click();
    assert.match(s.querySelector('[data-papel="msg-faltam"]').textContent, /Preencha pelo menos um campo/);
    digitar(s, QUALI.id, '1845412');
    digitar(s, OBS.id, 'ligar à tarde');
    s.querySelector('[data-acao="revisar-campos"]').click();
    const prev = s.querySelector('[data-passo="faltam"] [data-papel="previa"]');
    assert.deepEqual([...prev.querySelectorAll('li')].map((l) => l.textContent), ['★ Qualificação (Quente/Morno/Frio): Quente', '✎ Observações: ligar à tarde']);
    assert.deepEqual(a.chamadas, [], 'nada gravado antes de confirmar');
    prev.querySelector('[data-acao="confirmar"]').click();
    await esperar();
    assert.deepEqual(a.chamadas, [['campos', 28593652, [{ id: QUALI.id, valor: 1845412 }, { id: OBS.id, valor: 'ligar à tarde' }]]]);
  });

  it('mover: escolhe a saída, vê o que falta e o aviso dos robôs; "Revisar e mover" confere; só "Mover agora" move', async () => {
    const doc = novoDoc();
    const a = acoesFalsas();
    const est = { valores: {} };
    const s = D.guia(doc, GUIA, a, est);
    s.querySelector('[data-saida="111237819"]').click();
    const det = s.querySelector('.guia__detalhe[data-saida="111237819"]');
    assert.equal(det.querySelector('[data-papel="aviso-robos"]').textContent, '⚠ Ao mover, os robôs desta etapa podem mandar mensagem ao paciente.');
    assert.match(det.querySelector('[data-papel="mensagens"]').textContent, /Retomar em/);
    assert.match(det.textContent, /⊘ Motivo da espera · obrigatório para mover/);

    digitar(det, ESPERA.id, '1852306');
    det.querySelector('[data-acao="revisar-mover"]').click();
    assert.match(det.querySelector('[data-papel="msg-mover"]').textContent, /Falta preencher: ◷ Retomar em/);
    assert.equal(det.querySelector('[data-papel="previa"]'), null);

    digitar(det, RETOMAR.id, '2026-10-20');
    det.querySelector('[data-acao="revisar-mover"]').click();
    const prev = det.querySelector('[data-papel="previa"]');
    assert.deepEqual([...prev.querySelectorAll('li')].map((l) => l.textContent), ['⊘ Motivo da espera: Viajando', '◷ Retomar em: 20/10/2026', 'Etapa: EM QUALIFICAÇÃO → EM ESPERA']);
    assert.match(prev.textContent, /os robôs desta etapa podem mandar mensagem ao paciente/);
    assert.deepEqual(a.chamadas, [], 'nada antes da confirmação');
    prev.querySelector('[data-acao="confirmar"]').click();
    await esperar();
    assert.deepEqual(a.chamadas, [['mover', 28593652, 106809907, 111237819, [{ id: ESPERA.id, valor: 1852306 }, { id: RETOMAR.id, valor: '2026-10-20' }]]]);
    assert.equal(est.saida, 111237819, 'a saída escolhida fica no estado (o redesenho não perde)');
  });

  it('saída com campo que a Ponte não preenche (◷ Data da Consulta): mostra o porquê e o botão de mover fica travado', () => {
    const doc = novoDoc();
    const a = acoesFalsas();
    const s = D.guia(doc, GUIA, a, { valores: {}, saida: 106809915 });
    const det = s.querySelector('.guia__detalhe[data-saida="106809915"]');
    assert.match(det.querySelector('[data-papel="bloqueio"]').textContent, /Data da Consulta/);
    assert.match(det.querySelector('[data-papel="dica-campo"]').textContent, /Marque a consulta primeiro/);
    assert.equal(det.querySelector('.guia__entrada'), null, 'sem caixa para digitar a data da consulta');
    const mover = det.querySelector('[data-acao="revisar-mover"]');
    assert.equal(mover.disabled, true);
    mover.click();
    assert.deepEqual(a.chamadas, []);
  });

  it('PERDIDO mostra a dica da NO_FOLLOW_UP', () => {
    const s = D.guia(novoDoc(), GUIA, acoesFalsas(), { valores: {}, saida: 143 });
    assert.match(s.querySelector('.guia__detalhe[data-saida="143"] [data-papel="dica"]').textContent, /NO_FOLLOW_UP/);
  });

  it('conta de duas unidades com a unidade vazia: SÓ o passo da unidade aparece, e grava a unidade depois da prévia', async () => {
    const doc = novoDoc();
    const a = acoesFalsas();
    const g = { ...GUIA, unidade: { campoId: 479786, nome: '⌂ Unidade de atendimento', opcoes: [{ id: 386142, valor: 'Petrópolis' }, { id: 386144, valor: 'Caxias' }], valor: null, precisa: true } };
    const s = D.guia(doc, g, a, { valores: {} });
    assert.ok(s.querySelector('[data-passo="unidade"]'));
    assert.equal(s.querySelector('[data-passo="faltam"]'), null, 'o resto espera a unidade');
    assert.equal(s.querySelector('[data-passo="saidas"]'), null);
    assert.equal(s.querySelector('[data-bloco="pendencia"]'), null);
    s.querySelector('[data-acao="revisar-unidade"]').click();
    assert.match(s.querySelector('[data-papel="msg-unidade"]').textContent, /Escolha a unidade/);
    const caxias = s.querySelector('[data-unidade="386144"]');
    caxias.checked = true;
    caxias.dispatchEvent(new doc.defaultView.Event('change'));
    s.querySelector('[data-acao="revisar-unidade"]').click();
    assert.deepEqual([...s.querySelectorAll('[data-passo="unidade"] [data-papel="previa"] li')].map((l) => l.textContent), ['⌂ Unidade de atendimento: Caxias']);
    s.querySelector('[data-passo="unidade"] [data-acao="confirmar"]').click();
    await esperar();
    assert.deepEqual(a.chamadas, [['campos', 28593652, [{ id: 479786, valor: 386144 }]]]);
  });

  it('etapa sem saída pela Ponte (GANHO, TRATAMENTO): diz o porquê', () => {
    const s = D.guia(novoDoc(), { ...GUIA, etapa: 'GANHO / CONCLUIDO', saidas: [], semSaidas: 'GANHO é da franquia e dos robôs: a Ponte não move cartão daqui.', faltam: [], pendencia: null }, acoesFalsas(), {});
    assert.match(s.querySelector('[data-papel="sem-saidas"]').textContent, /GANHO é da franquia e dos robôs/);
    assert.match(s.querySelector('[data-papel="nada-falta"]').textContent, /Nada faltando/);
  });

  it('o erro do servidor aparece perto do botão, e o botão volta a funcionar', async () => {
    const doc = novoDoc();
    const a = { ...acoesFalsas(), mover: () => Promise.reject(new Error('Para ir para PERDIDO, falta preencher: ⊘ Motivo do não agendamento.')) };
    const s = D.guia(doc, GUIA, a, { valores: { [MOTIVO.id]: '1845472' }, saida: 143 });
    const det = s.querySelector('.guia__detalhe[data-saida="143"]');
    det.querySelector('[data-acao="revisar-mover"]').click();
    const ok = det.querySelector('[data-acao="confirmar"]');
    ok.click();
    await esperar();
    await esperar();
    assert.match(det.querySelector('[data-papel="msg-mover"]').textContent, /falta preencher/);
    assert.equal(ok.disabled, false);
  });

  it('dado do servidor entra como TEXTO, nunca como HTML', () => {
    const doc = novoDoc();
    const g = { ...GUIA, pendencia: '<img src=x onerror=alert(1)>', nome: '<b>x</b>', faltam: [{ ...OBS, nome: '<script>1</script>' }] };
    const s = D.guia(doc, g, acoesFalsas(), { valores: {} });
    assert.equal(s.querySelector('img'), null);
    assert.equal(s.querySelector('script'), null);
    assert.equal(s.querySelector('b'), null);
    assert.match(s.textContent, /<img src=x onerror=alert\(1\)>/);
  });

  it('o botão "O que eu faço agora?" fica no cartão e abre o guia daquele cartão', () => {
    const doc = novoDoc();
    const abertos = [];
    const r = { achado: true, como: 'telefone', cartao: { id: 123, nome: 'MARIA', funil: 'COMERCIAL', etapa: 'AGENDADO', etiquetas: [], sofia: {} } };
    const c = D.cartao(doc, r, { abrirGuia: (id) => abertos.push(id) });
    const b = c.querySelector('[data-acao="abrir-guia"]');
    assert.equal(b.textContent, 'O que eu faço agora?');
    b.click();
    assert.deepEqual(abertos, [123]);
    // sem a ação (teste antigo), o botão não aparece
    assert.equal(D.cartao(doc, r, {}).querySelector('[data-acao="abrir-guia"]'), null);
  });
});
