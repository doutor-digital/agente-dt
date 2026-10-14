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

// ── fase 2 ──

const tique = () => new Promise((r) => setTimeout(r, 0));

const COM_RESUMO = {
  ...ACHADO,
  cartao: { ...ACHADO.cartao, sofia: { pausada: false, por: null, ate: null }, pausaDoLead: null },
  resumo: {
    linhas: ['Maria Souza, de Açailândia — dor lombar.', 'Em AGENDADO há 2 dias.', 'Franquia: consulta marcada 15/10 às 08:00.'],
    proximoPasso: 'Confirmar a presença na consulta de 15/10 às 08:00.',
  },
  iaDisponivel: true,
};

describe('resumo do lead (fase 2)', () => {
  it('fica no topo do cartão, com as linhas e o próximo passo', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, COM_RESUMO, {});
    const bloco = n.querySelector('[data-bloco="resumo"]');
    assert.ok(bloco);
    const blocos = [...n.querySelectorAll('.bloco')];
    assert.equal(blocos[0], bloco, 'o resumo é o primeiro bloco do cartão');
    assert.deepEqual([...bloco.querySelectorAll('li')].map((li) => li.textContent), COM_RESUMO.resumo.linhas);
    assert.match(bloco.textContent, /Próximo passo: Confirmar a presença na consulta de 15\/10/);
  });

  it('"Resumir com IA" só aparece com chave da IA na unidade', () => {
    const doc = novoDoc();
    const acoes = { resumirComIa: () => Promise.resolve({ linhas: [] }) };
    assert.ok(D.cartao(doc, COM_RESUMO, acoes).querySelector('[data-acao="resumir-ia"]'));
    assert.equal(D.cartao(doc, { ...COM_RESUMO, iaDisponivel: false }, acoes).querySelector('[data-acao="resumir-ia"]'), null);
  });

  it('o clique pede o resumo do cartão certo e troca as linhas pelas da IA', async () => {
    const doc = novoDoc();
    const pedidos = [];
    const acoes = { resumirComIa: (id) => { pedidos.push(id); return Promise.resolve({ linhas: ['Linha da IA 1', 'Linha da IA 2'], ia: true }); } };
    const n = D.cartao(doc, COM_RESUMO, acoes);
    n.querySelector('[data-acao="resumir-ia"]').click();
    await tique();
    assert.deepEqual(pedidos, [123]);
    const bloco = n.querySelector('[data-bloco="resumo"]');
    assert.deepEqual([...bloco.querySelectorAll('li')].map((li) => li.textContent), ['Linha da IA 1', 'Linha da IA 2']);
    assert.match(bloco.textContent, /Resumo \(IA\)/);
    assert.match(bloco.textContent, /confira antes de usar/);
    assert.equal(bloco.querySelector('[data-acao="resumir-ia"]'), null, 'depois de resumir o botão some');
  });

  it('falha da IA aparece no bloco, e o botão volta', async () => {
    const doc = novoDoc();
    const n = D.cartao(doc, COM_RESUMO, { resumirComIa: () => Promise.reject(new Error('Não consegui resumir agora.')) });
    const b = n.querySelector('[data-acao="resumir-ia"]');
    b.click();
    await tique();
    await tique();
    assert.equal(b.disabled, false);
    assert.equal(b.textContent, 'Resumir com IA');
    assert.match(n.querySelector('[data-papel="nota-resumo"]').textContent, /Não consegui resumir agora/);
  });

  it('resumo da IA guardado no cartão (redesenho) aparece no lugar do sem IA', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, { ...COM_RESUMO, resumoIa: { linhas: ['Guardada'], ia: true } }, {});
    assert.deepEqual([...n.querySelectorAll('[data-bloco="resumo"] li')].map((li) => li.textContent), ['Guardada']);
  });
});

