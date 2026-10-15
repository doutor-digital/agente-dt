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
  it('cartão achado (resposta do servidor de HOJE, sem os campos da 0.5.0): nome, como achei, trilha, Sofia, franquia e link', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, ACHADO, {});
    const t = n.textContent;
    assert.equal(n.getAttribute('data-estado'), 'achado');
    assert.match(t, /MARIA SOUZA 03\/10\/2026/);
    assert.equal(n.querySelector('[data-como]').textContent, 'achei pelo telefone');
    // a trilha: a etapa atual acesa, as de antes feitas, e de quem é a etapa (AGENDADO anda sozinha pela franquia)
    const estacoes = [...n.querySelectorAll('.estacao')];
    assert.equal(estacoes.length, 5);
    assert.ok(estacoes[2].classList.contains('estacao--atual'));
    assert.ok(estacoes[0].classList.contains('estacao--feita'));
    assert.ok(estacoes[2].classList.contains('estacao--franquia'));
    assert.ok(estacoes[0].classList.contains('estacao--voce'));
    const aqui = n.querySelector('[data-papel="etapa-atual"]');
    assert.equal(aqui.getAttribute('data-dono'), 'franquia');
    assert.match(aqui.textContent, /AGENDADO/);
    assert.match(aqui.textContent, /Anda sozinha pela franquia/);
    assert.match(aqui.textContent, /COMPARECEU ou NÃO COMPARECEU quando a franquia der baixa/);
    // campo que o servidor de hoje não manda: não aparece, e nada quebra
    assert.equal(n.querySelector('[data-papel="telefone"]'), null);
    assert.equal(n.querySelector('[data-papel="qualificacao"]'), null);
    assert.equal(n.querySelector('[data-papel="tempo-na-etapa"]'), null);
    assert.equal(n.querySelector('[data-papel="unidade"]').textContent, 'Açailândia', 'sem cartao.unidade: o nome da unidade da franquia');
    assert.match(t, /Giulia/);
    assert.match(t, /pausada neste cartão/);
    // a consulta da franquia, mastigada
    const consulta = n.querySelector('[data-papel="proxima-consulta"]');
    assert.match(consulta.textContent, /15\/10/);
    assert.match(consulta.textContent, /08:00/);
    assert.match(consulta.textContent, /Dra\. Ana/);
    assert.match(consulta.textContent, /Agendada/);
    assert.match(t, /Dor ciática tem tratamento sem cirurgia/);
    const link = n.querySelector('a.botao--kommo');
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
    const n = D.cartao(doc, r, {});
    assert.match(n.textContent, /não está no funil COMERCIAL/);
    assert.match(n.querySelector('[data-papel="sem-consulta"]').textContent, /Nenhuma consulta marcada/);
  });

  it('trilha: cartão PERDIDO não pinta nada como feito, e GANHO nunca aparece como "feito"', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(ACHADO));
    r.cartao.barra.etapas.forEach((e) => { e.atual = e.id === 143; });
    let estacoes = [...D.cartao(doc, r, {}).querySelectorAll('.estacao')];
    assert.equal(estacoes.filter((e) => e.classList.contains('estacao--feita')).length, 0);
    assert.ok(estacoes[4].classList.contains('estacao--atual'));
    r.cartao.barra.etapas.forEach((e) => { e.atual = e.id === 142; }); // GANHO: o caminho todo foi feito
    estacoes = [...D.cartao(doc, r, {}).querySelectorAll('.estacao')];
    assert.deepEqual(estacoes.map((e) => e.classList.contains('estacao--feita')), [true, true, true, false, false]);
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
  it('o resumo traz as linhas; o próximo passo dele vira a 1ª ação de "O que é seu agora"', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, COM_RESUMO, {});
    const bloco = n.querySelector('[data-bloco="resumo"]');
    assert.ok(bloco);
    assert.deepEqual([...bloco.querySelectorAll('li')].map((li) => li.textContent), COM_RESUMO.resumo.linhas);
    assert.doesNotMatch(bloco.textContent, /Próximo passo/);
    const seu = n.querySelector('[data-bloco="seu-agora"]');
    assert.equal(seu.querySelector('li').textContent, 'Confirmar a presença na consulta de 15/10 às 08:00.');
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

// ── 0.5.0: o visual novo ──

const AGORA = new Date('2026-10-14T13:00:00.000Z'); // qua 14/10, 10:00 em São Paulo

