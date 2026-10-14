// Fase 3 — "Começar a ligar": a ordem da fila, o ritmo (intervalo e teto por hora), o que fica guardado (só ids e
// horas) e a tela do modo ligação. O servidor confere o mesmo ritmo padrão em backend/src/lib/ponte-ligacao.test.ts.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const L = require('../ligacao.js');
const D = require('../desenho.js');

const novoDoc = () => new JSDOM('<main></main>').window.document;
const tique = () => new Promise((r) => setTimeout(r, 0));
const S = 1000;
const MIN = 60 * S;
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
  ...extra,
});

const FILA = {
  ritmo: { intervaloS: 40, tetoPorHora: 40 },
  grupos: [
    { id: 'sem-resposta', itens: [item(1), item(2, { telefone: null, telefoneVisivel: null, semTelefone: true })] },
    { id: 'retomar', itens: [item(3), item(1)] },
    { id: 'confirmar', itens: [] },
    { id: 'faltou', itens: [item(4)] },
  ],
};

describe('ligação — a fila e o estado guardado', () => {
  it('na ordem da Fila de hoje (grupo a grupo), sem repetir o mesmo cartão', () => {
    assert.deepEqual(L.filaDeLigacao(FILA).map((i) => i.leadId), [1, 2, 3, 4]);
    assert.deepEqual(L.filaDeLigacao(null), []);
  });

  it('telefone só de dígitos (10 a 15); @lid e vazio não servem', () => {
    assert.equal(L.temTelefone(item(1)), true);
    assert.equal(L.temTelefone({ telefone: '204567890123456@lid' }), false);
    assert.equal(L.temTelefone({ telefone: null }), false);
  });

  it('o próximo: o que está aberto primeiro; depois o primeiro não feito', () => {
    const itens = L.filaDeLigacao(FILA);
    let e = L.estadoDoDia(null, '2026-10-14', 'acai', T0);
    assert.equal(L.proximo(itens, e).leadId, 1);
    e = L.marcarFeito(e, 1);
    assert.equal(L.proximo(itens, e).leadId, 2);
    e = L.registrarAbertura(e, 4, T0);
    assert.equal(L.proximo(itens, e).leadId, 4, 'o aberto (painel fechado e reaberto) volta primeiro');
    e = L.marcarFeito(L.marcarFeito(L.marcarFeito(e, 2), 3), 4);
    assert.equal(e.atual, null);
    assert.equal(L.proximo(itens, e), null);
    assert.equal(L.feitosNaFila(itens, e), 4);
  });

  it('o estado vale para o dia e a unidade; o ritmo da última hora não zera', () => {
    const ontem = { v: 1, dia: '2026-10-13', slug: 'acai', feitos: [1, 3], atual: 3, aberturas: [T0 - 10 * MIN, T0 - 2 * 60 * MIN] };
    const hoje = L.estadoDoDia(ontem, '2026-10-14', 'acai', T0);
    assert.deepEqual(hoje.feitos, []);
    assert.equal(hoje.atual, null);
    assert.deepEqual(hoje.aberturas, [T0 - 10 * MIN], 'só as aberturas da última hora');
    const mesmo = L.estadoDoDia({ ...ontem, dia: '2026-10-14' }, '2026-10-14', 'acai', T0);
    assert.deepEqual(mesmo.feitos, [1, 3]);
    assert.equal(mesmo.atual, 3);
    assert.deepEqual(L.estadoDoDia({ ...ontem, dia: '2026-10-14' }, '2026-10-14', 'outra-unidade', T0).feitos, []);
    assert.deepEqual(L.estadoDoDia({ lixo: true }, '2026-10-14', 'acai', T0).feitos, []);
  });

  it('o que fica guardado tem só ids e horas — nunca nome nem telefone', () => {
    let e = L.estadoDoDia(null, '2026-10-14', 'acai', T0);
    e = L.registrarAbertura(e, 1, T0);
    e = L.marcarFeito(e, 1);
    e = L.registrarAbertura(e, 3, T0 + 41 * S);
    const json = JSON.stringify(e);
    assert.deepEqual(Object.keys(e).sort(), ['aberturas', 'atual', 'dia', 'feitos', 'slug', 'tentativa', 'v']);
    for (const t of ['Paciente', '559990000', '(99)']) assert.ok(!json.includes(t), `vazou "${t}"`);
  });
});