describe('pausar a Sofia neste paciente (fase 2)', () => {
  const pausar = (pedidos) => ({ pausar: (id, p) => { pedidos.push({ id, ...p }); return Promise.resolve(); }, retomar: () => Promise.resolve() });

  it('sem pausa: o botão abre as opções; "3 dias" manda o fim certo e o motivo', async () => {
    const doc = novoDoc();
    const pedidos = [];
    const n = D.cartao(doc, COM_RESUMO, pausar(pedidos));
    const form = n.querySelector('[data-papel="form-pausa"]');
    assert.equal(form.hidden, true);
    n.querySelector('[data-acao="abrir-pausa"]').click();
    assert.equal(form.hidden, false);
    assert.deepEqual([...form.querySelectorAll('input[type="radio"]')].map((r) => r.value), ['amanha8', '3dias', '1semana', 'data']);
    form.querySelector('input[value="3dias"]').checked = true;
    form.querySelector('.pausa__motivo').value = '  vai viajar  ';
    const antes = Date.now();
    form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
    await tique();
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].id, 123);
    assert.equal(pedidos[0].motivo, 'vai viajar');
    const fim = Date.parse(pedidos[0].ate) - antes;
    assert.ok(Math.abs(fim - 3 * 86400e3) < 5000, `fim em ~3 dias (veio ${fim} ms)`);
  });

  it('data além de 30 dias não chega ao servidor: o aviso aparece no bloco', () => {
    const doc = novoDoc();
    const pedidos = [];
    const n = D.cartao(doc, COM_RESUMO, pausar(pedidos));
    const form = n.querySelector('[data-papel="form-pausa"]');
    form.querySelector('input[value="data"]').checked = true;
    const data = form.querySelector('.pausa__data');
    assert.ok(data.max, 'o campo de data tem máximo');
    const longe = new Date(Date.now() + 40 * 86400e3);
    data.value = `${longe.getFullYear()}-${String(longe.getMonth() + 1).padStart(2, '0')}-${String(longe.getDate()).padStart(2, '0')}`;
    form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
    assert.equal(pedidos.length, 0);
    assert.match(n.querySelector('[data-papel="msg-pausa"]').textContent, /30 dias/);
  });

  it('pausada: "Sofia pausada até … · motivo · por Ana" e "Retomar agora" retoma este cartão', async () => {
    const doc = novoDoc();
    const retomados = [];
    const r = JSON.parse(JSON.stringify(COM_RESUMO));
    r.cartao.sofia = { pausada: true, por: 'janela', ate: '2026-10-14T11:00:00.000Z' };
    r.cartao.pausaDoLead = { ate: '2026-10-14T11:00:00.000Z', motivo: 'reunião com a família', por: 'Ana' };
    const n = D.cartao(doc, r, { pausar: () => Promise.resolve(), retomar: (id) => { retomados.push(id); return Promise.resolve(); } });
    const estado = n.querySelector('[data-papel="estado-pausa"]').textContent;
    assert.match(estado, /^Sofia pausada até \d{2}\/\d{2}/);
    assert.match(estado, /· reunião com a família · por Ana$/);
    assert.match(n.textContent, /pausada neste paciente até/);
    assert.equal(n.querySelector('[data-acao="abrir-pausa"]'), null);
    n.querySelector('[data-acao="retomar"]').click();
    await tique();
    assert.deepEqual(retomados, [123]);
  });

  it('erro ao retomar aparece no bloco', async () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(COM_RESUMO));
    r.cartao.pausaDoLead = { ate: '2026-10-14T11:00:00.000Z', motivo: null, por: null };
    const n = D.cartao(doc, r, { pausar: () => Promise.resolve(), retomar: () => Promise.reject(new Error('Muitas ações seguidas: aguarde um minuto.')) });
    n.querySelector('[data-acao="retomar"]').click();
    await tique();
    await tique();
    assert.match(n.querySelector('[data-papel="msg-pausa"]').textContent, /aguarde um minuto/);
  });

  it('caixinha marcada à mão pela SDR: só o aviso, sem o botão de pausar', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(COM_RESUMO));
    r.cartao.sofia = { pausada: true, por: 'caixinha', ate: null };
    const n = D.cartao(doc, r, pausar([]));
    assert.equal(n.querySelector('[data-acao="abrir-pausa"]'), null);
    assert.match(n.querySelector('[data-bloco="pausa"]').textContent, /desmarque no Kommo/);
  });

  it('sem nome nas opções: a dica aparece', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, COM_RESUMO, { ...pausar([]), semNome: () => true });
    assert.match(n.querySelector('[data-bloco="pausa"]').textContent, /ponha seu nome nas opções/);
  });
});