/** A resposta do cartão com os campos novos da 0.5.0 (o servidor passa a mandar). */
function novo(extra = {}) {
  const r = JSON.parse(JSON.stringify(ACHADO));
  r.cartao.telefone = '(99) 90000-0043';
  r.cartao.unidade = { nome: 'Açailândia', compartilhada: false };
  r.cartao.qualificacao = 'Quente';
  r.cartao.naEtapaDesde = '2026-10-12T13:00:00.000Z';
  r.cartao.sofia = { pausada: false, por: null, ate: null };
  r.sofiaNaUnidade = true;
  r.resumo = { linhas: ['Maria, de Açailândia.'], proximoPasso: 'Confirmar a presença na consulta de 15/10 às 08:00.' };
  r.franquia.tz = 'America/Sao_Paulo';
  r.franquia.agenda.proximaConsulta.quando = '2026-10-15T11:00:00.000Z';
  return Object.assign(r, extra);
}

const etapas = (nomes, atual) => nomes.map(([nome, id]) => ({ id, nome, atual: nome === atual }));
const COMERCIAL = [['EM QUALIFICAÇÃO', 1], ['EM ESPERA', 2], ['AGENDADO', 3], ['COMPARECEU', 4], ['GANHO / CONCLUIDO', 142], ['PERDIDO', 143]];

describe('0.5.0 — o cabeçalho', () => {
  it('telefone, selo da unidade com cor, qualificação e como achei', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, novo(), {}, AGORA);
    assert.equal(n.querySelector('[data-papel="telefone"]').textContent, '(99) 90000-0043');
    const u = n.querySelector('[data-papel="unidade"]');
    assert.equal(u.textContent, 'Açailândia');
    assert.match(u.className, /selo--(indigo|teal|magenta|verde|laranja|azul)/);
    const q = n.querySelector('[data-papel="qualificacao"]');
    assert.equal(q.textContent, 'Quente');
    assert.match(q.className, /selo--quente/);
    assert.equal(n.querySelector('[data-como]').textContent, 'achei pelo telefone');
    assert.equal(n.querySelector('.avatar').textContent, 'MS');
  });

  it('qualificação vazia aparece como "Sem qualificação"; conta sem o campo, não aparece', () => {
    const doc = novoDoc();
    assert.equal(D.cartao(doc, novo({ cartao: { ...novo().cartao, qualificacao: null } }), {}, AGORA).querySelector('[data-papel="qualificacao"]').textContent, 'Sem qualificação');
    const semCampo = novo();
    delete semCampo.cartao.qualificacao;
    assert.equal(D.cartao(doc, semCampo, {}, AGORA).querySelector('[data-papel="qualificacao"]'), null);
  });

  it('conta de duas unidades com o campo vazio: "Escolha a unidade" abre o guia; a franquia pede a unidade', () => {
    const doc = novoDoc();
    const r = novo();
    r.cartao.unidade = { nome: null, compartilhada: true, opcoes: ['Petrópolis', 'Caxias'] };
    r.franquia = { unidade: 'Petrópolis', franquia: true, paciente: null, codigo: 'sem_unidade', erro: 'Escolha a ⌂ Unidade de atendimento do cartão.' };
    const abertos = [];
    const n = D.cartao(doc, r, { abrirGuia: (id) => abertos.push(id) }, AGORA);
    const selo = n.querySelector('[data-papel="unidade"]');
    assert.equal(selo.tagName, 'BUTTON');
    assert.equal(selo.textContent, 'Escolha a unidade');
    selo.click();
    assert.deepEqual(abertos, [123]);
    assert.match(n.querySelector('[data-papel="franquia-sem-unidade"]').textContent, /Escolha a unidade para ver a franquia/);
    assert.match(n.querySelector('[data-bloco="seu-agora"] li').textContent, /^Escolher a unidade do paciente/);
  });

  it('Petrópolis e Caxias nunca têm a mesma cor de selo', () => {
    const T = require('../trilha.js');
    assert.notEqual(T.corDaUnidade('Petrópolis'), T.corDaUnidade('Caxias'));
  });
});

