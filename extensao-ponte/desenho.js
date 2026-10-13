/**
 * Ponte — desenha o painel a partir da resposta do servidor. Só monta DOM com `textContent` (nunca
 * innerHTML com dado de fora). Sem chrome.* aqui: o teste roda isto no jsdom.
 *
 * Fase 2: o bloco "Resumo" no topo do cartão (com "Resumir com IA"), o bloco "Pausar a Sofia neste paciente"
 * e a aba "Fila de hoje". Toda ação (pausar, retomar, resumir, abrir conversa, copiar) é uma função de
 * `acoes` que devolve uma promessa: quem fala com o servidor e com as abas é o `painel.js`.
 */
(function (raiz, fabrica) {
  var pausa = typeof module === 'object' && module.exports ? require('./pausa.js') : raiz.PontePausa;
  var api = fabrica(pausa);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteDesenho = api;
})(typeof self !== 'undefined' ? self : this, function (P) {
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
    janela: 'pausada neste paciente',
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
    if (a.desligado) n.disabled = true;
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

  function hora(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  /** "há 5 min", "há 3 h", "há 2 dias" — a partir de um ISO do passado. */
  function relativo(iso, agora) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.floor(((agora || new Date()).getTime() - t) / 1000));
    if (s < 60) return 'agora há pouco';
    if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
    var dias = Math.floor(s / 86400);
    return dias === 1 ? 'há 1 dia' : 'há ' + dias + ' dias';
  }

  /**
   * O link que abre a conversa do telefone no WhatsApp Web. É NAVEGAÇÃO (o mesmo que clicar num link do
   * WhatsApp): não leva texto nenhum — a Ponte nunca escreve nem envia mensagem. Só dígitos, de 10 a 15.
   */
  function urlDaConversa(telefone) {
    var t = String(telefone == null ? '' : telefone);
    return /^\d{10,15}$/.test(t) ? 'https://web.whatsapp.com/send?phone=' + t : null;
  }

  function botaoAcao(doc, texto, acao, extra) {
    var a = { classe: 'botao botao--pequeno', tipo: 'button', dados: { acao: acao } };
    if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k]; });
    return el(doc, 'button', a, texto);
  }

  /** Liga um botão a uma ação que devolve promessa: trava enquanto roda, e o erro vai para `msg`. */
  function aoClicar(botao, msg, rodar, aoTerminar) {
    botao.addEventListener('click', function () {
      if (botao.disabled) return;
      botao.disabled = true;
      if (msg) msg.textContent = '';
      var p;
      try {
        p = Promise.resolve(rodar());
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(function (r) {
        botao.disabled = false;
        if (aoTerminar) aoTerminar(r);
      }, function (e) {
        botao.disabled = false;
        if (msg) msg.textContent = (e && e.message) || 'Não deu certo agora. Tente de novo.';
      });
    });
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

  // ── fase 2: o resumo do lead ──

  function preencherResumo(doc, lista, linhas) {
    lista.replaceChildren();
    (linhas || []).forEach(function (l) { lista.appendChild(el(doc, 'li', null, String(l))); });
  }

  var NOTA_DA_IA = 'Escrito pela IA a partir da conversa do Kommo: confira antes de usar.';

  /**
   * "Resumo": quem é, onde está, o que já aconteceu, a última conversa e o próximo passo — montado no servidor
   * SEM IA. O botão "Resumir com IA" só aparece se a unidade tem chave da IA; o resultado substitui as linhas
   * (e o painel guarda em `r.resumoIa`, para um redesenho não perder).
   */
  function resumo(doc, r, acoes) {
    var base = r.resumo;
    var ia = r.resumoIa;
    if (!base && !ia && !r.iaDisponivel) return null;
    var rotulo = el(doc, 'p', { classe: 'bloco__rotulo' }, ia && ia.ia ? 'Resumo (IA)' : 'Resumo');
    var lista = el(doc, 'ul', { classe: 'resumo__linhas' });
    preencherResumo(doc, lista, ia ? ia.linhas : base ? base.linhas : []);
    var passo = !ia && base && base.proximoPasso
      ? el(doc, 'p', { classe: 'resumo__passo' }, el(doc, 'strong', null, 'Próximo passo: '), base.proximoPasso)
      : null;
    var nota = el(doc, 'p', { classe: 'nota', dados: { papel: 'nota-resumo' } }, ia ? ia.aviso || (ia.ia ? NOTA_DA_IA : '') : '');
    var botaoIa = null;
    if (r.iaDisponivel && !ia && acoes && acoes.resumirComIa) {
      botaoIa = botaoAcao(doc, 'Resumir com IA', 'resumir-ia');
      aoClicar(botaoIa, nota, function () {
        botaoIa.textContent = 'Resumindo…';
        return Promise.resolve(acoes.resumirComIa(r.cartao.id)).catch(function (e) {
          botaoIa.textContent = 'Resumir com IA';
          throw e;
        });
      }, function (res) {
        if (!res || !res.linhas) return;
        preencherResumo(doc, lista, res.linhas);
        if (passo) passo.remove();
        rotulo.textContent = res.ia ? 'Resumo (IA)' : 'Resumo';
        nota.textContent = res.aviso || (res.ia ? NOTA_DA_IA : '');
        botaoIa.remove();
      });
    }
    return el(doc, 'div', { classe: 'bloco bloco--resumo', dados: { bloco: 'resumo' } }, rotulo, lista, passo, nota, botaoIa);
  }

  // ── fase 2: pausar a Sofia neste paciente ──

  /** "Sofia pausada até 14/10 08:00 · reunião com a família · por Ana" */
  function textoDaPausa(p) {
    return ['Sofia pausada até ' + quando(p.ate), p.motivo, p.por && 'por ' + p.por].filter(Boolean).join(' · ');
  }

  function formularioDePausa(doc, leadId, acoes, msg, aoCancelar) {
    var agora = new Date();
    var opcoes = el(doc, 'fieldset', { classe: 'pausa__opcoes' }, el(doc, 'legend', null, 'Até quando?'));
    var data = el(doc, 'input', { classe: 'pausa__data', tipo: 'date' });
    data.min = P.dataMinima(agora);
    data.max = P.dataMaxima(agora);
    data.hidden = true;
    data.setAttribute('aria-label', 'Dia em que a Sofia volta (às 8h)');
    P.OPCOES.forEach(function (o, i) {
      var radio = el(doc, 'input', { tipo: 'radio', dados: { opcao: o.id } });
      radio.name = 'ponte-pausa-ate';
      radio.value = o.id;
      radio.checked = i === 0;
      radio.addEventListener('change', function () { data.hidden = o.id !== 'data'; });
      opcoes.appendChild(el(doc, 'label', { classe: 'pausa__opcao' }, radio, ' ' + o.rotulo));
    });
    var motivo = el(doc, 'input', { classe: 'pausa__motivo', tipo: 'text' });
    motivo.maxLength = 200;
    motivo.placeholder = 'Motivo (opcional)';
    motivo.setAttribute('aria-label', 'Motivo da pausa (opcional)');
    var enviar = el(doc, 'button', { classe: 'botao botao--alerta', tipo: 'submit' }, 'Pausar');
    var cancelar = botaoAcao(doc, 'Cancelar', 'cancelar-pausa');
    cancelar.addEventListener('click', aoCancelar);
    var form = el(doc, 'form', { classe: 'pausa__form', dados: { papel: 'form-pausa' } },
      opcoes, data, motivo, el(doc, 'div', { classe: 'pausa__botoes' }, enviar, cancelar));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (enviar.disabled) return;
      var marcada = form.querySelector('input[name="ponte-pausa-ate"]:checked');
      var fim = P.fimDaPausa(marcada ? marcada.value : null, new Date(), data.value);
      if (fim.erro) {
        msg.textContent = fim.erro;
        return;
      }
      enviar.disabled = true;
      msg.textContent = '';
      Promise.resolve(acoes.pausar(leadId, { ate: fim.ate.toISOString(), motivo: motivo.value.trim() || null })).then(
        function () { enviar.disabled = false; },
        function (e) {
          enviar.disabled = false;
          msg.textContent = (e && e.message) || 'Não consegui pausar agora.';
        });
    });
    return form;
  }

  /**
   * O bloco da pausa deste paciente: pausada → o texto com data, motivo e quem pausou + "Retomar agora";
   * caixinha marcada à mão pela SDR → só o aviso (a caixinha é dela); senão, o botão que abre as opções.
   */
  function blocoDaPausa(doc, r, acoes) {
    if (!acoes || !acoes.pausar) return null;
    var c = r.cartao;
    var sofia = c.sofia || {};
    var p = c.pausaDoLead;
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-pausa' } });
    var bloco = el(doc, 'div', { classe: 'bloco bloco--pausa', dados: { bloco: 'pausa' } });
    if (p && p.ate) {
      var retomar = botaoAcao(doc, 'Retomar agora', 'retomar');
      aoClicar(retomar, msg, function () { return acoes.retomar(c.id); });
      bloco.appendChild(el(doc, 'p', { classe: 'pausa__estado', dados: { papel: 'estado-pausa' } }, textoDaPausa(p)));
      bloco.appendChild(retomar);
    } else if (sofia.pausada && sofia.por === 'caixinha') {
      bloco.appendChild(el(doc, 'p', { classe: 'nota' },
        'A caixinha "Pausar IA" está marcada no cartão, sem data para voltar. Para a Sofia voltar, desmarque no Kommo.'));
    } else {
      var abrir = botaoAcao(doc, 'Pausar a Sofia neste paciente', 'abrir-pausa');
      var form = formularioDePausa(doc, c.id, acoes, msg, function () {
        form.hidden = true;
        abrir.hidden = false;
        msg.textContent = '';
      });
      form.hidden = true;
      abrir.addEventListener('click', function () {
        abrir.hidden = true;
        form.hidden = false;
      });
      bloco.appendChild(abrir);
      bloco.appendChild(form);
      if (acoes.semNome && acoes.semNome()) {
        bloco.appendChild(el(doc, 'p', { classe: 'nota' }, 'Dica: ponha seu nome nas opções da Ponte para aparecer quem pausou.'));
      }
    }
    bloco.appendChild(msg);
    return bloco;
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
      resumo(doc, r, acoes),
      barra(doc, c.barra),
      el(doc, 'div', { classe: 'bloco' },
        linha(doc, 'Responsável', c.responsavel || 'ninguém'),
        linha(doc, 'Sofia', textoSofia, sofia.pausada ? 'linha--alerta' : 'linha--ok'),
        origem(doc, c.anuncio),
        c.etiquetas && c.etiquetas.length
          ? el(doc, 'div', { classe: 'etiquetas' }, ...c.etiquetas.map(function (t) { return el(doc, 'span', { classe: 'etiqueta' }, t); }))
          : null),
      blocoDaPausa(doc, r, acoes),
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

  // ── fase 2: a fila do dia ──

  function itemDaFila(doc, it, acoes, agora) {
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-item' } });
    var temTelefone = !!urlDaConversa(it.telefone);
    var abrir = botaoAcao(doc, 'Abrir conversa', 'abrir-conversa', {
      desligado: !temTelefone,
      titulo: temTelefone ? 'Abre esta conversa no WhatsApp Web (não envia nada)' : 'Sem telefone no Kommo',
    });
    var copiar = botaoAcao(doc, 'Copiar telefone', 'copiar', { desligado: !temTelefone });
    if (temTelefone) {
      aoClicar(abrir, msg, function () { return acoes.abrirConversa(it.telefone); });
      aoClicar(copiar, msg, function () { return acoes.copiar(it.telefoneVisivel || it.telefone); }, function () {
        copiar.textContent = 'Copiado';
        setTimeout(function () { copiar.textContent = 'Copiar telefone'; }, 1500);
      });
    }
    return el(doc, 'li', { classe: 'fila__item', dados: { lead: String(it.leadId) } },
      el(doc, 'div', { classe: 'fila__linha' },
        el(doc, 'span', { classe: 'fila__nome' }, it.nome || 'Cartão ' + it.leadId),
        it.passado ? el(doc, 'span', { classe: 'fila__tempo' }, relativo(it.quando, agora)) : null),
      el(doc, 'p', { classe: 'fila__detalhe' }, [it.etapa, it.detalhe].filter(Boolean).join(' · ')),
      el(doc, 'p', { classe: 'fila__telefone' }, it.telefoneVisivel || 'sem telefone no Kommo'),
      el(doc, 'div', { classe: 'fila__botoes' }, abrir, copiar,
        it.link ? el(doc, 'a', { classe: 'botao botao--pequeno', href: it.link }, 'Abrir no Kommo') : null),
      msg);
  }

  /** A aba "Fila de hoje": um grupo por etapa do COMERCIAL, com contador, e os itens com os três botões. */
  function fila(doc, f, acoes, agora) {
    var grupos = (f && f.grupos) || [];
    var total = grupos.reduce(function (s, g) { return s + (g.total || 0); }, 0);
    var atualizar = botaoAcao(doc, 'Atualizar', 'atualizar-fila');
    atualizar.addEventListener('click', function () { if (acoes && acoes.atualizar) acoes.atualizar(); });
    var secao = el(doc, 'section', { classe: 'fila', dados: { estado: 'fila' } },
      el(doc, 'div', { classe: 'fila__topo' },
        el(doc, 'div', null,
          el(doc, 'p', { classe: 'aviso__titulo' }, 'Fila de hoje'),
          el(doc, 'p', { classe: 'nota' }, (total ? total + (total === 1 ? ' paciente' : ' pacientes') : 'Ninguém na fila') +
            (f && f.atualizadoEm ? ' · atualizada às ' + hora(f.atualizadoEm) : ''))),
        atualizar));
    grupos.forEach(function (g) {
      var itens = g.itens || [];
      var lista = el(doc, 'ul', { classe: 'fila__lista' });
      itens.forEach(function (it) { lista.appendChild(itemDaFila(doc, it, acoes, agora)); });
      secao.appendChild(el(doc, 'section', { classe: 'fila__grupo', dados: { grupo: g.id } },
        el(doc, 'h2', { classe: 'fila__titulo' },
          el(doc, 'span', { classe: 'fila__etapa' }, g.etapa),
          el(doc, 'span', { classe: 'fila__motivo' }, g.rotulo),
          el(doc, 'span', { classe: 'fila__contador', dados: { contador: g.id } }, String(g.total || 0))),
        g.aviso ? el(doc, 'p', { classe: 'nota nota--alerta' }, g.aviso) : null,
        itens.length ? lista : el(doc, 'p', { classe: 'nota' }, 'Ninguém agora.'),
        g.total > itens.length ? el(doc, 'p', { classe: 'nota' }, 'Mostrando ' + itens.length + ' de ' + g.total + '. Os outros estão no Kommo.') : null));
    });
    return secao;
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

  return Object.freeze({
    aviso: aviso,
    cartao: cartao,
    candidatos: candidatos,
    nada: nada,
    aprendiz: aprendiz,
    fila: fila,
    urlDaConversa: urlDaConversa,
    relativo: relativo,
    textoDaPausa: textoDaPausa,
    COMO: COMO,
  });
});