describe('ligação — tentativa e telefone não lido (revisão)', () => {
  it('cada abertura começa uma tentativa com id; o resultado gravado (feito) encerra a tentativa', () => {
    let e = L.estadoDoDia(null, '2026-10-14', 'acai', T0);
    e = L.registrarAbertura(e, 1, T0);
    assert.match(e.tentativa, /^[A-Za-z0-9_-]{8,64}$/);
    const primeira = e.tentativa;
    // o painel fechou e abriu: a mesma tentativa continua (o servidor não grava duas vezes)
    assert.equal(L.estadoDoDia(JSON.parse(JSON.stringify(e)), '2026-10-14', 'acai', T0 + 5000).tentativa, primeira);
    e = L.marcarFeito(e, 1);
    assert.equal(e.tentativa, null);
    e = L.registrarAbertura(e, 3, T0 + 41_000);
    assert.notEqual(e.tentativa, primeira);
    assert.equal(L.registrarAbertura(e, 4, T0 + 90_000, 'tentativa-fixa-1').tentativa, 'tentativa-fixa-1');
  });

  it('"sem telefone" só quando o servidor afirma; "deixar" pula agora sem marcar como feito', () => {
    assert.equal(L.semTelefoneConfirmado({ telefone: null, semTelefone: true }), true);
    assert.equal(L.semTelefoneConfirmado({ telefone: null, semTelefone: false }), false);
    assert.equal(L.semTelefoneConfirmado({ telefone: null }), false, 'servidor antigo: não sabe — não marca');
    const itens = L.filaDeLigacao(FILA);
    const e = L.estadoDoDia(null, '2026-10-14', 'acai', T0);
    assert.equal(L.proximo(itens, e, [1, 2]).leadId, 3);
    assert.deepEqual(e.feitos, []);
  });
});

describe('ligação — o ritmo', () => {
  it('o padrão é o do servidor (sem espera, 40 por hora), com as mesmas travas', () => {
    assert.deepEqual(L.ritmoDe(undefined), { intervaloS: 0, tetoPorHora: 40 });
    assert.deepEqual(L.ritmoDe({ intervaloS: 0, tetoPorHora: 40 }), { intervaloS: 0, tetoPorHora: 40 });
    assert.deepEqual(L.ritmoDe({ intervaloS: -3, tetoPorHora: 40 }), { intervaloS: 0, tetoPorHora: 40 });
    assert.deepEqual(L.ritmoDe({ intervaloS: 5, tetoPorHora: 999 }), { intervaloS: 5, tetoPorHora: 120 });
    assert.deepEqual(L.ritmoDe({ intervaloS: 60, tetoPorHora: 20 }), { intervaloS: 60, tetoPorHora: 20 });
  });

  it('a primeira abre na hora; a seguinte só 40 s depois da última abertura', () => {
    let e = L.estadoDoDia(null, '2026-10-14', 'acai', T0);
    assert.deepEqual(L.quandoPodeAbrir(e, T0, FILA.ritmo), { em: T0, motivo: null });
    e = L.registrarAbertura(e, 1, T0);
    assert.deepEqual(L.quandoPodeAbrir(e, T0 + 10 * S, FILA.ritmo), { em: T0 + 40 * S, motivo: 'intervalo' });
    assert.ok(L.quandoPodeAbrir(e, T0 + 40 * S, FILA.ritmo).em <= T0 + 40 * S);
  });

  it('teto por hora: com o teto cheio, só quando a abertura mais antiga sair da janela de 60 min', () => {
    const ritmo = { intervaloS: 40, tetoPorHora: 3 };
    let e = L.estadoDoDia(null, '2026-10-14', 'acai', T0);
    e = L.registrarAbertura(e, 1, T0);
    e = L.registrarAbertura(e, 2, T0 + 1 * MIN);
    e = L.registrarAbertura(e, 3, T0 + 2 * MIN);
    assert.deepEqual(L.quandoPodeAbrir(e, T0 + 3 * MIN, ritmo), { em: T0 + 60 * MIN, motivo: 'teto' });
    // passada a hora da primeira, libera (o intervalo da última já passou)
    assert.equal(L.quandoPodeAbrir(e, T0 + 60 * MIN, ritmo).motivo, null);
  });

  it('"próximo em 25 s" e "próximo em 3 min"', () => {
    assert.equal(L.textoDaEspera(24_200), 'próximo em 25 s');
    assert.equal(L.textoDaEspera(150_000), 'próximo em 3 min');
    assert.equal(L.textoDaEspera(-5), 'próximo em 0 s');
  });

  it('os resultados são os quatro combinados (o "Pular" não grava nada)', () => {
    assert.deepEqual(L.RESULTADOS.map((r) => r.id), ['atendeu', 'nao-atendeu', 'caixa-postal', 'numero-errado']);
    assert.deepEqual(L.RESULTADOS.map((r) => r.rotulo), ['Atendeu', 'Não atendeu', 'Caixa postal', 'Número errado']);
  });
});