describe('0.5.0 — a trilha do funil', () => {
  it('a etapa atual acesa, o tempo nela, de quem é e o que vem depois', () => {
    const doc = novoDoc();
    const r = novo();
    r.cartao.barra.etapas = etapas(COMERCIAL, 'AGENDADO');
    const n = D.cartao(doc, r, {}, AGORA);
    assert.equal(n.querySelector('[data-papel="tempo-na-etapa"]').textContent, 'há 2 dias');
    const estacoes = [...n.querySelectorAll('.estacao')];
    assert.deepEqual(estacoes.map((e) => (e.className.match(/estacao--(voce|franquia|neutra)/) || [])[1]), ['voce', 'voce', 'franquia', 'franquia', 'franquia', 'voce']);
    assert.ok(estacoes[4].classList.contains('estacao--saida') && estacoes[4].classList.contains('estacao--primeira-saida'));
    const todas = n.querySelector('.trilha__todas');
    assert.match(todas.querySelector('summary').textContent, /Ver as 6 etapas/);
    assert.match(todas.textContent, /AGENDADOestá aquifranquia/);
    assert.match(n.querySelector('.legenda').textContent, /É sua.*Anda sozinha pela franquia/);
  });

  it('etapa da atendente parada há tempo demais: o relógio fica em alerta', () => {
    const doc = novoDoc();
    const r = novo();
    r.cartao.barra.etapas = etapas(COMERCIAL, 'EM QUALIFICAÇÃO');
    r.cartao.naEtapaDesde = '2026-10-11T13:00:00.000Z';
    const n = D.cartao(doc, r, {}, AGORA);
    const aqui = n.querySelector('[data-papel="etapa-atual"]');
    assert.equal(aqui.getAttribute('data-dono'), 'voce');
    assert.match(aqui.textContent, /É sua: você trabalha esta etapa/);
    assert.ok(n.querySelector('[data-papel="tempo-na-etapa"]').classList.contains('aqui__tempo--atrasado'));
  });

  it('no funil TRATAMENTO: a trilha do TRATAMENTO, com os nomes, e o COMERCIAL concluído', () => {
    const doc = novoDoc();
    const r = novo();
    r.cartao.funil = 'TRATAMENTO';
    r.cartao.etapa = 'EM TRATAMENTO';
    r.cartao.barra.noFunil = false;
    r.cartao.barra.etapas.forEach((e) => { e.atual = false; });
    r.cartao.barraTratamento = { funil: 'TRATAMENTO', noFunil: true, etapas: etapas([['EM TRATAMENTO', 9], ['ALTA', 142], ['TRATAMENTO CANCELADO', 143]], 'EM TRATAMENTO') };
    const n = D.cartao(doc, r, {}, AGORA);
    assert.match(n.querySelector('.trilha__antes').textContent, /COMERCIAL concluído/);
    assert.deepEqual([...n.querySelectorAll('.estacao__nome')].map((x) => x.textContent), ['EM TRATAMENTO', 'ALTA', 'TRATAMENTO CANCELADO']);
    assert.doesNotMatch(n.querySelector('[data-bloco="trilha"]').textContent, /não está no funil/);
    assert.match(n.querySelector('[data-papel="etapa-atual"]').textContent, /Vai sozinho para ALTA/);
  });
});

describe('0.5.0 — "O que é seu agora" e "O que é da franquia"', () => {
  it('as ações da etapa, o guia e a regra da franquia', () => {
    const doc = novoDoc();
    const abertos = [];
    const r = novo();
    r.cartao.barra.etapas = etapas(COMERCIAL, 'AGENDADO');
    const n = D.cartao(doc, r, { abrirGuia: (id) => abertos.push(id) }, AGORA);
    const itens = [...n.querySelectorAll('[data-bloco="seu-agora"] li')].map((li) => li.textContent);
    assert.ok(itens.length >= 1 && itens.length <= 3);
    assert.equal(itens[0], 'Confirmar a presença na consulta de 15/10 às 08:00.');
    n.querySelector('[data-acao="abrir-guia"]').click();
    assert.deepEqual(abertos, [123]);
    assert.equal(n.querySelector('[data-bloco="da-franquia"] .agora__regra').textContent,
      'Paciente novo: cadastre e marque pelo widget "Assistente do cartão" do Kommo (Cadastrar e marcar na franquia), nunca direto na franquia. ' +
      'Já cadastrado: marque na franquia ou pelo widget. Dar baixa e lançar sessão se faz NA FRANQUIA; o cartão anda sozinho aqui.');
  });
});