const FILA = {
  unidade: 'Açailândia',
  atualizadoEm: '2026-10-13T15:00:00.000Z',
  grupos: [
    {
      id: 'sem-resposta',
      etapa: 'entrada / EM QUALIFICAÇÃO',
      rotulo: 'sem resposta',
      total: 1,
      itens: [{
        leadId: 1, nome: 'João Lima', etapa: 'EM QUALIFICAÇÃO', motivo: 'sem resposta', detalhe: 'escreveu às 09:00',
        quando: '2026-10-13T12:00:00.000Z', passado: true, telefone: '5599900000043', telefoneVisivel: '(99) 90000-0043',
        link: 'https://x.kommo.com/leads/detail/1',
      }],
    },
    { id: 'retomar', etapa: 'EM ESPERA', rotulo: 'retomar contato', total: 0, itens: [] },
    {
      id: 'confirmar',
      etapa: 'AGENDADO',
      rotulo: 'confirmar presença',
      total: 40,
      itens: [{
        leadId: 2, nome: '<b>Ana</b>', etapa: 'AGENDADO', motivo: 'confirmar presença', detalhe: 'consulta amanhã às 08:00',
        quando: '2026-10-14T11:00:00.000Z', passado: false, telefone: null, telefoneVisivel: null, link: 'https://x.kommo.com/leads/detail/2',
      }],
      aviso: 'O Kommo não respondeu esta etapa agora.',
    },
  ],
};

describe('fila de hoje (fase 2)', () => {
  const agora = new Date('2026-10-13T15:00:00.000Z');

  it('um grupo por etapa, na ordem, com contador e o total no topo', () => {
    const doc = novoDoc();
    const n = D.fila(doc, FILA, {}, agora);
    assert.deepEqual([...n.querySelectorAll('[data-grupo]')].map((g) => g.getAttribute('data-grupo')), ['sem-resposta', 'retomar', 'confirmar']);
    assert.equal(n.querySelector('[data-contador="confirmar"]').textContent, '40');
    assert.equal(n.querySelector('[data-contador="retomar"]').textContent, '0');
    assert.match(n.textContent, /41 pacientes/);
    assert.match(n.querySelector('[data-grupo="retomar"]').textContent, /Ninguém agora/);
    assert.match(n.querySelector('[data-grupo="confirmar"]').textContent, /Mostrando 1 de 40/);
    assert.match(n.querySelector('[data-grupo="confirmar"]').textContent, /não respondeu esta etapa/);
  });

  it('cada item: nome, etapa, motivo, há quanto tempo e os três botões', () => {
    const doc = novoDoc();
    const item = D.fila(doc, FILA, {}, agora).querySelector('[data-lead="1"]');
    assert.match(item.textContent, /João Lima/);
    assert.match(item.textContent, /EM QUALIFICAÇÃO · escreveu às 09:00/);
    assert.match(item.querySelector('.fila__tempo').textContent, /há 3 h/);
    assert.match(item.textContent, /\(99\) 90000-0043/);
    assert.ok(item.querySelector('[data-acao="abrir-conversa"]'));
    assert.ok(item.querySelector('[data-acao="copiar"]'));
    const k = item.querySelector('a');
    assert.equal(k.href, 'https://x.kommo.com/leads/detail/1');
    assert.equal(k.target, '_blank');
  });

  it('"Abrir conversa" e "Copiar telefone" chamam o painel com o número certo', async () => {
    const doc = novoDoc();
    const abertos = [];
    const copiados = [];
    const item = D.fila(doc, FILA, {
      abrirConversa: (t) => { abertos.push(t); return Promise.resolve(); },
      copiar: (t) => { copiados.push(t); return Promise.resolve(); },
    }, agora).querySelector('[data-lead="1"]');
    item.querySelector('[data-acao="abrir-conversa"]').click();
    item.querySelector('[data-acao="copiar"]').click();
    await tique();
    assert.deepEqual(abertos, ['5599900000043']);
    assert.deepEqual(copiados, ['(99) 90000-0043']);
    assert.equal(item.querySelector('[data-acao="copiar"]').textContent, 'Copiado');
  });

  it('sem telefone: botões desligados; consulta futura não mostra "há"', () => {
    const doc = novoDoc();
    const item = D.fila(doc, FILA, {}, agora).querySelector('[data-lead="2"]');
    assert.equal(item.querySelector('[data-acao="abrir-conversa"]').disabled, true);
    assert.equal(item.querySelector('[data-acao="copiar"]').disabled, true);
    assert.match(item.textContent, /sem telefone no Kommo/);
    assert.equal(item.querySelector('.fila__tempo'), null);
  });

  it('nome do paciente entra como texto, nunca como HTML', () => {
    const doc = novoDoc();
    const n = D.fila(doc, FILA, {}, agora);
    assert.equal(n.querySelector('b'), null);
    assert.match(n.textContent, /<b>Ana<\/b>/);
  });

  it('erro ao abrir a conversa (sem aba do WhatsApp) aparece no item', async () => {
    const doc = novoDoc();
    const item = D.fila(doc, FILA, { abrirConversa: () => Promise.reject(new Error('Abra o WhatsApp Web nesta janela primeiro.')) }, agora)
      .querySelector('[data-lead="1"]');
    item.querySelector('[data-acao="abrir-conversa"]').click();
    await tique();
    await tique();
    assert.match(item.querySelector('[data-papel="msg-item"]').textContent, /Abra o WhatsApp Web/);
  });

  it('"Atualizar" pede a fila de novo', () => {
    const doc = novoDoc();
    let pedidos = 0;
    D.fila(doc, FILA, { atualizar: () => { pedidos++; } }, agora).querySelector('[data-acao="atualizar-fila"]').click();
    assert.equal(pedidos, 1);
  });
});