describe('ligação — a tela', () => {
  const RITMO = { intervaloS: 40, tetoPorHora: 40 };
  const base = { item: item(3), posicao: 2, total: 4, pulados: [], ritmo: RITMO, msg: '' };

  it('a fila ganha "Começar a ligar" (ou "Continuar", com os feitos de hoje); fila vazia deixa o botão desligado', () => {
    const doc = novoDoc();
    let chamou = 0;
    const n = D.fila(doc, FILA, { comecarLigacao: () => { chamou++; } }, new Date(T0));
    const b = n.querySelector('[data-acao="comecar-ligar"]');
    assert.equal(b.textContent, 'Começar a ligar');
    b.click();
    assert.equal(chamou, 1);
    const continuar = D.fila(doc, FILA, { comecarLigacao: () => {}, feitosHoje: () => 2 }, new Date(T0)).querySelector('[data-acao="comecar-ligar"]');
    assert.equal(continuar.textContent, 'Continuar a ligar (2 feitos hoje)');
    assert.equal(D.fila(doc, { grupos: [] }, { comecarLigacao: () => {} }, new Date(T0)).querySelector('[data-acao="comecar-ligar"]').disabled, true);
  });

  it('esperando: o paciente da vez, a contagem regressiva e "Pular este"', () => {
    const doc = novoDoc();
    const pulos = [];
    const n = D.modoLigacao(doc, { ...base, fase: 'esperando', esperaAte: T0 + 25 * S, motivoEspera: 'intervalo' }, { pular: () => pulos.push(1) }, new Date(T0));
    assert.match(n.textContent, /Ligando · 2 de 4/);
    assert.match(n.querySelector('.ligacao__nome').textContent, /Paciente 3/);
    assert.match(n.textContent, /EM ESPERA · retomar contato · retomar hoje/);
    assert.equal(n.querySelector('[data-papel="espera"]').textContent, 'próximo em 25 s');
    assert.ok(n.querySelector('[data-acao="pausar-ligacao"]'));
    assert.equal(n.querySelector('[data-acao="resultado"]'), null, 'sem conversa aberta, não há resultado para marcar');
    n.querySelector('[data-acao="pular-ligacao"]').click();
    assert.equal(pulos.length, 1);
  });

  it('teto cheio: a tela diz por que espera', () => {
    const doc = novoDoc();
    const n = D.modoLigacao(doc, { ...base, fase: 'esperando', esperaAte: T0 + 20 * MIN, motivoEspera: 'teto' }, {}, new Date(T0));
    assert.equal(n.querySelector('[data-papel="espera"]').textContent, 'próximo em 20 min');
    assert.match(n.textContent, /teto de 40 conversas na última hora/);
  });

  it('aberto: "Clique no 📞 do WhatsApp para ligar" e os 4 resultados + Pular; o resultado vai com o cartão certo', async () => {
    const doc = novoDoc();
    const reg = [];
    const n = D.modoLigacao(doc, { ...base, fase: 'aberto' }, { resultado: (id, r) => { reg.push([id, r]); return Promise.resolve(); }, pular: () => reg.push(['pular']) }, new Date(T0));
    assert.match(n.textContent, /Clique no 📞 do WhatsApp para ligar\./);
    const botoes = [...n.querySelectorAll('[data-acao="resultado"]')];
    assert.deepEqual(botoes.map((b) => b.textContent), ['Atendeu', 'Não atendeu', 'Caixa postal', 'Número errado']);
    botoes[1].click();
    await tique();
    assert.deepEqual(reg, [[3, 'nao-atendeu']]);
    n.querySelector('.ligacao__resultados [data-acao="pular-ligacao"]').click();
    assert.deepEqual(reg[1], ['pular']);
    assert.equal(n.querySelector('[data-acao="pausar-ligacao"]'), null, 'com a conversa aberta não há contagem para pausar');
  });

  it('erro ao gravar o resultado aparece e os botões voltam', async () => {
    const doc = novoDoc();
    const n = D.modoLigacao(doc, { ...base, fase: 'aberto' }, { resultado: () => Promise.reject(new Error('Não consegui gravar a ligação no Kommo agora.')) }, new Date(T0));
    const b = n.querySelector('[data-resultado="atendeu"]');
    b.click();
    await tique();
    await tique();
    assert.match(n.querySelector('[data-papel="msg-ligacao"]').textContent, /Não consegui gravar/);
    assert.ok([...n.querySelectorAll('[data-acao="resultado"]')].every((x) => !x.disabled));
  });

  it('o último gravado aparece; sem telefone vai para "Pulados" com o link do Kommo; fim tem "Recomeçar"', () => {
    const doc = novoDoc();
    let recomecou = 0;
    const n = D.modoLigacao(doc, {
      ...base, item: null, fase: 'fim', ultimo: 'Gravado no Kommo: Paciente 4 · atendeu',
      pulados: [{ leadId: 2, nome: 'Paciente 2', link: 'https://x.kommo.com/leads/detail/2' }],
    }, { recomecar: () => { recomecou++; } }, new Date(T0));
    assert.match(n.querySelector('[data-papel="ultimo"]').textContent, /Paciente 4 · atendeu/);
    const pulados = n.querySelector('[data-bloco="pulados"]');
    assert.match(pulados.textContent, /sem telefone — abra pelo Kommo/);
    assert.equal(pulados.querySelector('a').href, 'https://x.kommo.com/leads/detail/2');
    assert.match(n.textContent, /Acabou a fila de hoje/);
    n.querySelector('[data-acao="recomecar-ligacao"]').click();
    assert.equal(recomecou, 1);
  });

  it('gravando: os resultados e o Pular vêm travados (redesenhar não destrava)', () => {
    const doc = novoDoc();
    const n = D.modoLigacao(doc, { ...base, fase: 'aberto', gravando: true }, { resultado: () => Promise.resolve() }, new Date(T0));
    assert.ok([...n.querySelectorAll('[data-acao="resultado"]')].every((b) => b.disabled));
    assert.equal(n.querySelector('.ligacao__resultados [data-acao="pular-ligacao"]').disabled, true);
    assert.match(n.querySelector('[data-papel="gravando"]').textContent, /Gravando no Kommo/);
  });

  it('telefone não lido: fica "para depois", sem dizer que acabou a fila', () => {
    const doc = novoDoc();
    const n = D.modoLigacao(doc, {
      ...base, item: null, fase: 'fim', aviso: 'Não consegui ler os telefones agora: tente de novo (Atualizar).',
      naoLidos: [{ leadId: 5, nome: 'Paciente 5' }, { leadId: 6, nome: 'Paciente 6' }],
    }, {}, new Date(T0));
    assert.doesNotMatch(n.textContent, /Acabou a fila de hoje/);
    assert.match(n.textContent, /2 pacientes ficaram sem o telefone lido/);
    assert.match(n.querySelector('[data-bloco="nao-lidos"]').textContent, /não consegui ler os telefones, tente de novo/i);
    assert.match(n.querySelector('[data-papel="aviso-ligacao"]').textContent, /tente de novo/);
  });

  it('pausado: "Continuar" no lugar de "Pausar"', () => {
    const doc = novoDoc();
    let continuou = 0;
    const n = D.modoLigacao(doc, { ...base, fase: 'pausado' }, { continuar: () => { continuou++; } }, new Date(T0));
    assert.equal(n.querySelector('[data-acao="pausar-ligacao"]'), null);
    n.querySelector('[data-acao="continuar-ligacao"]').click();
    assert.equal(continuou, 1);
  });

  it('a Ponte nunca clica no WhatsApp: nenhum código de clique/discagem na página (busca no código)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const arq of ['ligacao.js', 'painel.js', 'desenho.js']) {
      const codigo = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
      assert.ok(!/chrome\.(scripting|tabs\.executeScript)|tel:|callto:/.test(codigo), `${arq} não pode injetar nem discar`);
    }
  });
});