describe('0.5.0 — o cartão "Na franquia"', () => {
  it('a próxima consulta mastigada: dia da semana, dia, hora, quem e "amanhã"', () => {
    const doc = novoDoc();
    const c = D.cartao(doc, novo(), {}, AGORA).querySelector('[data-papel="proxima-consulta"]');
    assert.match(c.textContent, /qui/);
    assert.match(c.textContent, /15\/10/);
    assert.match(c.textContent, /amanhã/);
    assert.match(c.textContent, /08:00/);
    assert.match(c.textContent, /Dra\. Ana/);
  });

  it('sem cadastro na franquia: diz com clareza', () => {
    const doc = novoDoc();
    const r = novo();
    r.franquia = { unidade: 'Açailândia', franquia: true, paciente: null };
    const t = D.cartao(doc, r, {}, AGORA).querySelector('[data-papel="sem-cadastro"]').textContent;
    assert.match(t, /Sem cadastro na franquia/);
    // 0.5.1: paciente novo se cadastra e marca pelo widget, nunca direto na franquia
    assert.match(t, /widget "Assistente do cartão"/);
    assert.match(t, /Cadastrar e marcar na franquia/);
    assert.match(t, /nunca direto na franquia/);
  });

  it('franquia fora do ar: avisa, sem inventar nada', () => {
    const doc = novoDoc();
    const r = novo();
    r.franquia = { unidade: 'Açailândia', franquia: true, paciente: null, erro: 'franquia indisponível' };
    assert.match(D.cartao(doc, r, {}, AGORA).querySelector('[data-papel="franquia-erro"]').textContent, /A franquia não respondeu agora/);
  });

  it('em tratamento: última consulta (veio), tratamento, sessões (feitas, faltas, marcadas), a próxima e a alta', () => {
    const doc = novoDoc();
    const r = novo();
    r.cartao.funil = 'TRATAMENTO';
    r.cartao.etapa = 'EM TRATAMENTO';
    r.franquia.agenda = {
      proximaConsulta: null,
      ultimaConsulta: { dia: '25/09', status: 'ATENDIDO' },
      proximaSessao: { dia: '16/10', hora: '17:30', quando: '2026-10-16T20:30:00.000Z' },
      sessoes: { realizadas: 6, faltas: 1, futuras: 3 },
    };
    r.franquia.tratamento = { categoria: 'Coluna lombar', status: 'Em andamento' };
    const n = D.cartao(doc, r, {}, AGORA);
    assert.equal(n.querySelector('[data-papel="sem-consulta"]'), null, 'em tratamento, "nenhuma consulta" não é alerta');
    assert.match(n.querySelector('[data-papel="ultima-consulta"]').textContent, /25\/09.*Compareceu/);
    assert.match(n.querySelector('[data-papel="tratamento"]').textContent, /Coluna lombar.*Em andamento/);
    const ses = n.querySelector('[data-papel="sessoes"]');
    assert.match(ses.textContent, /6 feitas/);
    assert.match(ses.textContent, /1 falta/);
    assert.match(ses.textContent, /3 marcadas/);
    assert.equal(ses.querySelectorAll('.sessoes__seg').length, 3);
    assert.match(n.querySelector('[data-papel="proxima-sessao"]').textContent, /sex 16\/10 às 17:30/);
    assert.match(n.querySelector('[data-papel="alta"]').textContent, /ainda não/);
  });

  it('unidade sem franquia ligada: não há cartão "Na franquia"', () => {
    const doc = novoDoc();
    const r = novo();
    r.franquia = { unidade: 'Açailândia', franquia: false, paciente: null };
    assert.equal(D.cartao(doc, r, {}, AGORA).querySelector('[data-bloco="franquia"]'), null);
  });
});

describe('0.5.0 — Sofia e o resto', () => {
  it('unidade sem a IA: nem o estado da Sofia nem a pausa aparecem', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, novo({ sofiaNaUnidade: false }), { pausar: () => Promise.resolve(), retomar: () => Promise.resolve() }, AGORA);
    assert.equal(n.querySelector('[data-bloco="sofia"]'), null);
    assert.equal(n.querySelector('[data-bloco="pausa"]'), null);
    assert.ok(n.querySelector('[data-bloco="kommo"]'), 'o resto do cartão continua');
    // 0.5.1: em lugar nenhum do cartão (o vídeo de Petrópolis e Caxias mostrou a Sofia)
    assert.doesNotMatch(n.textContent, /Sofia/);
  });

  it('0.5.1 — o modo aprendiz só fala da Sofia quando a unidade tem a IA', () => {
    const doc = novoDoc();
    const sem = D.aprendiz(doc, A.dicasPara(false));
    assert.doesNotMatch(sem.textContent, /Sofia/);
    assert.equal(sem.querySelector('[data-dica="pausa"]'), null);
    assert.match(sem.querySelector('[data-dica="marcar"]').textContent, /widget "Assistente do cartão".*Cadastrar e marcar na franquia/);
    assert.equal(D.aprendiz(doc, A.dicasPara(undefined)).querySelector('[data-dica="pausa"]'), null, 'sem saber, sem Sofia');
    assert.match(D.aprendiz(doc, A.dicasPara(true)).querySelector('[data-dica="pausa"]').textContent, /Pausar a Sofia/);
  });

  it('dado do servidor nos campos novos entra como texto, nunca como HTML', () => {
    const doc = novoDoc();
    const r = novo();
    r.cartao.telefone = '<img src=x onerror=alert(1)>';
    r.cartao.unidade = { nome: '<b>Caxias</b>', compartilhada: true };
    r.cartao.qualificacao = '<i>Quente</i>';
    const n = D.cartao(doc, r, {}, AGORA);
    assert.equal(n.querySelector('img'), null);
    assert.equal(n.querySelector('b'), null);
    assert.equal(n.querySelector('i'), null);
    assert.match(n.textContent, /<b>Caxias<\/b>/);
  });

  it('os ícones são SVG decorativos (aria-hidden), sem nada de fora', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, novo(), {}, AGORA);
    const svgs = [...n.querySelectorAll('svg')];
    assert.ok(svgs.length > 5);
    assert.ok(svgs.every((s) => s.getAttribute('aria-hidden') === 'true'));
    assert.ok(svgs.every((s) => !s.querySelector('image, use, foreignObject')));
  });
});