describe('abrir conversa = só navegação (fase 2)', () => {
  it('o link é o do WhatsApp Web com o telefone, e mais nada (nem texto)', () => {
    assert.equal(D.urlDaConversa('5599900000043'), 'https://web.whatsapp.com/send?phone=5599900000043');
    assert.ok(!D.urlDaConversa('5599900000043').includes('text='));
  });

  it('só dígitos, de 10 a 15: nada de JID, sinal, espaço ou injeção na URL', () => {
    for (const ruim of ['204567890123456@lid', '+5599900000043', '55 99 90000-0043', '123', '5599900000043&text=oi', '', null, undefined]) {
      assert.equal(D.urlDaConversa(ruim), null, String(ruim));
    }
  });

  it('o painel nunca monta o link com texto de mensagem (busca no código)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const arq of ['painel.js', 'desenho.js']) {
      const codigo = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
      assert.ok(!/[?&]text=/.test(codigo), `${arq} não pode montar link com texto`);
    }
  });
});

// ── fase 3 ──

describe('aviso de cartão duplicado (fase 3)', () => {
  const COM_DUPLICADO = {
    ...ACHADO,
    cartao: { ...ACHADO.cartao, origem: 'Meta-Instagram' },
    duplicados: [
      { id: 456, nome: 'MARIA SOUZA 10/10/2026', funil: 'COMERCIAL', etapa: 'EM QUALIFICAÇÃO', origem: null, link: 'https://x.kommo.com/leads/detail/456', via: 'contato' },
    ],
  };

  it('faixa amarela: quantos abertos, cada um com funil/etapa e ⚑ Origem, "Abrir no Kommo" e a regra', () => {
    const doc = novoDoc();
    const faixa = D.cartao(doc, COM_DUPLICADO, {}).querySelector('[data-bloco="duplicados"]');
    assert.ok(faixa);
    assert.ok(faixa.classList.contains('faixa--amarela'));
    assert.match(faixa.textContent, /Este paciente tem 2 cartões abertos/);
    const linhas = [...faixa.querySelectorAll('[data-lead]')];
    assert.deepEqual(linhas.map((l) => l.getAttribute('data-lead')), ['123', '456']);
    assert.match(linhas[0].textContent, /^Este: MARIA SOUZA 03\/10\/2026/);
    assert.match(linhas[0].textContent, /⚑ Origem: Meta-Instagram/);
    assert.equal(linhas[0].querySelector('a'), null, 'o cartão da tela não precisa de link');
    assert.match(linhas[1].textContent, /COMERCIAL › EM QUALIFICAÇÃO/);
    assert.doesNotMatch(linhas[1].textContent, /Origem/);
    assert.equal(linhas[1].querySelector('a').href, 'https://x.kommo.com/leads/detail/456');
    assert.match(faixa.textContent, /Confira se é a mesma pessoa antes de juntar\. Fica o que veio do anúncio; o outro é juntado \(Mesclar\) no Kommo, nunca apagado\./);
    assert.equal(faixa.querySelector('[data-grupo="mesmo-numero"]'), null);
  });

  it('outro contato com o mesmo número: grupo separado, com a cautela da família', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(COM_DUPLICADO));
    r.duplicados.push({ id: 900, nome: 'JOÃO SOUZA', funil: 'COMERCIAL', etapa: 'EM ESPERA', origem: null, link: 'https://x.kommo.com/leads/detail/900', via: 'telefone' });
    const faixa = D.cartao(doc, r, {}).querySelector('[data-bloco="duplicados"]');
    assert.match(faixa.querySelector('.faixa__titulo').textContent, /Este paciente tem 2 cartões abertos/, 'o do número não conta como do paciente');
    const grupo = faixa.querySelector('[data-grupo="mesmo-numero"]');
    assert.match(grupo.textContent, /pode ser da família — confira se é a mesma pessoa antes de juntar/);
    assert.deepEqual([...grupo.querySelectorAll('[data-lead]')].map((l) => l.getAttribute('data-lead')), ['900']);
  });

  it('só outro contato com o mesmo número: o título não diz que é o mesmo paciente', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(COM_DUPLICADO));
    r.duplicados = [{ id: 900, nome: 'JOÃO SOUZA', funil: 'COMERCIAL', etapa: 'EM ESPERA', origem: null, link: 'https://x.kommo.com/leads/detail/900', via: 'telefone' }];
    const faixa = D.cartao(doc, r, {}).querySelector('[data-bloco="duplicados"]');
    assert.equal(faixa.querySelector('.faixa__titulo').textContent, 'Há outro cartão aberto com o mesmo número');
    assert.match(faixa.textContent, /Confira se é a mesma pessoa antes de juntar/);
  });

  it('sem duplicado (lista vazia ou não conferida) não há faixa', () => {
    const doc = novoDoc();
    assert.equal(D.cartao(doc, { ...COM_DUPLICADO, duplicados: [] }, {}).querySelector('[data-bloco="duplicados"]'), null);
    assert.equal(D.cartao(doc, { ...COM_DUPLICADO, duplicados: null }, {}).querySelector('[data-bloco="duplicados"]'), null);
    assert.equal(D.cartao(doc, ACHADO, {}).querySelector('[data-bloco="duplicados"]'), null);
  });

  it('cartão da tela fechado: conta só os abertos, e ele não entra na lista', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(COM_DUPLICADO));
    r.cartao.fechado = true;
    r.duplicados.push({ id: 789, nome: 'Maria', funil: 'TRATAMENTO', etapa: 'EM TRATAMENTO', origem: 'Indicação', link: 'https://x.kommo.com/leads/detail/789', via: 'contato' });
    const faixa = D.cartao(doc, r, {}).querySelector('[data-bloco="duplicados"]');
    assert.match(faixa.textContent, /tem 2 cartões abertos/);
    assert.deepEqual([...faixa.querySelectorAll('[data-lead]')].map((l) => l.getAttribute('data-lead')), ['456', '789']);
  });

  it('a Ponte só avisa: não há botão de juntar nem de apagar', () => {
    const doc = novoDoc();
    const faixa = D.cartao(doc, COM_DUPLICADO, {}).querySelector('[data-bloco="duplicados"]');
    assert.equal(faixa.querySelector('button'), null);
  });
});
