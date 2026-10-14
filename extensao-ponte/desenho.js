/**
 * Ponte — desenha o painel a partir da resposta do servidor. Só monta DOM com `textContent` (nunca
 * innerHTML com dado de fora). Sem chrome.* aqui: o teste roda isto no jsdom.
 *
 * Fase 2: o bloco "Resumo" no topo do cartão (com "Resumir com IA"), o bloco "Pausar a Sofia neste paciente"
 * e a aba "Fila de hoje". Toda ação (pausar, retomar, resumir, abrir conversa, copiar) é uma função de
 * `acoes` que devolve uma promessa: quem fala com o servidor e com as abas é o `painel.js`.
 *
 * Fase 3: as etiquetas do cartão (chips com ✕ e "+ etiqueta"), a faixa de cartão duplicado, o modo
 * "Começar a ligar" da fila e a aba "Respostas" (só copiar).
 *
 * Fase 4 (0.4.0): o botão "O que eu faço agora?" no cartão e o GUIA (`guia`): a unidade (Petrópolis × Caxias) primeiro,
 * a ⚠ Pendência, o que falta nesta etapa (com os campos para preencher e a prévia antes de gravar) e as saídas da
 * etapa (com o que falta em cada uma, o aviso dos robôs e a confirmação antes de mover).
 *
 * 0.5.0 (visual novo): o cartão vira um painel de leitura rápida — cabeçalho (paciente, telefone, selo da UNIDADE,
 * qualificação e como foi achado), a TRILHA do funil com a etapa acesa e o tempo nela (azul = é sua; dourado = anda
 * sozinha pela franquia, as duas cores do logo da Doutor Digital), "O que é seu agora" × "O que é da franquia", o
 * cartão "Na franquia" (consulta, última consulta, tratamento, sessões e alta) e, na aba Respostas, as sugeridas para a
 * etapa. Ícones em SVG desenhado aqui (`icones.js`); as regras da etapa ficam em `trilha.js`.
 */