describe('0.5.0 — respostas sugeridas para a etapa', () => {
  const LISTA = {
    respostas: [
      { id: 1, nome: 'consulta_confirmar_presenca', texto: 'Oi, {{contact.name}}! Confirma amanhã?' },
      { id: 2, nome: 'petropolis_consulta_endereco', texto: 'Rua de Petrópolis.' },
      { id: 3, nome: 'caxias_consulta_endereco', texto: 'Rua de Caxias.' },
      { id: 4, nome: 'lead_boas_vindas', texto: 'Oi, {{contact.name}}!' },
      { id: 5, nome: 'Bom dia', texto: 'Bom dia!' },
    ],
  };
  const ids = (n, papel) => [...n.querySelectorAll(`[data-papel="${papel}"] [data-resposta]`)].map((x) => Number(x.getAttribute('data-resposta')));

  it('Petrópolis em AGENDADO: consulta_ no topo (com a da unidade), os de Caxias saem da lista', () => {
    const doc = novoDoc();
    const n = D.respostas(doc, LISTA, { copiar: () => Promise.resolve() }, 'Maria', '', { etapa: 'AGENDADO', unidade: 'Petrópolis', unidades: ['Petrópolis', 'Caxias'] });
    assert.deepEqual(ids(n, 'sugeridas'), [1, 2]);
    assert.deepEqual(ids(n, 'todas'), [4, 5]);
    assert.equal(n.querySelector('[data-resposta="3"]'), null);
    assert.match(n.querySelector('[data-papel="escondidas"]').textContent, /1 resposta de outra unidade ficou de fora: este paciente é de Petrópolis/);
    assert.match(n.querySelector('[data-papel="sugeridas"]').textContent, /AGENDADO/);
    assert.match(n.querySelector('[data-resposta="2"]').textContent, /Petrópolis/, 'a etiqueta da unidade com acento');
  });

  it('sem unidade escolhida: nada de modelo de unidade nas sugeridas, e todos na lista', () => {
    const doc = novoDoc();
    const n = D.respostas(doc, LISTA, { copiar: () => Promise.resolve() }, 'Maria', '', { etapa: 'AGENDADO', unidade: null, unidades: ['Petrópolis', 'Caxias'] });
    assert.deepEqual(ids(n, 'sugeridas'), [1]);
    assert.deepEqual(ids(n, 'todas'), [2, 3, 4, 5]);
  });

  it('sem cartão na tela (sem etapa): a lista inteira, sem sugeridas', () => {
    const doc = novoDoc();
    const n = D.respostas(doc, LISTA, { copiar: () => Promise.resolve() }, null, '', {});
    assert.equal(n.querySelector('[data-papel="sugeridas"]'), null);
    assert.deepEqual(ids(n, 'todas'), [1, 2, 3, 4, 5]);
  });

  it('a sugerida continua só COPIAR, com o nome do paciente da tela', async () => {
    const doc = novoDoc();
    const copiados = [];
    const n = D.respostas(doc, LISTA, { copiar: (t) => { copiados.push(t); return Promise.resolve(); } }, 'Maria', '', { etapa: 'EM QUALIFICAÇÃO' });
    n.querySelector('[data-papel="sugeridas"] [data-acao="copiar-resposta"]').click();
    await tique();
    assert.deepEqual(copiados, ['Oi, Maria!']);
  });
});

describe('0.5.0 — com o servidor de HOJE', () => {
  it('conta de duas unidades com o campo vazio: a recusa da franquia vira "Escolha a unidade" (nunca o nome da conta)', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(ACHADO));
    r.franquia = { unidade: 'Petrópolis', franquia: true, paciente: null, erro: 'Escolha a ⌂ Unidade de atendimento do cartão (Petrópolis ou Caxias) antes de marcar: esta conta do Kommo atende 2 unidades, cada uma com a sua agenda na franquia. Nada foi marcado.' };
    const n = D.cartao(doc, r, { abrirGuia: () => {} });
    assert.equal(n.querySelector('[data-papel="unidade"]').textContent, 'Escolha a unidade');
    assert.ok(n.querySelector('[data-papel="franquia-sem-unidade"]'));
    assert.doesNotMatch(n.textContent, /Nada foi marcado/);
  });

  it('cartão no TRATAMENTO sem a trilha do TRATAMENTO: "COMERCIAL concluído", sem a linha nem o aviso de fora do funil', () => {
    const doc = novoDoc();
    const r = JSON.parse(JSON.stringify(ACHADO));
    r.cartao.funil = 'TRATAMENTO';
    r.cartao.etapa = 'EM TRATAMENTO';
    r.cartao.barra.noFunil = false;
    r.cartao.barra.etapas.forEach((e) => { e.atual = false; });
    const n = D.cartao(doc, r, {});
    assert.ok(n.querySelector('.trilha__antes'));
    assert.equal(n.querySelector('.trilha__linha'), null);
    assert.doesNotMatch(n.textContent, /não está no funil/);
    assert.match(n.querySelector('[data-papel="etapa-atual"]').textContent, /EM TRATAMENTO/);
  });
});

