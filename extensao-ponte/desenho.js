/**
 * Ponte — desenha o painel a partir da resposta do servidor. Só monta DOM com `textContent` (nunca
 * innerHTML com dado de fora). Sem chrome.* aqui: o teste roda isto no jsdom.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteDesenho = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COMO = {
    telefone: { rotulo: 'achei pelo telefone', nivel: 'forte' },
    impressao: { rotulo: 'achei pelas mensagens', nivel: 'forte' },
    nome: { rotulo: 'achei pelo nome — confira', nivel: 'fraco' },
    manual: { rotulo: 'escolhido por você', nivel: 'forte' },
  };

  var PAUSA_POR = {
    unidade: 'pausada na unidade inteira',
    horario: 'quieta agora (fora do horário em que ela atende)',
    caixinha: 'pausada neste cartão (caixinha "Pausar IA")',
    janela: 'pausada neste cartão',
  };

  /** el(doc, 'div', { classe: 'x', titulo: 'y' }, filho, 'texto', …) */
  function el(doc, tag, attrs) {
    var n = doc.createElement(tag);
    var a = attrs || {};
    if (a.classe) n.className = a.classe;
    if (a.titulo) n.title = a.titulo;
    if (a.href) {
      n.href = a.href;
      n.target = '_blank';
      n.rel = 'noopener noreferrer';
    }
    if (a.tipo) n.type = a.tipo;
    if (a.dados) Object.keys(a.dados).forEach(function (k) { n.setAttribute('data-' + k, a.dados[k]); });
    for (var i = 3; i < arguments.length; i++) {
      var f = arguments[i];
      if (f == null || f === false) continue;
      n.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f);
    }
    return n;
  }

  function quando(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /** Caixa de aviso simples: procurando, sem conversa, grupo, erro, configurar. */
  function aviso(doc, tipo, titulo, texto) {
    return el(doc, 'section', { classe: 'aviso aviso--' + tipo, dados: { estado: tipo } },
      el(doc, 'p', { classe: 'aviso__titulo' }, titulo),
      texto ? el(doc, 'p', { classe: 'aviso__texto' }, texto) : null);
  }

  // GANHO e PERDIDO: as duas saídas do funil, iguais em toda conta do Kommo
  var GANHO = 142, PERDIDO = 143;

  function barra(doc, b) {
    if (!b || !b.etapas || !b.etapas.length) return null;
    var atual = -1;
    b.etapas.forEach(function (e, i) { if (e.atual) atual = i; });
    // "Feita" é só etapa do caminho antes da atual. As saídas (GANHO/PERDIDO) nunca são "feitas", e um cartão
    // PERDIDO não diz até onde chegou — nada se pinta como feito.
    var perdido = atual >= 0 && b.etapas[atual].id === PERDIDO;
    var trilho = el(doc, 'ol', { classe: 'barra', titulo: 'Funil ' + (b.funil || '') });
    b.etapas.forEach(function (e, i) {
      var saida = e.id === GANHO || e.id === PERDIDO;
      var feita = !perdido && !saida && i < atual;
      var classe = 'barra__etapa' + (i === atual ? ' barra__etapa--atual' : feita ? ' barra__etapa--feita' : '');
      trilho.appendChild(el(doc, 'li', { classe: classe, titulo: e.nome }, el(doc, 'span', { classe: 'barra__nome' }, e.nome)));
    });
    return el(doc, 'div', { classe: 'bloco' },
      el(doc, 'p', { classe: 'bloco__rotulo' }, 'Funil ' + (b.funil || 'COMERCIAL')),
      trilho,
      b.noFunil ? null : el(doc, 'p', { classe: 'nota' }, 'Este cartão não está no funil ' + (b.funil || 'COMERCIAL') + '.'));
  }

  function linha(doc, rotulo, valor, classe) {
    if (!valor) return null;
    return el(doc, 'div', { classe: 'linha' + (classe ? ' ' + classe : '') },
      el(doc, 'span', { classe: 'linha__rotulo' }, rotulo),
      el(doc, 'span', { classe: 'linha__valor' }, valor));
  }

  function franquia(doc, f) {
    if (!f || f.franquia === false) return null;
    var corpo = [];
    if (f.erro) corpo.push(el(doc, 'p', { classe: 'nota' }, 'A franquia não respondeu agora.'));
    else if (!f.paciente) corpo.push(el(doc, 'p', { classe: 'nota' }, 'Paciente não encontrado na franquia.'));
    else {
      var ag = f.agenda || {};
      var p = ag.proximaConsulta;
      if (p) {
        corpo.push(linha(doc, 'Consulta marcada', [p.dia, p.hora && 'às ' + p.hora].filter(Boolean).join(' ') +
          (p.status ? ' · ' + p.status : '') + (p.fisioterapeuta ? ' · ' + p.fisioterapeuta : ''), 'linha--ok'));
      } else {
        corpo.push(linha(doc, 'Consulta marcada', 'nenhuma', 'linha--alerta'));
      }
      var u = ag.ultimaConsulta;
      if (u) corpo.push(linha(doc, 'Última consulta', [u.dia, u.status].filter(Boolean).join(' · ')));
      if (ag.proximaSessao) corpo.push(linha(doc, 'Próxima sessão', [ag.proximaSessao.dia, ag.proximaSessao.hora].filter(Boolean).join(' às ')));
      if (f.tratamento) corpo.push(linha(doc, 'Tratamento', [f.tratamento.status, f.tratamento.categoria].filter(Boolean).join(' · ')));
      if (f.duplicadoNaFranquia) corpo.push(el(doc, 'p', { classe: 'nota nota--alerta' }, 'A franquia tem este paciente em dois cadastros.'));
    }
    return el(doc, 'div', { classe: 'bloco', dados: { bloco: 'franquia' } }, el(doc, 'p', { classe: 'bloco__rotulo' }, 'Franquia'), ...corpo.filter(Boolean));
  }

  function origem(doc, a) {
    if (!a) return null;
    var partes = [a.titulo && '"' + a.titulo + '"', a.campanha, a.plataforma].filter(Boolean);
    return linha(doc, 'Veio de', partes.length ? partes.join(' · ') : a.origem || a.anuncio);
  }

  function listaDeCartoes(doc, lista, acoes, classe) {
    var ul = el(doc, 'ul', { classe: classe || 'lista' });
    lista.forEach(function (c) {
      var botao = el(doc, 'button', { classe: 'lista__botao', tipo: 'button', dados: { lead: String(c.id) } },
        el(doc, 'span', { classe: 'lista__nome' }, c.nome || 'Cartão ' + c.id),
        el(doc, 'span', { classe: 'lista__etapa' }, [c.funil, c.etapa].filter(Boolean).join(' › ')));
      botao.addEventListener('click', function () { if (acoes && acoes.escolher) acoes.escolher(c.id); });
      ul.appendChild(el(doc, 'li', null, botao));
    });
    return ul;
  }

  /** Cartão achado. */
  function cartao(doc, r, acoes) {
    var c = r.cartao;
    var como = COMO[r.como] || { rotulo: r.como, nivel: 'fraco' };
    var sofia = c.sofia || {};
    var textoSofia = sofia.pausada ? (PAUSA_POR[sofia.por] || 'pausada') + (sofia.ate ? ' até ' + quando(sofia.ate) : '') : 'ativa';

    return el(doc, 'section', { classe: 'cartao', dados: { estado: 'achado', lead: String(c.id) } },
      el(doc, 'div', { classe: 'cartao__topo' },
        el(doc, 'span', { classe: 'chip chip--' + como.nivel, dados: { como: r.como } }, como.rotulo),
        c.fechado ? el(doc, 'span', { classe: 'chip chip--fechado' }, 'fechado') : null),
      el(doc, 'h1', { classe: 'cartao__nome' }, c.nome || 'Cartão ' + c.id),
      el(doc, 'p', { classe: 'cartao__etapa' }, [c.funil, c.etapa].filter(Boolean).join(' › ')),
      barra(doc, c.barra),
      el(doc, 'div', { classe: 'bloco' },
        linha(doc, 'Responsável', c.responsavel || 'ninguém'),
        linha(doc, 'Sofia', textoSofia, sofia.pausada ? 'linha--alerta' : 'linha--ok'),
        origem(doc, c.anuncio),
        c.etiquetas && c.etiquetas.length
          ? el(doc, 'div', { classe: 'etiquetas' }, ...c.etiquetas.map(function (t) { return el(doc, 'span', { classe: 'etiqueta' }, t); }))
          : null),
      franquia(doc, r.franquia),
      el(doc, 'a', { classe: 'botao botao--primario', href: c.link }, 'Abrir no Kommo'),
      r.outrosCartoes && r.outrosCartoes.length
        ? el(doc, 'div', { classe: 'bloco' }, el(doc, 'p', { classe: 'bloco__rotulo' }, 'Outros cartões deste paciente'), listaDeCartoes(doc, r.outrosCartoes, acoes))
        : null);
  }

  /** Vários contatos com o mesmo nome (ou o mesmo número dividido pela família): a atendente escolhe. */
  function candidatos(doc, r, acoes) {
    return el(doc, 'section', { classe: 'candidatos', dados: { estado: 'candidatos', como: r.como || '' } },
      el(doc, 'p', { classe: 'aviso__titulo' }, r.como === 'telefone'
        ? 'Este número tem mais de um contato no Kommo'
        : 'Achei mais de um cartão com esse nome'),
      el(doc, 'p', { classe: 'aviso__texto' }, 'Qual é o desta conversa?'),
      listaDeCartoes(doc, r.candidatos, acoes),
      buscaManual(doc, acoes));
  }

  function buscaManual(doc, acoes, valorInicial) {
    var campo = el(doc, 'input', { classe: 'busca__campo', tipo: 'search' });
    campo.placeholder = 'Nome do paciente no Kommo';
    campo.value = valorInicial || '';
    campo.setAttribute('aria-label', 'Nome do paciente no Kommo');
    var form = el(doc, 'form', { classe: 'busca' }, campo, el(doc, 'button', { classe: 'botao', tipo: 'submit' }, 'Buscar'));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var t = campo.value.trim();
      if (t && acoes && acoes.buscar) acoes.buscar(t);
    });
    return form;
  }

  /** Nada achado: a busca manual. */
  function nada(doc, r, acoes, nomeDaConversa) {
    return el(doc, 'section', { classe: 'nada', dados: { estado: 'nada' } },
      el(doc, 'p', { classe: 'aviso__titulo' }, 'Não achei o cartão desta conversa'),
      el(doc, 'p', { classe: 'aviso__texto' }, r && r.incompleto
        ? 'O Kommo não respondeu a tudo agora. Tente buscar pelo nome:'
        : 'Busque pelo nome do paciente:'),
      buscaManual(doc, acoes, nomeDaConversa));
  }

  /** O bloco "Modo aprendiz" — estático na fase 1; a fase 3 decide qual dica mostrar e quando. */
  function aprendiz(doc, dicas) {
    if (!dicas || !dicas.length) return null;
    var ul = el(doc, 'ul', { classe: 'aprendiz__lista' });
    dicas.forEach(function (d) {
      ul.appendChild(el(doc, 'li', { classe: 'aprendiz__dica', dados: { dica: d.id } },
        el(doc, 'span', { classe: 'aprendiz__titulo' }, d.titulo),
        el(doc, 'span', { classe: 'aprendiz__onde' }, d.onde)));
    });
    return el(doc, 'details', { classe: 'aprendiz' }, el(doc, 'summary', null, 'Modo aprendiz — onde fica no Kommo'), ul);
  }

  return Object.freeze({ aviso: aviso, cartao: cartao, candidatos: candidatos, nada: nada, aprendiz: aprendiz, COMO: COMO });
});