(function (raiz, fabrica) {
  var cjs = typeof module === 'object' && module.exports;
  var api = fabrica(
    cjs ? require('./pausa.js') : raiz.PontePausa,
    cjs ? require('./etiquetas.js') : raiz.PonteEtiquetas,
    cjs ? require('./ligacao.js') : raiz.PonteLigacao,
    cjs ? require('./respostas.js') : raiz.PonteRespostas,
    cjs ? require('./guia.js') : raiz.PonteGuia,
    cjs ? require('./trilha.js') : raiz.PonteTrilha,
    cjs ? require('./icones.js') : raiz.PonteIcones,
  );
  if (cjs) module.exports = api;
  else raiz.PonteDesenho = api;
})(typeof self !== 'undefined' ? self : this, function (P, E, L, R, G, T, Ic) {
  'use strict';

  var COMO = {
    telefone: { rotulo: 'achei pelo telefone', nivel: 'forte', icone: 'telefone' },
    impressao: { rotulo: 'achei pelas mensagens', nivel: 'forte', icone: 'mensagem' },
    nome: { rotulo: 'achei pelo nome — confira', nivel: 'fraco', icone: 'lupa' },
    manual: { rotulo: 'escolhido por você', nivel: 'forte', icone: 'escolhido' },
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
    var icone = extra && extra.icone;
    if (extra) Object.keys(extra).forEach(function (k) { if (k !== 'icone') a[k] = extra[k]; });
    return el(doc, 'button', a, icone ? ic(doc, icone) : null, texto);
  }

  /** O ícone (SVG decorativo). */
  function ic(doc, nome, classe) {
    return Ic.icone(doc, nome, classe);
  }

  /** O rótulo pequeno em caixa alta que abre cada bloco, com o ícone dele. */
  function rotulo(doc, icone, texto, classe) {
    return el(doc, 'p', { classe: 'rotulo' + (classe ? ' ' + classe : '') }, icone ? ic(doc, icone) : null, el(doc, 'span', null, texto));
  }

  /** "MARIA SOUZA 03/10/2026" → "MS" (as iniciais do avatar; só letras). */
  function iniciais(nome) {
    var p = String(nome == null ? '' : nome).replace(/[^A-Za-zÀ-ÖØ-öø-ÿ\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return (p[0].charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }

  function avatar(doc, nome, classe) {
    var a = el(doc, 'span', { classe: 'avatar' + (classe ? ' ' + classe : '') }, iniciais(nome));
    a.setAttribute('aria-hidden', 'true');
    return a;
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

  var ICONE_DO_AVISO = { erro: 'alerta', configurar: 'cadeado', 'sem-whatsapp': 'mensagem', 'sem-conversa': 'mensagem', grupo: 'pessoa' };

  /** Caixa de aviso simples: procurando, sem conversa, grupo, erro, configurar. */
  function aviso(doc, tipo, titulo, texto) {
    var icone = ICONE_DO_AVISO[tipo];
    return el(doc, 'section', { classe: 'aviso aviso--' + tipo, dados: { estado: tipo } },
      icone ? el(doc, 'span', { classe: 'aviso__icone' }, ic(doc, icone)) : null,
      el(doc, 'p', { classe: 'aviso__titulo' }, titulo),
      texto ? el(doc, 'p', { classe: 'aviso__texto' }, texto) : null);
  }

  function linha(doc, rotuloTexto, valor, classe, icone) {
    if (!valor) return null;
    return el(doc, 'div', { classe: 'linha' + (classe ? ' ' + classe : '') },
      el(doc, 'span', { classe: 'linha__rotulo' }, icone ? ic(doc, icone) : null, rotuloTexto),
      el(doc, 'span', { classe: 'linha__valor' }, valor));
  }

  /** Pílula de estado: bom (verde), ruim (vermelho), atencao (âmbar), info (azul), neutro (cinza). */
  function pilula(doc, texto, nivel, icone) {
    return el(doc, 'span', { classe: 'pilula pilula--' + (nivel || 'neutro') }, icone ? ic(doc, icone) : null, texto);
  }

  // ── 0.5.0: o cabeçalho do paciente ──

  /**
   * Nome, telefone, o selo da UNIDADE (o ⌂ Unidade de atendimento; vazio na conta de duas unidades = "Escolha a
   * unidade", que abre o guia — é o 1º passo dele), a qualificação e como o cartão foi achado.
   */
  function cabecalho(doc, r, acoes) {
    var c = r.cartao;
    var como = COMO[r.como] || { rotulo: r.como, nivel: 'fraco', icone: 'lupa' };
    var u = T.unidadeDoCartao(c, r.franquia);
    var q = T.qualificacao(c.qualificacao);
    var selos = el(doc, 'div', { classe: 'selos' });
    if (u && u.vazia) {
      var escolher = el(doc, 'button', { classe: 'selo selo--vazia', tipo: 'button', dados: { acao: 'escolher-unidade', papel: 'unidade' }, titulo: 'O campo ⌂ Unidade de atendimento está vazio' },
        ic(doc, 'casa'), 'Escolha a unidade');
      if (acoes && acoes.abrirGuia) escolher.addEventListener('click', function () { acoes.abrirGuia(c.id); });
      else escolher.disabled = true;
      selos.appendChild(escolher);
    } else if (u && u.nome) {
      selos.appendChild(el(doc, 'span', { classe: 'selo selo--unidade selo--' + u.cor, dados: { papel: 'unidade' }, titulo: u.compartilhada ? '⌂ Unidade de atendimento' : 'Unidade' },
        ic(doc, 'casa'), u.nome));
    }
    if (q) selos.appendChild(el(doc, 'span', { classe: 'selo selo--' + q.nivel, dados: { papel: 'qualificacao' }, titulo: '★ Qualificação' }, ic(doc, q.icone), q.rotulo));
    selos.appendChild(el(doc, 'span', { classe: 'chip chip--' + como.nivel, dados: { como: r.como }, titulo: 'Como a Ponte achou este cartão' }, ic(doc, como.icone), como.rotulo));
    if (c.fechado) selos.appendChild(el(doc, 'span', { classe: 'chip chip--fechado' }, 'fechado'));
    return el(doc, 'header', { classe: 'paciente', dados: { bloco: 'paciente' } },
      el(doc, 'div', { classe: 'paciente__topo' },
        avatar(doc, c.nome),
        el(doc, 'div', { classe: 'paciente__quem' },
          el(doc, 'h1', { classe: 'cartao__nome' }, c.nome || 'Cartão ' + c.id),
          c.telefone ? el(doc, 'p', { classe: 'paciente__telefone', dados: { papel: 'telefone' } }, ic(doc, 'telefone'), c.telefone) : null)),
      selos);
  }

  // ── 0.5.0: a trilha do funil (a etapa acesa, o tempo nela e quem faz o cartão andar) ──

  function marcaDoDono(doc, dono) {
    var m = el(doc, 'span', { classe: 'marca marca--' + (dono || 'neutra') });
    m.setAttribute('aria-hidden', 'true');
    return m;
  }

  /** Como se lê o dono da etapa no título e para o leitor de tela. */
  function textoDoDono(dono, semRobo) {
    if (dono === 'franquia') return semRobo ? 'a recepção atualiza pela franquia' : 'anda sozinha pela franquia';
    return dono === 'voce' ? 'é sua' : '';
  }

  /** A linha de estações. `lista` = `T.estacoes(barra)`. */
  function linhaDeEstacoes(doc, lista, funil, semRobo) {
    // funil curto (o TRATAMENTO tem 3 etapas): cabe o nome embaixo de cada estação
    var rotulada = lista.length <= 4;
    var ol = el(doc, 'ol', { classe: 'trilha__linha' + (rotulada ? ' trilha__linha--rotulada' : ''), dados: { papel: 'linha' } });
    ol.setAttribute('aria-label', 'Etapas do funil ' + (funil || ''));
    var antes = null;
    lista.forEach(function (e) {
      var classe = 'estacao estacao--' + (e.dono || 'neutra') + ' estacao--' + e.estado +
        (e.saida ? ' estacao--saida' : '') + (e.saida && antes && !antes.saida ? ' estacao--primeira-saida' : '');
      var dono = textoDoDono(e.dono, semRobo);
      ol.appendChild(el(doc, 'li', { classe: classe, titulo: e.nome + (dono ? ' · ' + dono : ''), dados: { etapa: String(e.id) } },
        el(doc, 'span', { classe: 'estacao__marca' }),
        rotulada ? el(doc, 'span', { classe: 'estacao__nome' }, e.nome) : null,
        el(doc, 'span', { classe: 'sr' }, e.nome + (e.estado === 'atual' ? ' (etapa atual)' : '') + (dono ? ', ' + dono : ''))));
      antes = e;
    });
    return ol;
  }

  /** "Ver as 10 etapas": a lista com o nome de cada uma e de quem é. */
  function todasAsEtapas(doc, lista, funil) {
    var ol = el(doc, 'ol', { classe: 'todas' });
    lista.forEach(function (e) {
      ol.appendChild(el(doc, 'li', { classe: 'todas__item todas__item--' + e.estado },
        marcaDoDono(doc, e.dono),
        el(doc, 'span', { classe: 'todas__nome' }, e.nome),
        e.estado === 'atual' ? el(doc, 'span', { classe: 'todas__aqui' }, 'está aqui') : null,
        el(doc, 'span', { classe: 'todas__dono' }, e.dono === 'franquia' ? 'franquia' : e.dono === 'voce' ? 'sua' : '')));
    });
    return el(doc, 'details', { classe: 'trilha__todas' },
      el(doc, 'summary', null, 'Ver as ' + lista.length + ' etapas', ic(doc, 'abaixo')),
      ol);
  }

  /** O nome e o dono da etapa atual: da trilha, ou (cartão fora dela) do próprio cartão. */
  function etapaAtual(c) {
    var b = c.barraTratamento && c.barraTratamento.noFunil ? c.barraTratamento : c.barra;
    var atual = ((b && b.etapas) || []).filter(function (e) { return e.atual; })[0];
    return atual ? atual.nome : c.etapa || null;
  }

  /**
   * A trilha: a linha do funil (COMERCIAL; no TRATAMENTO, a do TRATAMENTO — `c.barraTratamento`), a etapa atual em
   * destaque com o tempo nela (`c.naEtapaDesde`) e de quem ela é, o que vem depois, a legenda e a lista completa.
   */
  function trilha(doc, r, agora) {
    var c = r.cartao;
    var trat = c.barraTratamento && c.barraTratamento.etapas && c.barraTratamento.etapas.length ? c.barraTratamento : null;
    var noTratamento = !!(trat && trat.noFunil);
    // servidor de hoje (sem a trilha do TRATAMENTO) com o cartão no TRATAMENTO: a linha do COMERCIAL não diz nada
    var tratamentoSemTrilha = !noTratamento && c.barra && c.barra.noFunil === false && /tratamento/.test(T.normalizar(c.funil));
    var b = noTratamento ? trat : tratamentoSemTrilha ? null : c.barra;
    var lista = T.estacoes(b);
    var funil = tratamentoSemTrilha ? c.funil : (b && b.funil) || c.funil || 'COMERCIAL';
    var nome = etapaAtual(c);
    var dono = T.donoDaEtapa(nome);
    var tempo = T.tempoNaEtapa(c.naEtapaDesde, agora);
    var atrasado = T.relogioAtrasado(nome, c.naEtapaDesde, agora);
    // 0.5.0: unidade com a movimentação pela franquia desligada — nada de prometer que o cartão anda sozinho
    var semRobo = r.franquiaAndaSozinha === false;
    var depois = T.depoisDaEtapa(nome, semRobo);
    var fora = !noTratamento && !tratamentoSemTrilha && b && b.noFunil === false;

    var aqui = el(doc, 'div', { classe: 'aqui aqui--' + (dono || 'neutra'), dados: { papel: 'etapa-atual', dono: dono || '' } },
      el(doc, 'div', { classe: 'aqui__topo' },
        dono ? el(doc, 'span', { classe: 'aqui__dono' }, ic(doc, dono === 'franquia' ? 'franquia' : 'pessoa'), T.rotuloDoDono(dono, semRobo)) : el(doc, 'span', { classe: 'aqui__dono' }, 'Etapa atual'),
        tempo ? el(doc, 'span', { classe: 'aqui__tempo' + (atrasado ? ' aqui__tempo--atrasado' : ''), titulo: 'Há quanto tempo o cartão está nesta etapa', dados: { papel: 'tempo-na-etapa' } }, ic(doc, 'relogio'), tempo) : null),
      el(doc, 'p', { classe: 'aqui__etapa' }, nome || 'Etapa desconhecida'),
      fora ? el(doc, 'p', { classe: 'aqui__depois' }, 'Este cartão não está no funil ' + (c.barra.funil || 'COMERCIAL') + ' (está em ' + [c.funil, c.etapa].filter(Boolean).join(' › ') + ').') : null,
      depois ? el(doc, 'p', { classe: 'aqui__depois' }, ic(doc, 'seta'), el(doc, 'span', null, depois)) : null);

    return el(doc, 'section', { classe: 'bloco-cartao trilha', dados: { bloco: 'trilha' } },
      el(doc, 'div', { classe: 'trilha__cab' },
        rotulo(doc, null, 'Onde está o cartão'),
        el(doc, 'span', { classe: 'trilha__funil' }, 'Funil ' + funil)),
      noTratamento || tratamentoSemTrilha ? el(doc, 'p', { classe: 'trilha__antes' }, ic(doc, 'check'), 'COMERCIAL concluído: o paciente fechou o tratamento') : null,
      lista.length ? linhaDeEstacoes(doc, lista, funil, semRobo) : null,
      aqui,
      el(doc, 'div', { classe: 'trilha__pe' },
        el(doc, 'div', { classe: 'legenda' },
          el(doc, 'span', { classe: 'legenda__item' }, marcaDoDono(doc, 'voce'), 'É sua'),
          el(doc, 'span', { classe: 'legenda__item' }, marcaDoDono(doc, 'franquia'), semRobo ? 'A recepção atualiza pela franquia' : 'Anda sozinha pela franquia')),
        lista.length ? todasAsEtapas(doc, lista, funil) : null));
  }

  // ── 0.5.0: "O que é seu agora" × "O que é da franquia" ──

  function blocoDoAgora(doc, r, acoes) {
    var c = r.cartao;
    var ag = r.franquia && r.franquia.agenda;
    var u = T.unidadeDoCartao(c, r.franquia);
    var semRobo = r.franquiaAndaSozinha === false;
    var lista = T.acoesDaEtapa(etapaAtual(c), {
      proximoPasso: r.resumo && r.resumo.proximoPasso,
      qualificacao: c.qualificacao,
      proximaSessao: ag && ag.proximaSessao,
      semRobo: semRobo,
    });
    // conta de duas unidades com o campo vazio: escolher a unidade vem antes de tudo (o guia trava o resto)
    if (u && u.vazia) lista = ['Escolher a unidade do paciente: sem ela, a Ponte não grava nem muda a etapa.'].concat(lista).slice(0, 3);
    var ul = el(doc, 'ul', { classe: 'agora__lista' });
    lista.forEach(function (t) { ul.appendChild(el(doc, 'li', { classe: 'agora__item' }, ic(doc, 'seta'), el(doc, 'span', null, t))); });
    var abrirGuia = null;
    if (acoes && acoes.abrirGuia) {
      abrirGuia = el(doc, 'button', { classe: 'botao botao--primario botao--guia', tipo: 'button', dados: { acao: 'abrir-guia' } },
        ic(doc, 'guia'), el(doc, 'span', null, 'O que eu faço agora?'), ic(doc, 'seta', 'icone--fim'));
      abrirGuia.addEventListener('click', function () { acoes.abrirGuia(c.id); });
    }
    // o que NÃO se faz no Kommo: a faixa dourada no pé do mesmo cartão (azul = seu; dourado = da franquia)
    return el(doc, 'section', { classe: 'bloco-cartao agora', dados: { bloco: 'agora' } },
      el(doc, 'div', { classe: 'agora__seu', dados: { bloco: 'seu-agora' } },
        rotulo(doc, 'pessoa', 'O que é seu agora', 'rotulo--voce'),
        lista.length ? ul : el(doc, 'p', { classe: 'nota' }, 'Nada pendente nesta etapa.'),
        abrirGuia),
      el(doc, 'div', { classe: 'agora__franquia', dados: { bloco: 'da-franquia' } },
        rotulo(doc, 'cadeado', 'O que é da franquia', 'rotulo--franquia'),
        el(doc, 'p', { classe: 'agora__regra' }, T.regraDaFranquia(semRobo))));
  }

  // ── 0.5.0: o cartão "Na franquia" ──

  function nivelDoTratamento(status) {
    var n = T.normalizar(status);
    if (/finaliz|conclu|alta/.test(n)) return 'bom';
    if (/cancel/.test(n)) return 'ruim';
    if (/pendent|aguard/.test(n)) return 'atencao';
    return 'info';
  }

  function blocoDaConsulta(doc, p, tz, agora) {
    var s = T.situacaoDaConsulta(p.status);
    var semana = T.diaDaSemana(p.quando, tz);
    var falta = T.diasAte(p.quando, agora, tz);
    return el(doc, 'div', { classe: 'consulta', dados: { papel: 'proxima-consulta' } },
      el(doc, 'div', { classe: 'consulta__data' },
        semana ? el(doc, 'span', { classe: 'consulta__semana' }, semana) : null,
        el(doc, 'span', { classe: 'consulta__dia' }, p.dia || '—')),
      el(doc, 'div', { classe: 'consulta__info' },
        el(doc, 'p', { classe: 'consulta__titulo' }, 'Próxima consulta', falta ? el(doc, 'span', { classe: 'consulta__falta' }, falta) : null),
        el(doc, 'p', { classe: 'consulta__hora' }, [p.hora, p.categoria].filter(Boolean).join(' · ') || 'Horário não informado'),
        el(doc, 'p', { classe: 'consulta__quem' },
          p.fisioterapeuta ? el(doc, 'span', null, p.fisioterapeuta) : null,
          s ? pilula(doc, s.rotulo, s.nivel) : null)));
  }

  /** As sessões do tratamento: feitas, faltas e marcadas numa barra só, e a próxima. */
  function blocoDasSessoes(doc, ag, tz, agora) {
    var s = (ag && ag.sessoes) || { realizadas: 0, faltas: 0, futuras: 0 };
    var total = (s.realizadas || 0) + (s.faltas || 0) + (s.futuras || 0);
    var barra = el(doc, 'div', { classe: 'sessoes__barra' });
    barra.setAttribute('role', 'img');
    barra.setAttribute('aria-label', s.realizadas + ' sessões feitas, ' + s.faltas + ' faltas, ' + s.futuras + ' marcadas');
    [['feita', s.realizadas], ['falta', s.faltas], ['marcada', s.futuras]].forEach(function (x) {
      if (!x[1]) return;
      var seg = el(doc, 'span', { classe: 'sessoes__seg sessoes__seg--' + x[0] });
      seg.style.flexGrow = String(x[1]);
      barra.appendChild(seg);
    });
    var ps = ag && ag.proximaSessao;
    var quando = ps ? [T.diaDaSemana(ps.quando, tz), ps.dia, ps.hora && 'às ' + ps.hora].filter(Boolean).join(' ') : null;
    var falta = ps ? T.diasAte(ps.quando, agora, tz) : null;
    return el(doc, 'div', { classe: 'sessoes', dados: { papel: 'sessoes' } },
      el(doc, 'div', { classe: 'sessoes__cab' },
        el(doc, 'span', { classe: 'sessoes__titulo' }, ic(doc, 'sessao'), 'Sessões'),
        el(doc, 'span', { classe: 'sessoes__total' }, total ? total + (total === 1 ? ' no tratamento' : ' no tratamento') : 'nenhuma ainda')),
      total ? barra : null,
      el(doc, 'p', { classe: 'sessoes__numeros' },
        el(doc, 'span', { classe: 'n n--feita' }, el(doc, 'b', null, String(s.realizadas || 0)), (s.realizadas === 1 ? ' feita' : ' feitas')),
        el(doc, 'span', { classe: 'n n--falta' }, el(doc, 'b', null, String(s.faltas || 0)), (s.faltas === 1 ? ' falta' : ' faltas')),
        el(doc, 'span', { classe: 'n n--marcada' }, el(doc, 'b', null, String(s.futuras || 0)), (s.futuras === 1 ? ' marcada' : ' marcadas'))),
      quando ? el(doc, 'p', { classe: 'sessoes__proxima', dados: { papel: 'proxima-sessao' } },
        ic(doc, 'calendario'), el(doc, 'span', null, 'Próxima sessão: ', el(doc, 'b', null, quando)), falta ? el(doc, 'span', { classe: 'consulta__falta' }, falta) : null) : null);
  }

  /**
   * "Na franquia": o que o CRM da franquia da unidade DO CARTÃO sabe (a mesma leitura do widget "Agenda da franquia"),
   * mastigado: próxima consulta, última consulta (veio ou faltou), tratamento, sessões e alta. Sem cadastro, diz com
   * clareza; na conta de duas unidades com o campo vazio, pede a unidade (cada uma tem a sua franquia).
   */
  function franquia(doc, r, acoes, agora) {
    var f = r.franquia;
    if (!f || f.franquia === false) return null;
    var c = r.cartao || {};
    var tz = f.tz;
    var u = T.unidadeDoCartao(c, f);
    var corpo = [];
    if ((u && u.vazia) || T.franquiaPedeUnidade(f)) {
      var b = acoes && acoes.abrirGuia ? botaoAcao(doc, 'Escolher a unidade', 'escolher-unidade', { icone: 'casa' }) : null;
      if (b) b.addEventListener('click', function () { acoes.abrirGuia(c.id); });
      corpo.push(el(doc, 'div', { classe: 'fq__vazio fq__vazio--unidade', dados: { papel: 'franquia-sem-unidade' } },
        el(doc, 'span', { classe: 'fq__vazio-icone' }, ic(doc, 'casa')),
        el(doc, 'p', { classe: 'fq__vazio-titulo' }, 'Escolha a unidade para ver a franquia'),
        el(doc, 'p', { classe: 'fq__vazio-texto' }, 'Esta conta do Kommo atende mais de uma unidade, e cada uma tem a sua franquia. Com a unidade escolhida, a consulta e as sessões aparecem aqui.'),
        b));
    } else if (f.erro && !f.paciente) {
      corpo.push(el(doc, 'div', { classe: 'fq__vazio', dados: { papel: 'franquia-erro' } },
        el(doc, 'span', { classe: 'fq__vazio-icone fq__vazio-icone--alerta' }, ic(doc, 'alerta')),
        el(doc, 'p', { classe: 'fq__vazio-titulo' }, f.erro === 'franquia indisponível' ? 'A franquia não respondeu agora' : 'Não deu para ler a franquia'),
        el(doc, 'p', { classe: 'fq__vazio-texto' }, f.erro === 'franquia indisponível' ? 'Troque de conversa e volte em um minuto.' : String(f.erro))));
    } else if (!f.paciente) {
      corpo.push(el(doc, 'div', { classe: 'fq__vazio', dados: { papel: 'sem-cadastro' } },
        el(doc, 'span', { classe: 'fq__vazio-icone' }, ic(doc, 'franquia')),
        el(doc, 'p', { classe: 'fq__vazio-titulo' }, 'Sem cadastro na franquia'),
        el(doc, 'p', { classe: 'fq__vazio-texto' }, 'Este paciente ainda não tem cadastro na franquia. Quando a consulta for marcada lá, ela aparece aqui' +
          (r.franquiaAndaSozinha === false ? '.' : ' e o cartão anda sozinho para AGENDADO.'))));
    } else {
      var ag = f.agenda || {};
      var p = ag.proximaConsulta;
      var t = f.tratamento;
      var noTrat = T.chaveDaEtapa(etapaAtual(c)) === 'em-tratamento' || T.chaveDaEtapa(etapaAtual(c)) === 'alta';
      // em tratamento, "nenhuma consulta" não é alerta: a agenda dele são as sessões
      if (p) corpo.push(blocoDaConsulta(doc, p, tz, agora));
      else if (!t && !noTrat) corpo.push(el(doc, 'div', { classe: 'fq__linha fq__linha--alerta', dados: { papel: 'sem-consulta' } }, ic(doc, 'calendario'), el(doc, 'span', null, 'Nenhuma consulta marcada')));
      var ult = ag.ultimaConsulta;
      if (ult) {
        var su = T.situacaoDaConsulta(ult.status);
        corpo.push(el(doc, 'div', { classe: 'fq__linha', dados: { papel: 'ultima-consulta' } },
          el(doc, 'span', { classe: 'fq__rotulo' }, 'Última consulta'),
          el(doc, 'span', { classe: 'fq__valor' }, ult.dia || '—', su ? pilula(doc, su.rotulo, su.nivel, su.nivel === 'bom' ? 'check' : su.nivel === 'ruim' ? 'x' : null) : null)));
      }
      if (t) {
        corpo.push(el(doc, 'div', { classe: 'fq__linha', dados: { papel: 'tratamento' } },
          el(doc, 'span', { classe: 'fq__rotulo' }, 'Tratamento'),
          el(doc, 'span', { classe: 'fq__valor' }, t.categoria ? el(doc, 'span', { classe: 'fq__fraco' }, t.categoria) : null, t.status ? pilula(doc, t.status, nivelDoTratamento(t.status)) : null)));
      } else if (!noTrat) {
        corpo.push(el(doc, 'div', { classe: 'fq__linha', dados: { papel: 'tratamento' } },
          el(doc, 'span', { classe: 'fq__rotulo' }, 'Tratamento'),
          el(doc, 'span', { classe: 'fq__valor fq__fraco' }, 'nenhum aberto')));
      }
      var s = ag.sessoes;
      if (t || noTrat || (s && (s.realizadas || s.futuras || s.faltas))) corpo.push(blocoDasSessoes(doc, ag, tz, agora));
      if (t || noTrat) {
        var alta = T.teveAlta(t, etapaAtual(c));
        corpo.push(el(doc, 'div', { classe: 'fq__linha', dados: { papel: 'alta' } },
          el(doc, 'span', { classe: 'fq__rotulo' }, 'Alta'),
          el(doc, 'span', { classe: 'fq__valor' }, alta ? pilula(doc, 'Recebeu alta', 'bom', 'alta') : el(doc, 'span', { classe: 'fq__fraco' }, 'ainda não'))));
      }
      if (f.duplicadoNaFranquia) corpo.push(el(doc, 'p', { classe: 'nota nota--alerta' }, ic(doc, 'duplicado'), 'A franquia tem este paciente em dois cadastros.'));
    }
    return el(doc, 'section', { classe: 'bloco-cartao fq', dados: { bloco: 'franquia' } },
      el(doc, 'div', { classe: 'fq__cab' },
        rotulo(doc, 'franquia', 'Na franquia', 'rotulo--franquia'),
        f.unidade ? el(doc, 'span', { classe: 'fq__unidade' }, f.unidade) : null),
      ...corpo);
  }

  function origem(doc, a) {
    if (!a) return null;
    var partes = [a.titulo && '"' + a.titulo + '"', a.campanha, a.plataforma].filter(Boolean);
    return linha(doc, 'Veio de', partes.length ? partes.join(' · ') : a.origem || a.anuncio, null, 'anuncio');
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
    // 0.5.0: o próximo passo do resumo virou a 1ª linha de "O que é seu agora"; aqui ficam só os fatos
    var titulo = el(doc, 'span', null, ia && ia.ia ? 'Resumo (IA)' : 'Resumo');
    var lista = el(doc, 'ul', { classe: 'resumo__linhas' });
    preencherResumo(doc, lista, ia ? ia.linhas : base ? base.linhas : []);
    var nota = el(doc, 'p', { classe: 'nota', dados: { papel: 'nota-resumo' } }, ia ? ia.aviso || (ia.ia ? NOTA_DA_IA : '') : '');
    var botaoIa = null;
    if (r.iaDisponivel && !ia && acoes && acoes.resumirComIa) {
      botaoIa = botaoAcao(doc, 'Resumir com IA', 'resumir-ia', { icone: 'brilho' });
      var textoIa = botaoIa.lastChild;
      aoClicar(botaoIa, nota, function () {
        textoIa.textContent = 'Resumindo…';
        return Promise.resolve(acoes.resumirComIa(r.cartao.id)).catch(function (e) {
          textoIa.textContent = 'Resumir com IA';
          throw e;
        });
      }, function (res) {
        if (!res || !res.linhas) return;
        preencherResumo(doc, lista, res.linhas);
        titulo.textContent = res.ia ? 'Resumo (IA)' : 'Resumo';
        nota.textContent = res.aviso || (res.ia ? NOTA_DA_IA : '');
        botaoIa.remove();
      });
    }
    return el(doc, 'section', { classe: 'bloco-cartao resumo', dados: { bloco: 'resumo' } },
      el(doc, 'div', { classe: 'resumo__cab' }, el(doc, 'p', { classe: 'rotulo' }, ic(doc, 'lista'), titulo), botaoIa),
      lista, nota);
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
    var bloco = el(doc, 'div', { classe: 'pausa', dados: { bloco: 'pausa' } });
    if (p && p.ate) {
      var retomar = botaoAcao(doc, 'Retomar agora', 'retomar', { icone: 'atualizar' });
      aoClicar(retomar, msg, function () { return acoes.retomar(c.id); });
      bloco.appendChild(el(doc, 'p', { classe: 'pausa__estado', dados: { papel: 'estado-pausa' } }, textoDaPausa(p)));
      bloco.appendChild(retomar);
    } else if (sofia.pausada && sofia.por === 'caixinha') {
      bloco.appendChild(el(doc, 'p', { classe: 'nota' },
        'A caixinha "Pausar IA" está marcada no cartão, sem data para voltar. Para a Sofia voltar, desmarque no Kommo.'));
    } else {
      var abrir = botaoAcao(doc, 'Pausar a Sofia neste paciente', 'abrir-pausa', { icone: 'pausa' });
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

  // ── fase 3: etiquetas do cartão ──

  function chipDeEtiqueta(doc, nome, aoTirar, robos) {
    var robo = E.ehDeRobo(nome, robos);
    var chip = el(doc, 'span', { classe: 'etiqueta' + (robo ? ' etiqueta--robo' : ''), titulo: robo ? 'Etiqueta que faz o robô mandar mensagem' : null, dados: { etiqueta: nome } },
      el(doc, 'span', { classe: 'etiqueta__nome' }, nome));
    if (aoTirar) {
      var x = el(doc, 'button', { classe: 'etiqueta__tirar', tipo: 'button', titulo: 'Tirar a etiqueta', dados: { acao: 'tirar-etiqueta' } }, '✕');
      x.setAttribute('aria-label', 'Tirar a etiqueta ' + nome);
      aoTirar(x);
      chip.appendChild(x);
    }
    return chip;
  }

  /**
   * As etiquetas do cartão: chips com ✕ para tirar, e "+ etiqueta" com busca entre as etiquetas que JÁ EXISTEM
   * na conta (a Ponte não cria etiqueta). Etiqueta ▶ pede confirmação antes de pôr; tirar não pede.
   * Sem `acoes.porEtiqueta` (teste antigo), só os chips.
   */
  function blocoDeEtiquetas(doc, r, acoes) {
    var c = r.cartao;
    var lista = c.etiquetas || [];
    var robos = c.etiquetasRobo || [];
    var podeMexer = !!(acoes && acoes.porEtiqueta && acoes.tirarEtiqueta && acoes.listarEtiquetas);
    if (!podeMexer) {
      return lista.length ? el(doc, 'div', { classe: 'etiquetas' }, ...lista.map(function (t) { return chipDeEtiqueta(doc, t, null, robos); })) : null;
    }
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-etiqueta' } });
    var chips = el(doc, 'div', { classe: 'etiquetas', dados: { papel: 'chips' } });
    lista.forEach(function (t) {
      chips.appendChild(chipDeEtiqueta(doc, t, function (x) {
        aoClicar(x, msg, function () { return acoes.tirarEtiqueta(c.id, t); });
      }, robos));
    });
    var abrir = botaoAcao(doc, '+ etiqueta', 'abrir-etiquetas');
    chips.appendChild(abrir);

    var busca = el(doc, 'input', { classe: 'busca__campo', tipo: 'search' });
    busca.placeholder = 'Buscar etiqueta da conta';
    busca.setAttribute('aria-label', 'Buscar etiqueta da conta');
    var opcoes = el(doc, 'ul', { classe: 'etiquetas__opcoes', dados: { papel: 'opcoes-etiqueta' } });
    var confirmar = el(doc, 'div', { classe: 'confirmar', dados: { papel: 'confirmar-etiqueta' } });
    confirmar.hidden = true;
    var fechar = botaoAcao(doc, 'Cancelar', 'fechar-etiquetas');
    var escolher = el(doc, 'div', { classe: 'etiquetas__escolher', dados: { papel: 'escolher-etiqueta' } },
      el(doc, 'div', { classe: 'busca' }, busca, fechar), opcoes, confirmar);
    escolher.hidden = true;
    var daConta = null;

    function por(nome, confirmado) {
      msg.textContent = '';
      return Promise.resolve(acoes.porEtiqueta(c.id, nome, confirmado)).catch(function (e) {
        // o servidor sabe de robô que o painel não sabia: pergunta antes de tentar de novo
        if (e && e.precisaConfirmar && !confirmado) return pedirConfirmacao(nome);
        msg.textContent = (e && e.message) || 'Não consegui pôr a etiqueta agora.';
      });
    }

    function pedirConfirmacao(nome) {
      var sim = el(doc, 'button', { classe: 'botao botao--alerta botao--pequeno', tipo: 'button', dados: { acao: 'confirmar-robo' } }, 'Pôr mesmo assim');
      var nao = botaoAcao(doc, 'Cancelar', 'cancelar-robo');
      confirmar.replaceChildren(
        el(doc, 'p', { classe: 'confirmar__pergunta' }, E.PERGUNTA_DO_ROBO),
        el(doc, 'p', { classe: 'confirmar__etiqueta' }, nome),
        el(doc, 'div', { classe: 'pausa__botoes' }, sim, nao));
      confirmar.hidden = false;
      opcoes.hidden = true;
      sim.addEventListener('click', function () {
        if (sim.disabled) return;
        sim.disabled = true;
        nao.disabled = true;
        por(nome, true).then(function () { sim.disabled = false; nao.disabled = false; });
      });
      nao.addEventListener('click', function () {
        confirmar.hidden = true;
        opcoes.hidden = false;
      });
    }

    function desenharOpcoes() {
      opcoes.replaceChildren();
      if (!daConta) return;
      var achadas = E.filtrar(daConta, busca.value, lista, 30);
      if (!achadas.length) {
        opcoes.appendChild(el(doc, 'li', { classe: 'nota' }, busca.value.trim()
          ? 'Nenhuma etiqueta da conta com esse nome. A Ponte não cria etiqueta nova.'
          : 'Este cartão já tem todas as etiquetas da conta.'));
        return;
      }
      achadas.forEach(function (e) {
        // de robô: o que o servidor disse (▶ + a lista da unidade) OU a regra local do ▶ — na dúvida, pergunta
        var robo = e.robo === true || E.ehDeRobo(e.nome, robos);
        var b = el(doc, 'button', { classe: 'etiquetas__opcao' + (robo ? ' etiquetas__opcao--robo' : ''), tipo: 'button', dados: { etiqueta: e.nome } },
          e.nome, robo ? el(doc, 'span', { classe: 'etiquetas__aviso' }, ' · manda mensagem') : null);
        b.addEventListener('click', function () {
          if (b.disabled) return;
          if (robo) return pedirConfirmacao(e.nome);
          b.disabled = true;
          por(e.nome, false).then(function () { b.disabled = false; });
        });
        opcoes.appendChild(el(doc, 'li', null, b));
      });
    }

    busca.addEventListener('input', function () {
      confirmar.hidden = true;
      opcoes.hidden = false;
      desenharOpcoes();
    });
    fechar.addEventListener('click', function () {
      escolher.hidden = true;
      abrir.hidden = false;
      msg.textContent = '';
    });
    abrir.addEventListener('click', function () {
      abrir.hidden = true;
      escolher.hidden = false;
      confirmar.hidden = true;
      opcoes.hidden = false;
      if (daConta) return desenharOpcoes();
      opcoes.replaceChildren(el(doc, 'li', { classe: 'nota' }, 'Carregando as etiquetas da conta…'));
      Promise.resolve(acoes.listarEtiquetas()).then(function (l) {
        daConta = l || [];
        desenharOpcoes();
      }, function (e) {
        opcoes.replaceChildren();
        msg.textContent = (e && e.message) || 'Não consegui ler as etiquetas da conta.';
      });
    });

    return el(doc, 'div', { classe: 'bloco-etiquetas', dados: { bloco: 'etiquetas' } }, chips, escolher, msg);
  }

  // ── fase 3: aviso de cartão duplicado ──

  function linhaDoDuplicado(doc, d, este) {
    return el(doc, 'li', { classe: 'duplicado', dados: { lead: String(d.id) } },
      el(doc, 'span', { classe: 'duplicado__nome' }, (este ? 'Este: ' : '') + (d.nome || 'Cartão ' + d.id)),
      el(doc, 'span', { classe: 'duplicado__etapa' }, [d.funil, d.etapa].filter(Boolean).join(' › ')),
      d.origem ? el(doc, 'span', { classe: 'duplicado__origem' }, '⚑ Origem: ' + d.origem) : null,
      !este && d.link ? el(doc, 'a', { classe: 'botao botao--pequeno', href: d.link }, 'Abrir no Kommo') : null);
  }

  /**
   * O aviso de cartão duplicado. Dois grupos:
   *   - do MESMO contato (o paciente é o contato principal): "Este paciente tem N cartões abertos";
   *   - de OUTRO contato com o mesmo número: pode ser da família dividindo o WhatsApp — vem separado e com cautela.
   * Em todos os casos: confira se é a mesma pessoa antes de juntar. A Ponte só avisa — juntar (Mesclar) é no
   * Kommo, e nada é apagado.
   */
  function faixaDeDuplicados(doc, r) {
    var lista = r.duplicados;
    if (!lista || !lista.length) return null;
    var c = r.cartao;
    var doContato = lista.filter(function (d) { return d.via !== 'telefone'; });
    var doNumero = lista.filter(function (d) { return d.via === 'telefone'; });
    var esteAberto = !c.fechado;
    var titulo;
    if (doContato.length) {
      titulo = 'Este paciente tem ' + (doContato.length + (esteAberto ? 1 : 0)) + ' cartões abertos';
    } else {
      titulo = doNumero.length === 1 ? 'Há outro cartão aberto com o mesmo número' : 'Há ' + doNumero.length + ' outros cartões abertos com o mesmo número';
    }
    var ul = el(doc, 'ul', { classe: 'duplicados__lista' });
    if (esteAberto) ul.appendChild(linhaDoDuplicado(doc, { id: c.id, nome: c.nome, funil: c.funil, etapa: c.etapa, origem: c.origem || (c.anuncio && c.anuncio.origem) || null }, true));
    doContato.forEach(function (d) { ul.appendChild(linhaDoDuplicado(doc, d, false)); });
    var numero = null;
    if (doNumero.length) {
      var ul2 = el(doc, 'ul', { classe: 'duplicados__lista' });
      doNumero.forEach(function (d) { ul2.appendChild(linhaDoDuplicado(doc, d, false)); });
      numero = el(doc, 'div', { classe: 'duplicados__numero', dados: { grupo: 'mesmo-numero' } },
        el(doc, 'p', { classe: 'duplicados__cautela' }, 'Outro contato com o mesmo número: pode ser da família — confira se é a mesma pessoa antes de juntar.'),
        ul2);
    }
    // 0.5.0: recolhida (uma linha no topo, não empurra a trilha); abre no clique
    return el(doc, 'section', { classe: 'faixa faixa--amarela', dados: { bloco: 'duplicados' } },
      el(doc, 'details', { classe: 'faixa__abre' },
        el(doc, 'summary', { classe: 'faixa__cab' }, ic(doc, 'duplicado'), el(doc, 'span', { classe: 'faixa__titulo' }, titulo), el(doc, 'span', { classe: 'faixa__ver' }, 'ver', ic(doc, 'abaixo'))),
        ul,
        numero,
        el(doc, 'p', { classe: 'faixa__regra' }, 'Confira se é a mesma pessoa antes de juntar. Fica o que veio do anúncio; o outro é juntado (Mesclar) no Kommo, nunca apagado.')));
  }

  /**
   * A Sofia neste cartão: o estado (ativa, pausada e por quê) e "Pausar a Sofia neste paciente". Some quando a unidade
   * não tem a IA (`r.sofiaNaUnidade === false`).
   */
  function blocoDaSofia(doc, r, acoes) {
    if (r.sofiaNaUnidade === false) return null;
    var c = r.cartao;
    var sofia = c.sofia || {};
    var texto = sofia.pausada ? (PAUSA_POR[sofia.por] || 'pausada') + (sofia.ate ? ' até ' + quando(sofia.ate) : '') : 'ativa: ela responde este paciente';
    return el(doc, 'section', { classe: 'bloco-cartao sofia' + (sofia.pausada ? ' sofia--pausada' : ''), dados: { bloco: 'sofia' } },
      el(doc, 'div', { classe: 'sofia__cab' },
        rotulo(doc, 'robo', 'Sofia (IA)'),
        sofia.pausada ? pilula(doc, 'Pausada', 'atencao', 'pausa') : pilula(doc, 'Ativa', 'bom')),
      el(doc, 'p', { classe: 'sofia__estado', dados: { papel: 'estado-sofia' } }, 'Sofia ' + texto),
      blocoDaPausa(doc, r, acoes));
  }

  /** O que o Kommo guarda do cartão: responsável, de onde veio, etiquetas e o link. */
  function blocoDoKommo(doc, r, acoes) {
    var c = r.cartao;
    return el(doc, 'section', { classe: 'bloco-cartao kommo', dados: { bloco: 'kommo' } },
      rotulo(doc, 'etiqueta', 'No Kommo'),
      linha(doc, 'Responsável', c.responsavel || 'ninguém', null, 'pessoa'),
      origem(doc, c.anuncio),
      el(doc, 'div', { classe: 'kommo__etiquetas' }, el(doc, 'span', { classe: 'linha__rotulo' }, ic(doc, 'etiqueta'), 'Etiquetas'), blocoDeEtiquetas(doc, r, acoes)),
      el(doc, 'a', { classe: 'botao botao--kommo', href: c.link }, ic(doc, 'externo'), 'Abrir no Kommo'));
  }

  /** Cartão achado. `agora` só para o teste (o tempo na etapa e "amanhã"). */
  function cartao(doc, r, acoes, agora) {
    var c = r.cartao;
    var hoje = agora || new Date();
    return el(doc, 'section', { classe: 'cartao', dados: { estado: 'achado', lead: String(c.id) } },
      cabecalho(doc, r, acoes),
      faixaDeDuplicados(doc, r),
      trilha(doc, r, hoje),
      blocoDoAgora(doc, r, acoes),
      franquia(doc, r, acoes, hoje),
      resumo(doc, r, acoes),
      blocoDaSofia(doc, r, acoes),
      blocoDoKommo(doc, r, acoes),
      r.outrosCartoes && r.outrosCartoes.length
        ? el(doc, 'section', { classe: 'bloco-cartao outros', dados: { bloco: 'outros' } }, rotulo(doc, 'duplicado', 'Outros cartões deste paciente'), listaDeCartoes(doc, r.outrosCartoes, acoes))
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
      icone: 'mensagem',
    });
    abrir.className += ' botao--cheio';
    var copiar = botaoAcao(doc, 'Copiar telefone', 'copiar', { desligado: !temTelefone, icone: 'copiar' });
    var textoCopiar = copiar.lastChild;
    if (temTelefone) {
      aoClicar(abrir, msg, function () { return acoes.abrirConversa(it.telefone); });
      aoClicar(copiar, msg, function () { return acoes.copiar(it.telefoneVisivel || it.telefone); }, function () {
        textoCopiar.textContent = 'Copiado';
        setTimeout(function () { textoCopiar.textContent = 'Copiar telefone'; }, 1500);
      });
    }
    return el(doc, 'li', { classe: 'fila__item', dados: { lead: String(it.leadId) } },
      avatar(doc, it.nome, 'avatar--pequeno'),
      el(doc, 'div', { classe: 'fila__corpo' },
        el(doc, 'div', { classe: 'fila__linha' },
          el(doc, 'span', { classe: 'fila__nome' }, it.nome || 'Cartão ' + it.leadId),
          it.passado ? el(doc, 'span', { classe: 'fila__tempo' }, ic(doc, 'relogio'), relativo(it.quando, agora)) : null),
        el(doc, 'p', { classe: 'fila__detalhe' }, [it.etapa, it.detalhe].filter(Boolean).join(' · ')),
        el(doc, 'p', { classe: 'fila__telefone' + (it.telefoneVisivel ? '' : ' fila__telefone--sem') }, it.telefoneVisivel ||
          (it.semTelefone === false ? 'telefone não lido agora — clique em Atualizar' : 'sem telefone no Kommo')),
        el(doc, 'div', { classe: 'fila__botoes' }, abrir, copiar,
          it.link ? el(doc, 'a', { classe: 'botao botao--pequeno botao--icone', href: it.link, titulo: 'Abrir no Kommo' }, ic(doc, 'externo'), el(doc, 'span', { classe: 'sr' }, 'Abrir no Kommo')) : null),
        msg));
  }

  /** A cor de cada grupo da fila (o mesmo grupo, a mesma cor nos números e na lista). */
  var COR_DO_GRUPO = { 'sem-resposta': 'vermelho', retomar: 'ambar', confirmar: 'azul', faltou: 'magenta', negociacao: 'teal' };
  var ICONE_DO_GRUPO = { 'sem-resposta': 'mensagem', retomar: 'relogio', confirmar: 'calendario', faltou: 'x', negociacao: 'sessao' };

  /** A aba "Fila de hoje": os números por grupo no topo, e um grupo por etapa do COMERCIAL com os três botões. */
  function fila(doc, f, acoes, agora) {
    var grupos = (f && f.grupos) || [];
    var total = grupos.reduce(function (s, g) { return s + (g.total || 0); }, 0);
    var atualizar = botaoAcao(doc, 'Atualizar', 'atualizar-fila', { icone: 'atualizar' });
    atualizar.addEventListener('click', function () { if (acoes && acoes.atualizar) acoes.atualizar(); });
    // fase 3: "Começar a ligar" — um paciente por vez; a Ponte abre a conversa, a atendente clica no 📞
    var ligar = null;
    if (acoes && acoes.comecarLigacao) {
      var feitos = acoes.feitosHoje ? acoes.feitosHoje() : 0;
      var temQuem = L.filaDeLigacao(f).length > 0;
      ligar = el(doc, 'button', { classe: 'botao botao--primario botao--ligar', tipo: 'button', dados: { acao: 'comecar-ligar' }, desligado: !temQuem },
        ic(doc, 'telefone'), el(doc, 'span', null, feitos ? 'Continuar a ligar (' + feitos + ' feitos hoje)' : 'Começar a ligar'));
      ligar.addEventListener('click', function () { if (!ligar.disabled) acoes.comecarLigacao(); });
    }
    var placar = el(doc, 'div', { classe: 'placar', dados: { papel: 'placar' } });
    grupos.forEach(function (g) {
      var cor = COR_DO_GRUPO[g.id] || 'azul';
      var t = el(doc, 'button', { classe: 'placar__item placar__item--' + cor + (g.total ? '' : ' placar__item--zero'), tipo: 'button', dados: { ir: g.id }, titulo: g.etapa + ': ' + g.rotulo },
        el(doc, 'span', { classe: 'placar__numero' }, String(g.total || 0)),
        el(doc, 'span', { classe: 'placar__rotulo' }, ic(doc, ICONE_DO_GRUPO[g.id] || 'lista'), g.rotulo));
      t.addEventListener('click', function () {
        var alvo = secao.querySelector('[data-grupo="' + g.id + '"]');
        if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      placar.appendChild(t);
    });
    var secao = el(doc, 'section', { classe: 'fila', dados: { estado: 'fila' } },
      el(doc, 'div', { classe: 'fila__topo' },
        el(doc, 'div', null,
          el(doc, 'p', { classe: 'aba__titulo' }, 'Fila de hoje'),
          el(doc, 'p', { classe: 'nota' }, (total ? total + (total === 1 ? ' paciente' : ' pacientes') : 'Ninguém na fila') +
            (f && f.atualizadoEm ? ' · atualizada às ' + hora(f.atualizadoEm) : ''))),
        atualizar),
      grupos.length ? placar : null,
      f && f.avisoTelefones ? el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'aviso-telefones' } }, f.avisoTelefones) : null,
      ligar);
    grupos.forEach(function (g) {
      var itens = g.itens || [];
      var lista = el(doc, 'ul', { classe: 'fila__lista' });
      itens.forEach(function (it) { lista.appendChild(itemDaFila(doc, it, acoes, agora)); });
      var cor = COR_DO_GRUPO[g.id] || 'azul';
      secao.appendChild(el(doc, 'section', { classe: 'fila__grupo fila__grupo--' + cor, dados: { grupo: g.id } },
        el(doc, 'h2', { classe: 'fila__titulo' },
          el(doc, 'span', { classe: 'fila__icone' }, ic(doc, ICONE_DO_GRUPO[g.id] || 'lista')),
          el(doc, 'span', { classe: 'fila__nomes' },
            el(doc, 'span', { classe: 'fila__motivo' }, g.rotulo),
            el(doc, 'span', { classe: 'fila__etapa' }, g.etapa)),
          el(doc, 'span', { classe: 'fila__contador', dados: { contador: g.id } }, String(g.total || 0))),
        g.aviso ? el(doc, 'p', { classe: 'nota nota--alerta' }, g.aviso) : null,
        itens.length ? lista : el(doc, 'p', { classe: 'nota fila__vazio' }, 'Ninguém agora.'),
        g.total > itens.length ? el(doc, 'p', { classe: 'nota' }, 'Mostrando ' + itens.length + ' de ' + g.total + '. Os outros estão no Kommo.') : null));
    });
    return secao;
  }

  // ── fase 3: o modo "Começar a ligar" ──

  /**
   * Um paciente por vez. `v` (montado pelo painel):
   *   - `item`: o paciente da vez (da Fila de hoje), ou null quando acabou;
   *   - `fase`: 'esperando' (contagem regressiva até abrir), 'aberto' (conversa aberta: clique no 📞),
   *     'abrindo', 'erro' (não abriu), 'pausado' ou 'fim';
   *   - `esperaAte` / `motivoEspera` ('intervalo' | 'teto'), `posicao`, `total`, `pulados` (o servidor afirma: sem
   *     telefone), `naoLidos` (telefone não lido agora: ficam para depois), `aviso`, `gravando` (resultado indo para
   *     o servidor: botões travados), `ritmo`, `msg` (erro) e `ultimo` (o que acabou de ser gravado ou pulado).
   * A contagem regressiva fica em `[data-papel="espera"]`: o painel troca só o texto a cada segundo.
   */
  function modoLigacao(doc, v, acoes, agora) {
    var a = acoes || {};
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-ligacao' } }, v.msg || '');
    var it = v.item;
    var topo = el(doc, 'div', { classe: 'fila__topo' },
      el(doc, 'div', null,
        el(doc, 'p', { classe: 'aviso__titulo' }, v.fase === 'fim' ? 'Fila de ligações' : 'Ligando · ' + v.posicao + ' de ' + v.total),
        el(doc, 'p', { classe: 'nota' }, 'Uma conversa a cada ' + v.ritmo.intervaloS + ' s, no máximo ' + v.ritmo.tetoPorHora + ' por hora.')),
      v.fase === 'pausado' ? botaoAcao(doc, 'Continuar', 'continuar-ligacao') : null,
      v.fase === 'esperando' ? botaoAcao(doc, 'Pausar', 'pausar-ligacao') : null,
      botaoAcao(doc, 'Sair', 'sair-ligacao'));
    var corpo = [];
    var naoLidos = v.naoLidos || [];
    if (v.aviso) corpo.push(el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'aviso-ligacao' } }, v.aviso));
    if (v.ultimo) corpo.push(el(doc, 'p', { classe: 'nota nota--ok', dados: { papel: 'ultimo' } }, v.ultimo));
    if (v.fase === 'fim' || !it) {
      corpo.push(el(doc, 'p', { classe: 'ligacao__fim' }, naoLidos.length
        ? 'Acabou o que deu para ligar agora. ' + naoLidos.length + (naoLidos.length === 1 ? ' paciente ficou' : ' pacientes ficaram') +
          ' sem o telefone lido: saia, clique em Atualizar e continue.'
        : 'Acabou a fila de hoje.'));
      corpo.push(el(doc, 'div', { classe: 'fila__botoes' }, botaoAcao(doc, 'Recomeçar a lista', 'recomecar-ligacao'), botaoAcao(doc, 'Voltar à fila', 'sair-ligacao')));
    } else {
      corpo.push(el(doc, 'div', { classe: 'ligacao__paciente', dados: { lead: String(it.leadId) } },
        el(doc, 'p', { classe: 'ligacao__nome' }, it.nome || 'Cartão ' + it.leadId),
        el(doc, 'p', { classe: 'fila__detalhe' }, [it.etapa, it.motivo, it.detalhe].filter(Boolean).join(' · ')),
        el(doc, 'p', { classe: 'fila__telefone' }, it.telefoneVisivel || ''),
        it.link ? el(doc, 'a', { classe: 'botao botao--pequeno', href: it.link }, 'Abrir no Kommo') : null));
      if (v.fase === 'esperando' || v.fase === 'pausado') {
        var espera = v.fase === 'pausado' ? 'Pausado. Clique em Continuar para seguir.' : L.textoDaEspera((v.esperaAte || 0) - (agora || new Date()).getTime());
        corpo.push(el(doc, 'p', { classe: 'ligacao__espera', dados: { papel: 'espera' } }, espera));
        if (v.fase === 'esperando' && v.motivoEspera === 'teto') {
          corpo.push(el(doc, 'p', { classe: 'nota' }, 'Chegou ao teto de ' + v.ritmo.tetoPorHora + ' conversas na última hora: a Ponte espera para não parecer spam.'));
        }
        corpo.push(el(doc, 'div', { classe: 'fila__botoes' }, botaoAcao(doc, 'Pular este', 'pular-ligacao')));
      } else if (v.fase === 'abrindo') {
        corpo.push(el(doc, 'p', { classe: 'ligacao__espera', dados: { papel: 'espera' } }, 'Abrindo a conversa…'));
      } else if (v.fase === 'erro') {
        corpo.push(el(doc, 'div', { classe: 'fila__botoes' }, botaoAcao(doc, 'Tentar abrir de novo', 'reabrir-ligacao'), botaoAcao(doc, 'Pular este', 'pular-ligacao')));
      } else {
        corpo.push(el(doc, 'p', { classe: 'ligacao__instrucao' }, 'Clique no 📞 do WhatsApp para ligar.'));
        var resultados = el(doc, 'div', { classe: 'ligacao__resultados' });
        // gravando: tudo travado até o servidor responder (redesenhar a tela não destrava)
        L.RESULTADOS.forEach(function (rs) {
          var b = el(doc, 'button', { classe: 'botao', tipo: 'button', dados: { acao: 'resultado', resultado: rs.id }, desligado: !!v.gravando }, rs.rotulo);
          aoClicar(b, msg, function () {
            [].forEach.call(resultados.querySelectorAll('button'), function (x) { x.disabled = true; });
            return Promise.resolve(a.resultado ? a.resultado(it.leadId, rs.id) : null).then(function (x) {
              [].forEach.call(resultados.querySelectorAll('button'), function (y) { y.disabled = false; });
              return x;
            }, function (e) {
              [].forEach.call(resultados.querySelectorAll('button'), function (y) { y.disabled = false; });
              throw e;
            });
          });
          resultados.appendChild(b);
        });
        resultados.appendChild(botaoAcao(doc, 'Pular', 'pular-ligacao', { desligado: !!v.gravando }));
        corpo.push(resultados);
        if (v.gravando) corpo.push(el(doc, 'p', { classe: 'nota', dados: { papel: 'gravando' } }, 'Gravando no Kommo…'));
        corpo.push(el(doc, 'div', { classe: 'fila__botoes' }, botaoAcao(doc, 'Abrir a conversa de novo', 'reabrir-ligacao')));
      }
    }
    var pulados = (v.pulados || []).length
      ? el(doc, 'div', { classe: 'bloco', dados: { bloco: 'pulados' } },
        el(doc, 'p', { classe: 'bloco__rotulo' }, 'Pulados: sem telefone — abra pelo Kommo'),
        el(doc, 'ul', { classe: 'fila__lista' }, ...v.pulados.map(function (p) {
          return el(doc, 'li', { classe: 'fila__item', dados: { lead: String(p.leadId) } },
            el(doc, 'span', { classe: 'fila__nome' }, p.nome || 'Cartão ' + p.leadId), ' ',
            p.link ? el(doc, 'a', { classe: 'botao botao--pequeno', href: p.link }, 'Abrir no Kommo') : null);
        })))
      : null;
    var paraDepois = naoLidos.length
      ? el(doc, 'div', { classe: 'bloco', dados: { bloco: 'nao-lidos' } },
        el(doc, 'p', { classe: 'bloco__rotulo' }, 'Para depois: não consegui ler o telefone agora'),
        el(doc, 'p', { classe: 'nota' }, 'Não consegui ler os telefones, tente de novo: saia e clique em Atualizar. Estes não foram marcados como feitos.'),
        el(doc, 'ul', { classe: 'fila__lista' }, ...naoLidos.map(function (p) {
          return el(doc, 'li', { classe: 'fila__item', dados: { lead: String(p.leadId) } }, el(doc, 'span', { classe: 'fila__nome' }, p.nome || 'Cartão ' + p.leadId));
        })))
      : null;
    var secao = el(doc, 'section', { classe: 'fila ligacao', dados: { estado: 'ligacao', fase: v.fase } },
      topo, el(doc, 'div', { classe: 'fila__grupo' }, ...corpo, msg), pulados, paraDepois,
      el(doc, 'p', { classe: 'nota' }, 'A Ponte abre a conversa e grava o resultado no Kommo. Quem liga é você: ela nunca clica no WhatsApp.'));
    // os botões simples (sem promessa) vão direto para o painel
    [].forEach.call(secao.querySelectorAll('[data-acao]'), function (b) {
      var acao = b.getAttribute('data-acao');
      var f = { 'pausar-ligacao': a.pausar, 'continuar-ligacao': a.continuar, 'sair-ligacao': a.sair, 'pular-ligacao': a.pular, 'reabrir-ligacao': a.reabrir, 'recomecar-ligacao': a.recomecar }[acao];
      if (f) b.addEventListener('click', function () { if (!b.disabled) f(); });
    });
    return secao;
  }

  // ── fase 3: respostas prontas (só copiar) ──

  function itemDeResposta(doc, rp, primeiroNome, acoes, unidades, sugerida) {
    var texto = R.preencherNome(rp.texto, primeiroNome);
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-resposta' } });
    var copiar = botaoAcao(doc, 'Copiar', 'copiar-resposta', { icone: 'copiar' });
    var textoCopiar = copiar.lastChild;
    aoClicar(copiar, msg, function () { return acoes.copiar(texto); }, function () {
      textoCopiar.textContent = 'Copiado';
      copiar.classList.add('botao--copiado');
      setTimeout(function () { textoCopiar.textContent = 'Copiar'; copiar.classList.remove('botao--copiado'); }, 1500);
    });
    var daUnidade = R.unidadeDoModelo(rp.nome, unidades);
    // o nome com acento ("Petrópolis") para a etiqueta; a cor é a mesma do selo da unidade no cartão
    var nomeDaUnidade = daUnidade ? ((unidades || ['Petrópolis', 'Caxias']).filter(function (u) { return R.chaveDoModelo(u) === daUnidade; })[0] || daUnidade) : null;
    return el(doc, 'li', { classe: 'resposta' + (sugerida ? ' resposta--sugerida' : ''), dados: { resposta: String(rp.id) } },
      el(doc, 'div', { classe: 'resposta__cab' },
        el(doc, 'span', { classe: 'resposta__nome' }, rp.nome),
        nomeDaUnidade ? el(doc, 'span', { classe: 'selo selo--mini selo--' + T.corDaUnidade(nomeDaUnidade), titulo: 'Só para pacientes de ' + nomeDaUnidade }, ic(doc, 'casa'), nomeDaUnidade) : null,
        copiar),
      el(doc, 'p', { classe: 'resposta__texto' }, texto),
      R.temLacuna(texto) ? el(doc, 'p', { classe: 'nota nota--alerta' }, ic(doc, 'alerta'), 'Complete o que está entre colchetes antes de enviar.') : null,
      rp.temAnexo ? el(doc, 'p', { classe: 'nota' }, 'Este modelo tem anexo no Kommo: a Ponte copia só o texto.') : null,
      msg);
  }

  /**
   * A aba "Respostas": os modelos gerais do Kommo (texto livre), com busca e "Copiar". O nome do paciente da
   * conversa aberta entra no lugar do marcador de nome. A Ponte só COPIA: a atendente cola e envia.
   *
   * 0.5.0: `contexto` = { etapa, unidade, unidades } do cartão na tela. No topo, as SUGERIDAS para a etapa (casadas pelo
   * nome do modelo: `consulta_` em AGENDADO, `espera_` em EM ESPERA…); os modelos de outra unidade (`caxias_` num
   * cartão de Petrópolis) saem da lista.
   */
  function respostas(doc, r, acoes, primeiroNome, buscaInicial, contexto) {
    var ctx = contexto || {};
    var todas = (r && r.respostas) || [];
    var visiveis = R.daUnidade(todas, ctx.unidade, ctx.unidades);
    var lista = visiveis.lista;
    var chave = T.chaveDaEtapa(ctx.etapa);
    var atualizar = botaoAcao(doc, 'Atualizar', 'atualizar-respostas', { icone: 'atualizar' });
    atualizar.addEventListener('click', function () { if (acoes && acoes.atualizar) acoes.atualizar(); });
    var topo = el(doc, 'div', { classe: 'fila__topo' },
      el(doc, 'div', null,
        el(doc, 'p', { classe: 'aba__titulo' }, 'Respostas prontas'),
        el(doc, 'p', { classe: 'nota', dados: { papel: 'para-quem' } }, primeiroNome
          ? 'O nome entra como "' + primeiroNome + '".'
          : 'Abra a conversa do paciente para o nome entrar sozinho.')),
      atualizar);
    if (!todas.length) {
      return el(doc, 'section', { classe: 'fila respostas', dados: { estado: 'respostas-vazio' } }, topo,
        el(doc, 'div', { classe: 'aviso' },
          el(doc, 'p', { classe: 'aviso__titulo' }, 'Nenhuma resposta pronta cadastrada no Kommo'),
          el(doc, 'p', { classe: 'aviso__texto' }, (r && r.ondeCadastrar) || 'No Kommo: Configurações › Modelos › Modelos gerais.')));
    }
    var campo = el(doc, 'input', { classe: 'busca__campo', tipo: 'search' });
    campo.placeholder = 'Buscar resposta';
    campo.value = buscaInicial || '';
    campo.setAttribute('aria-label', 'Buscar resposta pronta');
    var corpo = el(doc, 'div', { classe: 'respostas__corpo' });
    var a = acoes || {};

    function grupo(classe, papel, cab, itens, sugerida) {
      var ul = el(doc, 'ul', { classe: 'respostas__lista' });
      itens.forEach(function (rp) { ul.appendChild(itemDeResposta(doc, rp, primeiroNome, a, ctx.unidades, sugerida)); });
      return el(doc, 'section', { classe: 'respostas__grupo ' + classe, dados: { papel: papel } }, cab, ul);
    }

    function desenhar() {
      corpo.replaceChildren();
      var busca = campo.value.trim();
      if (busca) {
        var achadas = R.filtrar(lista, campo.value);
        if (!achadas.length) corpo.appendChild(el(doc, 'p', { classe: 'nota respostas__nada' }, 'Nenhuma resposta com esse texto.'));
        else corpo.appendChild(grupo('', 'achadas', el(doc, 'p', { classe: 'rotulo' }, ic(doc, 'lupa'), el(doc, 'span', null, achadas.length + (achadas.length === 1 ? ' resposta' : ' respostas'))), achadas, false));
        return;
      }
      var sug = R.sugeridas(lista, chave, ctx.unidade, ctx.unidades);
      var resto = lista.filter(function (rp) { return sug.indexOf(rp) < 0; });
      if (sug.length) {
        var dono = T.donoDaEtapa(ctx.etapa);
        corpo.appendChild(grupo('respostas__grupo--sugeridas', 'sugeridas',
          el(doc, 'div', { classe: 'respostas__cab' },
            el(doc, 'p', { classe: 'rotulo rotulo--voce' }, ic(doc, 'brilho'), el(doc, 'span', null, 'Sugeridas para esta etapa')),
            el(doc, 'span', { classe: 'etapa-chip etapa-chip--' + (dono || 'neutra') }, marcaDoDono(doc, dono), ctx.etapa)),
          sug, true));
      }
      if (resto.length) {
        corpo.appendChild(grupo('', 'todas', el(doc, 'p', { classe: 'rotulo' }, ic(doc, 'lista'), el(doc, 'span', null, sug.length ? 'Outras respostas' : 'Todas as respostas')), resto, false));
      }
      if (visiveis.escondidas && ctx.unidade) {
        corpo.appendChild(el(doc, 'p', { classe: 'nota', dados: { papel: 'escondidas' } }, ic(doc, 'casa'),
          visiveis.escondidas + (visiveis.escondidas === 1 ? ' resposta de outra unidade ficou de fora' : ' respostas de outra unidade ficaram de fora') +
          ': este paciente é de ' + ctx.unidade + '.'));
      }
    }
    campo.addEventListener('input', function () {
      if (acoes && acoes.aoBuscar) acoes.aoBuscar(campo.value);
      desenhar();
    });
    desenhar();
    return el(doc, 'section', { classe: 'fila respostas', dados: { estado: 'respostas' } }, topo,
      el(doc, 'div', { classe: 'busca busca--icone' }, ic(doc, 'lupa'), campo),
      corpo,
      el(doc, 'p', { classe: 'nota respostas__regra' }, ic(doc, 'cadeado'), 'A Ponte só copia: você cola na conversa e envia. Ela nunca escreve no WhatsApp.'));
  }

  // ── fase 4 (0.4.0): o guia "O que eu faço agora?" ──

  function opcao(doc, valor, texto) {
    var o = doc.createElement('option');
    o.value = valor;
    o.textContent = texto;
    return o;
  }

  /**
   * Um campo do guia com a entrada do tipo dele (texto, lista, data, número). O que a atendente digita fica em
   * `valores[id]` (sobrevive ao redesenho). Campo que a Ponte não grava (da franquia, de robô) mostra só o porquê.
   */
  function entradaDoCampo(doc, c, valores, marca, onde) {
    var rotulo = el(doc, 'label', { classe: 'guia__rotulo' }, c.nome, marca ? el(doc, 'span', { classe: 'guia__marca' }, marca) : null);
    if (!c.editavel) {
      return el(doc, 'div', { classe: 'guia__campo guia__campo--preso', dados: { campo: String(c.id) } },
        rotulo,
        el(doc, 'p', { classe: 'nota', dados: { papel: 'dica-campo' } }, c.dica || 'Preencha este campo no Kommo.'));
    }
    var campo;
    if (c.tipo === 'lista') {
      campo = doc.createElement('select');
      campo.appendChild(opcao(doc, '', 'Escolha…'));
      (c.opcoes || []).forEach(function (o) { campo.appendChild(opcao(doc, String(o.id), o.valor)); });
    } else if (c.tipo === 'texto-longo') {
      campo = doc.createElement('textarea');
      campo.rows = 2;
      campo.maxLength = 4000;
    } else {
      campo = doc.createElement('input');
      campo.type = c.tipo === 'data' ? 'date' : 'text';
      if (c.tipo === 'texto') campo.maxLength = 250;
      if (c.tipo === 'numero' || c.tipo === 'dinheiro') {
        campo.inputMode = 'decimal';
        campo.placeholder = c.tipo === 'dinheiro' ? 'R$ 0,00' : '0';
      }
    }
    campo.className = 'guia__entrada';
    // o mesmo campo pode aparecer em dois lugares (obrigatório aqui e no destino): o id da tela é por lugar; o valor, por campo
    campo.id = 'ponte-guia-' + (onde || 'etapa') + '-' + c.id;
    campo.setAttribute('data-campo', String(c.id));
    rotulo.htmlFor = campo.id;
    if (valores[c.id] != null) campo.value = valores[c.id];
    var guardar = function () { valores[c.id] = campo.value; };
    campo.addEventListener('input', guardar);
    campo.addEventListener('change', guardar);
    return el(doc, 'div', { classe: 'guia__campo', dados: { campo: String(c.id) } }, rotulo, campo);
  }

  /**
   * A PRÉVIA antes de gravar ou mover: o que vai para o Kommo, linha por linha, e os botões. Só depois do clique em
   * confirmar a Ponte grava. `msg` recebe o erro do servidor.
   */
  function previa(doc, titulo, linhas, extra, textoConfirmar, classeConfirmar, aoConfirmar, aoVoltar, msg) {
    var sim = el(doc, 'button', { classe: 'botao ' + classeConfirmar, tipo: 'button', dados: { acao: 'confirmar' } }, textoConfirmar);
    var nao = botaoAcao(doc, 'Voltar e corrigir', 'voltar-previa');
    nao.addEventListener('click', aoVoltar);
    aoClicar(sim, msg, aoConfirmar);
    return el(doc, 'div', { classe: 'guia__previa', dados: { papel: 'previa' } },
      el(doc, 'p', { classe: 'guia__previa-titulo' }, titulo),
      el(doc, 'ul', { classe: 'guia__linhas' }, ...linhas.map(function (l) { return el(doc, 'li', null, l); })),
      ...(extra || []),
      el(doc, 'div', { classe: 'pausa__botoes' }, sim, nao));
  }

  /** O 1º passo na conta de duas unidades (Petrópolis × Caxias) com o campo vazio: escolher a unidade. */
  function passoDaUnidade(doc, g, a, est) {
    var u = g.unidade;
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-unidade' } });
    var opcoes = el(doc, 'fieldset', { classe: 'pausa__opcoes' }, el(doc, 'legend', null, 'Unidade de atendimento'));
    (u.opcoes || []).forEach(function (o) {
      var r = el(doc, 'input', { tipo: 'radio', dados: { unidade: String(o.id) } });
      r.name = 'ponte-guia-unidade';
      r.value = String(o.id);
      r.checked = String(est.valores[u.campoId] || '') === String(o.id);
      r.addEventListener('change', function () { est.valores[u.campoId] = String(o.id); });
      opcoes.appendChild(el(doc, 'label', { classe: 'pausa__opcao' }, r, ' ' + o.valor));
    });
    var area = el(doc, 'div', { dados: { papel: 'area-unidade' } });
    var revisar = el(doc, 'button', { classe: 'botao botao--primario', tipo: 'button', dados: { acao: 'revisar-unidade' } }, 'Revisar');
    revisar.addEventListener('click', function () {
      msg.textContent = '';
      var alt = G.alteracoes([{ id: u.campoId, nome: u.nome, tipo: 'lista', editavel: true, opcoes: u.opcoes }], est.valores);
      if (!alt.campos.length) {
        msg.textContent = 'Escolha a unidade do paciente.';
        return;
      }
      revisar.hidden = true;
      opcoes.disabled = true;
      area.replaceChildren(previa(doc, 'Vai gravar no Kommo:', G.linhasDaPrevia(alt.previa), [], 'Gravar no Kommo', 'botao--primario',
        function () { return a.gravarCampos(g.leadId, alt.campos); },
        function () { area.replaceChildren(); revisar.hidden = false; opcoes.disabled = false; msg.textContent = ''; },
        msg));
    });
    return el(doc, 'section', { classe: 'guia__passo guia__passo--unidade', dados: { passo: 'unidade' } },
      el(doc, 'h2', { classe: 'guia__titulo' }, 'Primeiro: de qual unidade é este paciente?'),
      el(doc, 'p', { classe: 'nota' }, 'Esta conta do Kommo atende mais de uma unidade, e o campo ' + u.nome +
        ' está vazio. Enquanto ele estiver vazio, a Ponte não grava nem muda a etapa deste cartão.'),
      opcoes, revisar, area, msg);
  }

  /** A ⚠ Pendência do cartão: o campo fica escondido no Kommo (quem escreve é o robô de revisão). */
  function blocoDaPendencia(doc, g) {
    if (!g.pendencia) return null;
    return el(doc, 'section', { classe: 'faixa faixa--amarela', dados: { bloco: 'pendencia' } },
      el(doc, 'p', { classe: 'faixa__titulo' }, '⚠ Pendência do cartão'),
      el(doc, 'p', { classe: 'guia__pendencia' }, g.pendencia),
      el(doc, 'p', { classe: 'faixa__regra' }, 'Este aviso fica escondido no Kommo: quem escreve é o robô de revisão. Corrija o que ele diz e o aviso sai sozinho.'));
  }

  /** O que falta nesta etapa: os campos para preencher ali mesmo e a prévia antes de gravar. */
  function blocoDoQueFalta(doc, g, a, est) {
    var lista = g.faltam || [];
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-faltam' } });
    var caixa = el(doc, 'section', { classe: 'guia__passo', dados: { passo: 'faltam' } },
      el(doc, 'h2', { classe: 'guia__titulo' }, 'Falta nesta etapa' + (g.etapa ? ' (' + g.etapa + ')' : '')));
    if (!lista.length) {
      caixa.appendChild(el(doc, 'p', { classe: 'nota nota--ok', dados: { papel: 'nada-falta' } }, 'Nada faltando nesta etapa.'));
      return caixa;
    }
    lista.forEach(function (c) { caixa.appendChild(entradaDoCampo(doc, c, est.valores, c.obrigatorio ? ' · obrigatório' : '')); });
    var editaveis = lista.filter(function (c) { return c.editavel; });
    if (!editaveis.length) return caixa;
    var area = el(doc, 'div', { dados: { papel: 'area-faltam' } });
    var revisar = el(doc, 'button', { classe: 'botao', tipo: 'button', dados: { acao: 'revisar-campos' } }, 'Revisar o que vou gravar');
    revisar.addEventListener('click', function () {
      msg.textContent = '';
      var alt = G.alteracoes(editaveis, est.valores);
      if (alt.erros.length) {
        msg.textContent = alt.erros.join(' ');
        return;
      }
      if (!alt.campos.length) {
        msg.textContent = 'Preencha pelo menos um campo.';
        return;
      }
      revisar.hidden = true;
      area.replaceChildren(previa(doc, 'Vai gravar no Kommo:', G.linhasDaPrevia(alt.previa), [], 'Gravar no Kommo', 'botao--primario',
        function () { return a.gravarCampos(g.leadId, alt.campos); },
        function () { area.replaceChildren(); revisar.hidden = false; msg.textContent = ''; },
        msg));
    });
    caixa.appendChild(revisar);
    caixa.appendChild(area);
    caixa.appendChild(msg);
    return caixa;
  }

  /** Uma saída escolhida: o que falta para mover, o aviso dos robôs, as mensagens conhecidas e a confirmação. */
  function detalheDaSaida(doc, g, s, a, est) {
    var aviso = '⚠ ' + (g.avisoDosRobos || G.AVISO_DOS_ROBOS);
    var msg = el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'msg-mover' } });
    var partes = [el(doc, 'h3', { classe: 'guia__titulo' }, 'Mover para ' + s.nome)];
    if (s.bloqueio) partes.push(el(doc, 'p', { classe: 'nota nota--alerta', dados: { papel: 'bloqueio' } }, s.bloqueio));
    (s.faltam || []).forEach(function (c) { partes.push(entradaDoCampo(doc, c, est.valores, ' · obrigatório para mover', 'saida-' + s.statusId)); });
    (s.sugere || []).forEach(function (c) { partes.push(entradaDoCampo(doc, c, est.valores, ' · opcional', 'saida-' + s.statusId)); });
    partes.push(el(doc, 'p', { classe: 'guia__robos', dados: { papel: 'aviso-robos' } }, aviso));
    if (s.mensagens && s.mensagens.length) {
      partes.push(el(doc, 'div', { classe: 'guia__mensagens', dados: { papel: 'mensagens' } },
        el(doc, 'p', { classe: 'bloco__rotulo' }, 'O que os robôs desta etapa mandam'),
        el(doc, 'ul', { classe: 'guia__linhas' }, ...s.mensagens.map(function (m) { return el(doc, 'li', null, m); }))));
    }
    (s.dicas || []).forEach(function (d) { partes.push(el(doc, 'p', { classe: 'nota', dados: { papel: 'dica' } }, d)); });
    var area = el(doc, 'div', { dados: { papel: 'area-mover' } });
    var revisar = el(doc, 'button', { classe: 'botao botao--primario', tipo: 'button', dados: { acao: 'revisar-mover' }, desligado: !!s.bloqueio }, 'Revisar e mover');
    revisar.addEventListener('click', function () {
      if (revisar.disabled) return;
      msg.textContent = '';
      var p = G.podeMover(s, est.valores);
      if (p.bloqueio) {
        msg.textContent = p.bloqueio;
        return;
      }
      if (p.erros.length) {
        msg.textContent = p.erros.join(' ');
        return;
      }
      if (p.falta.length) {
        msg.textContent = 'Falta preencher: ' + p.falta.join(', ') + '.';
        return;
      }
      revisar.hidden = true;
      var linhas = G.linhasDaPrevia(p.alteracoes.previa).concat(['Etapa: ' + (g.etapa || '?') + ' → ' + s.nome]);
      area.replaceChildren(previa(doc, 'Confira antes de mover:', linhas, [el(doc, 'p', { classe: 'guia__robos' }, aviso)], 'Mover agora', 'botao--alerta',
        function () { return a.mover(g.leadId, g.statusId, s.statusId, p.alteracoes.campos); },
        function () { area.replaceChildren(); revisar.hidden = false; msg.textContent = ''; },
        msg));
    });
    partes.push(revisar, area, msg);
    return el(doc, 'div', { classe: 'guia__detalhe', dados: { saida: String(s.statusId) } }, ...partes);
  }

  /** "Para onde vai o paciente?": um botão por saída; a escolhida abre o detalhe. */
  function blocoDasSaidas(doc, g, a, est) {
    var caixa = el(doc, 'section', { classe: 'guia__passo', dados: { passo: 'saidas' } },
      el(doc, 'h2', { classe: 'guia__titulo' }, 'Para onde vai o paciente?'));
    var saidas = g.saidas || [];
    if (!saidas.length) {
      caixa.appendChild(el(doc, 'p', { classe: 'nota', dados: { papel: 'sem-saidas' } }, g.semSaidas || 'A Ponte não muda a etapa deste cartão.'));
      return caixa;
    }
    var botoes = el(doc, 'div', { classe: 'guia__saidas' });
    var detalhe = el(doc, 'div', { dados: { papel: 'saida' } });
    saidas.forEach(function (s) {
      var b = el(doc, 'button', { classe: 'guia__saida' + (est.saida === s.statusId ? ' guia__saida--escolhida' : ''), tipo: 'button', dados: { saida: String(s.statusId) } },
        el(doc, 'span', { classe: 'guia__saida-nome' }, s.nome),
        el(doc, 'span', { classe: 'guia__saida-rotulo' }, s.rotulo));
      b.addEventListener('click', function () {
        est.saida = s.statusId;
        [].forEach.call(botoes.children, function (x) { x.classList.toggle('guia__saida--escolhida', x === b); });
        detalhe.replaceChildren(detalheDaSaida(doc, g, s, a, est));
      });
      botoes.appendChild(b);
    });
    var escolhida = saidas.filter(function (s) { return s.statusId === est.saida; })[0];
    if (escolhida) detalhe.appendChild(detalheDaSaida(doc, g, escolhida, a, est));
    caixa.appendChild(botoes);
    caixa.appendChild(detalhe);
    return caixa;
  }

  /**
   * O guia "O que eu faço agora?" (`g` = a resposta de `GET …/ponte/guia`). `estado` = { valores, saida, ok } — fica com o
   * painel para o redesenho não perder o que foi digitado. `acoes`: voltar, atualizar, gravarCampos, mover (as duas
   * últimas devolvem promessa; o painel redesenha com o guia novo que o servidor devolve).
   * Na conta de duas unidades com a unidade vazia, SÓ o passo da unidade aparece.
   */
  function guia(doc, g, acoes, estado) {
    var a = acoes || {};
    var est = estado || {};
    est.valores = est.valores || {};
    var voltar = botaoAcao(doc, '← Voltar ao cartão', 'voltar-guia');
    voltar.addEventListener('click', function () { if (a.voltar) a.voltar(); });
    var atualizar = botaoAcao(doc, 'Atualizar', 'atualizar-guia');
    atualizar.addEventListener('click', function () { if (a.atualizar) a.atualizar(); });
    var partes = [
      el(doc, 'div', { classe: 'guia__topo' }, voltar, atualizar),
      el(doc, 'h1', { classe: 'cartao__nome' }, 'O que eu faço agora?'),
      el(doc, 'p', { classe: 'cartao__etapa' }, [g.nome, [g.funil, g.etapa].filter(Boolean).join(' › ')].filter(Boolean).join(' · ')),
      est.ok ? el(doc, 'p', { classe: 'nota nota--ok', dados: { papel: 'guia-ok' } }, est.ok) : null,
    ];
    if (g.unidade && g.unidade.precisa) {
      partes.push(passoDaUnidade(doc, g, a, est));
    } else {
      partes.push(blocoDaPendencia(doc, g), blocoDoQueFalta(doc, g, a, est), blocoDasSaidas(doc, g, a, est));
    }
    partes.push(el(doc, 'p', { classe: 'nota' }, 'A Ponte grava no Kommo pela chave da unidade, só quando você confirma. Ela nunca escreve no WhatsApp nem na franquia.'));
    if (g.link) partes.push(el(doc, 'a', { classe: 'botao botao--pequeno', href: g.link }, 'Abrir no Kommo'));
    return el(doc, 'section', { classe: 'cartao guia', dados: { estado: 'guia', lead: String(g.leadId) } }, ...partes);
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
    modoLigacao: modoLigacao,
    respostas: respostas,
    guia: guia,
    urlDaConversa: urlDaConversa,
    relativo: relativo,
    textoDaPausa: textoDaPausa,
    COMO: COMO,
  });
});