describe('0.5.0 — unidade em que o cartão NÃO anda sozinho (franquiaAndaSozinha: false)', () => {
  it('a etapa da franquia vira "a recepção atualiza pela franquia", e nada promete movimento automático', () => {
    const doc = novoDoc();
    const r = novo({ franquiaAndaSozinha: false });
    r.cartao.barra.etapas = etapas(COMERCIAL, 'AGENDADO');
    const n = D.cartao(doc, r, {}, AGORA);
    const aqui = n.querySelector('[data-papel="etapa-atual"]');
    assert.match(aqui.textContent, /A recepção atualiza pela franquia/);
    assert.match(aqui.textContent, /quando a recepção der baixa na consulta/);
    assert.match(n.querySelector('.legenda').textContent, /A recepção atualiza pela franquia/);
    assert.equal(n.querySelector('[data-bloco="da-franquia"] .agora__regra').textContent,
      'Paciente novo: cadastre e marque pelo widget "Assistente do cartão" do Kommo (Cadastrar e marcar na franquia), nunca direto na franquia. ' +
      'Já cadastrado: marque na franquia ou pelo widget. Dar baixa e lançar sessão se faz NA FRANQUIA; nesta unidade, a recepção atualiza o cartão pela franquia.');
    assert.ok([...n.querySelectorAll('.estacao')].some((e) => /a recepção atualiza pela franquia/.test(e.title)));
    // em lugar nenhum do cartão: "anda sozinh(o|a)" nem "vai sozinho"
    assert.doesNotMatch(n.textContent, /anda sozinh|vai sozinho|volta sozinho/i);
  });

  it('sem cadastro: não promete o AGENDADO sozinho', () => {
    const doc = novoDoc();
    const r = novo({ franquiaAndaSozinha: false });
    r.franquia = { unidade: 'Açailândia', franquia: true, paciente: null };
    const t = D.cartao(doc, r, {}, AGORA).querySelector('[data-papel="sem-cadastro"]').textContent;
    assert.doesNotMatch(t, /anda sozinho/);
  });

  it('servidor de hoje (sem o campo): o texto de sempre ("anda sozinha")', () => {
    const doc = novoDoc();
    const n = D.cartao(doc, ACHADO, {});
    assert.match(n.querySelector('[data-papel="etapa-atual"]').textContent, /Anda sozinha pela franquia/);
  });
});

describe('0.5.1 — textos da unidade sem IA', () => {
  const vista = (ritmo) => ({ item: { leadId: 1, nome: 'Paciente 1', etapa: 'EM ESPERA', telefone: '5599900000001', telefoneVisivel: '(99) 90000-0001' }, fase: 'aberto', posicao: 1, total: 3, pulados: [], naoLidos: [], ritmo });

  it('modo ligação sem espera: "Sem espera entre uma ligação e outra", com o teto e o porquê — nunca "a cada 0 s"', () => {
    const doc = novoDoc();
    const t = D.modoLigacao(doc, vista({ intervaloS: 0, tetoPorHora: 40 }), {}).querySelector('[data-papel="ritmo"]').textContent;
    assert.equal(t, 'Sem espera entre uma ligação e outra · no máximo 40 por hora, para o número não parecer spam e ficar protegido.');
    assert.doesNotMatch(t, /a cada 0 s/);
  });

  it('modo ligação com espera configurada no servidor: o intervalo continua dito', () => {
    const doc = novoDoc();
    const t = D.modoLigacao(doc, vista({ intervaloS: 40, tetoPorHora: 30 }), {}).querySelector('[data-papel="ritmo"]').textContent;
    assert.equal(t, 'Uma conversa a cada 40 s · no máximo 30 por hora, para o número não parecer spam e ficar protegido.');
  });

  it('a busca manual aceita o telefone com DDD (só dígitos para o servidor); nome continua nome', () => {
    assert.equal(D.telefoneDaBusca('(24) 99999-1234'), '24999991234');
    assert.equal(D.telefoneDaBusca('+55 24 99999-1234'), '5524999991234');
    assert.equal(D.telefoneDaBusca('24 3333.1234'), '2433331234');
    assert.equal(D.telefoneDaBusca('99999-1234'), null, 'sem DDD não é telefone que dê para conferir');
    assert.equal(D.telefoneDaBusca('123.456.789-09'), null, 'CPF não é celular (o 3º dígito não é 9)');
    assert.equal(D.telefoneDaBusca('12345678909'), null);
    assert.equal(D.telefoneDaBusca('(02) 99999-1234'), null, 'DDD não tem zero');
    assert.equal(D.telefoneDaBusca('+1 555 123 4567'), '15551234567', 'de fora, com +');
    assert.equal(D.telefoneDaBusca('Maria 2024'), null);
    assert.equal(D.telefoneDaBusca('Maria Souza'), null);
    assert.equal(D.telefoneDaBusca(''), null);
    const doc = novoDoc();
    const buscas = [];
    const n = D.nada(doc, { achado: false }, { buscar: (t) => buscas.push(t) }, '');
    const campo = n.querySelector('.busca__campo');
    assert.match(campo.placeholder, /telefone/);
    assert.match(n.textContent, /nome ou pelo telefone/);
    campo.value = ' (24) 99999-1234 ';
    n.querySelector('form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
    assert.deepEqual(buscas, ['(24) 99999-1234'], 'o painel decide: telefone ou nome');

    // sem o DDD: a busca pelo nome nunca acharia — pede o DDD e não busca
    campo.value = '99999-1234';
    n.querySelector('form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
    assert.deepEqual(buscas, ['(24) 99999-1234'], 'não buscou');
    assert.match(n.querySelector('[data-papel="msg-busca"]').textContent, /com o DDD/);
  });

  it('"Sem cadastro na franquia": não achar não é não existir — confere antes de cadastrar de novo', () => {
    const doc = novoDoc();
    const r = novo();
    r.franquia = { unidade: 'Açailândia', franquia: true, paciente: null };
    const t = D.cartao(doc, r, {}, AGORA).querySelector('[data-papel="sem-cadastro"]').textContent;
    assert.match(t, /A franquia não achou este paciente/);
    assert.match(t, /Se ele já tem cadastro com outro nome ou telefone, confira na franquia antes/);
  });
});

describe('0.5.1 — Observações (vira nota no cartão)', () => {
  const montarCartao = (acoes) => {
    const doc = novoDoc();
    return { doc, n: D.cartao(doc, novo(), acoes, AGORA) };
  };

  it('sem a ação de salvar (painel antigo): a caixa não aparece', () => {
    assert.equal(montarCartao({}).n.querySelector('[data-bloco="observacao"]'), null);
  });

  it('vazia, longa demais ou com HTML: não salva, e diz por quê', () => {
    const salvas = [];
    const { doc, n } = montarCartao({ salvarObservacao: (id, t) => { salvas.push(t); return Promise.resolve(); } });
    const campo = n.querySelector('[data-papel="observacao"]');
    assert.equal(campo.maxLength, D.MAX_OBSERVACAO);
    const botao = n.querySelector('[data-acao="salvar-observacao"]');
    const msg = n.querySelector('[data-papel="msg-observacao"]');
    for (const [texto, erro] of [['   ', /Escreva a observação/], ['a'.repeat(2001), /passa de 2000 letras/], ['<b>urgente</b>', /HTML/]]) {
      campo.value = texto;
      botao.click();
      assert.match(msg.textContent, erro, texto.slice(0, 20));
      assert.equal(n.querySelector('[data-bloco="observacao"] [data-papel="previa"]'), null);
    }
    assert.deepEqual(salvas, []);
    assert.equal(D.problemaDaObservacao('dor < 5 e > 2'), null, 'sinal de menor não é HTML');
    assert.equal(D.problemaDaObservacao('Dor entre <L4 e L5> há 2 meses'), null, 'texto entre < > que não é tag de HTML passa');
    assert.equal(D.problemaDaObservacao('pressão <alta>'), null);
    assert.ok(doc);
  });

  it('prévia com o prefixo e quem escreve; só "Gravar no Kommo" grava; deu certo: "Salvo no cartão." e caixa limpa', async () => {
    const salvas = [];
    const { n } = montarCartao({ quem: () => 'Ana', salvarObservacao: (id, t) => { salvas.push([id, t]); return Promise.resolve({ ok: true }); } });
    const campo = n.querySelector('[data-papel="observacao"]');
    campo.value = '  A filha acompanha.  ';
    n.querySelector('[data-acao="salvar-observacao"]').click();
    const previa = n.querySelector('[data-bloco="observacao"] [data-papel="previa"]');
    assert.match(previa.textContent, /^Vai gravar no cartão do Kommo \(uma nota\):Observação pela Ponte · Ana · \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:A filha acompanha\./);
    assert.match(previa.textContent, /Nada vai para o WhatsApp/);
    assert.equal(campo.disabled, true, 'a caixa trava durante a prévia');
    assert.deepEqual(salvas, []);
    previa.querySelector('[data-acao="confirmar"]').click();
    await tique();
    await tique();
    assert.deepEqual(salvas, [[123, 'A filha acompanha.']]);
    assert.equal(n.querySelector('[data-papel="observacao-ok"]').textContent, 'Salvo no cartão.');
    assert.equal(campo.value, '');
    assert.equal(campo.disabled, false);
  });

  it('a prévia mostra o texto JÁ limpo, como o servidor grava, e é esse que vai', async () => {
    const salvas = [];
    const { n } = montarCartao({ salvarObservacao: (id, t) => { salvas.push(t); return Promise.resolve(); } });
    const campo = n.querySelector('[data-papel="observacao"]');
    campo.value = 'Mãe acompanha.\r\n\r\n\r\n\tPrefere tarde.   ';
    n.querySelector('[data-acao="salvar-observacao"]').click();
    const linhas = [...n.querySelectorAll('[data-bloco="observacao"] [data-papel="previa"] li')].map((li) => li.textContent);
    assert.equal(linhas[1], 'Mãe acompanha.\n\n Prefere tarde.');
    n.querySelector('[data-bloco="observacao"] [data-acao="confirmar"]').click();
    await tique();
    assert.deepEqual(salvas, ['Mãe acompanha.\n\n Prefere tarde.']);
    assert.equal(D.limparObservacao('a\n\n\n\nb'), 'a\n\nb');
  });

  it('gravando: "Voltar e corrigir" trava; voltou depois de um erro: o aviso velho sai', async () => {
    let terminar;
    const { n } = montarCartao({ salvarObservacao: () => new Promise((ok, falha) => { terminar = falha; }) });
    const campo = n.querySelector('[data-papel="observacao"]');
    campo.value = 'Prefere tarde.';
    n.querySelector('[data-acao="salvar-observacao"]').click();
    n.querySelector('[data-bloco="observacao"] [data-acao="confirmar"]').click();
    await tique();
    const voltar = n.querySelector('[data-acao="voltar-previa"]');
    assert.equal(voltar.disabled, true, 'não dá para voltar enquanto grava');
    terminar(new Error('O Kommo recusou a nota agora: tente de novo.'));
    await tique();
    await tique();
    assert.equal(voltar.disabled, false, 'falhou: dá para voltar e corrigir');
    assert.match(n.querySelector('[data-papel="msg-observacao"]').textContent, /recusou/);
    voltar.click();
    assert.equal(n.querySelector('[data-papel="msg-observacao"]').textContent, '');
    assert.equal(campo.value, 'Prefere tarde.');
  });

  it('"Voltar e corrigir" não grava; erro do servidor aparece e o texto fica', async () => {
    let falhar = true;
    const { n } = montarCartao({ salvarObservacao: () => (falhar ? Promise.reject(new Error('Disponível depois da atualização do servidor.')) : Promise.resolve()) });
    const campo = n.querySelector('[data-papel="observacao"]');
    campo.value = 'Prefere tarde.';
    n.querySelector('[data-acao="salvar-observacao"]').click();
    n.querySelector('[data-acao="voltar-previa"]').click();
    assert.equal(n.querySelector('[data-bloco="observacao"] [data-papel="previa"]'), null);
    assert.equal(campo.disabled, false);
    n.querySelector('[data-acao="salvar-observacao"]').click();
    n.querySelector('[data-bloco="observacao"] [data-acao="confirmar"]').click();
    await tique();
    await tique();
    assert.equal(n.querySelector('[data-papel="msg-observacao"]').textContent, 'Disponível depois da atualização do servidor.');
    assert.equal(campo.value, 'Prefere tarde.');
    falhar = false;
  });

  it('o rascunho guardado volta na caixa; o dado entra como texto, nunca como HTML', () => {
    const guardados = [];
    const { n } = montarCartao({ salvarObservacao: () => Promise.resolve(), lerObservacao: (id) => (id === 123 ? 'rascunho <img src=x>' : ''), guardarObservacao: (id, t) => guardados.push([id, t]) });
    const campo = n.querySelector('[data-papel="observacao"]');
    assert.equal(campo.value, 'rascunho <img src=x>');
    campo.value = 'novo';
    campo.dispatchEvent(new campo.ownerDocument.defaultView.Event('input'));
    assert.deepEqual(guardados, [[123, 'novo']]);
    assert.equal(n.querySelector('img'), null);
  });
});

