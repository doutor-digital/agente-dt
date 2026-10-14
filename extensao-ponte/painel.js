/**
 * Ponte — o painel lateral (chrome.sidePanel; no Firefox, a barra lateral). Recebe do content script o que
 * identifica a conversa aberta (nome, telefone quando há, impressões das mensagens) e pergunta ao servidor qual
 * é o cartão do Kommo.
 *
 * Guarda em memória (some quando o painel fecha) só a resposta do servidor por conversa, por 2 minutos,
 * para não perguntar de novo a cada clique. Nada de conversa vai para `chrome.storage`.
 *
 * Fase 2:
 *   - aba "Fila de hoje" (`GET …/ponte/fila`): quem chamar ou ligar hoje, por etapa;
 *   - "Abrir conversa" troca a URL da aba do WhatsApp Web para `https://web.whatsapp.com/send?phone=<dígitos>` —
 *     é NAVEGAÇÃO, como clicar num link. A Ponte não digita, não clica e não envia nada no WhatsApp;
 *   - pausar e retomar a Sofia neste paciente (`POST/DELETE …/ponte/pausa`) — no Kommo, pela chave da unidade;
 *   - "Resumir com IA" (`POST …/ponte/resumo-ia`), só quando a atendente clica.
 *
 * Fase 3 (14/10/2026):
 *   - etiquetas do cartão: ver, pôr (só as que já existem na conta; ▶ pede confirmação) e tirar
 *     (`GET/POST/DELETE …/ponte/etiquetas`);
 *   - "Começar a ligar" na Fila de hoje: um paciente por vez, a Ponte abre a conversa (navegação) e a atendente
 *     clica no 📞 do WhatsApp; o resultado vai para os campos ☎ do cartão (`POST …/ponte/ligacao`). A posição
 *     fica em `chrome.storage.local` — só ids e horas, nunca nome nem telefone;
 *   - aba "Respostas" (`GET …/ponte/respostas`): copiar, nunca colar nem enviar;
 *   - a faixa de cartão duplicado vem pronta na resposta do cartão.
 *
 * Fase 4 (0.4.0):
 *   - o botão "O que eu faço agora?" abre o GUIA da etapa no lugar do cartão (`GET …/ponte/guia`): a unidade primeiro
 *     (conta de duas unidades), a ⚠ Pendência, o que falta nesta etapa e as saídas. Gravar (`POST …/ponte/campos`) e
 *     mover (`POST …/ponte/mover`) só depois da prévia e da confirmação; o servidor devolve o guia relido do Kommo;
 *   - o número no ícone (pacientes esperando resposta) é do script de fundo (`contador.js`), não deste painel.
 *
 * 0.5.0 (visual novo):
 *   - o cartão novo (`desenho.js` + `trilha.js`) entra com uma animação curta só quando o paciente muda;
 *   - a aba Respostas recebe a etapa e a unidade do cartão da tela (as sugeridas e os modelos de outra unidade);
 *   - "Abrir conversa" e "Começar a ligar" abrem pelo link wa.me da Ponte, sem recarregar (`abrir.js`, no content
 *     script); se não abrir, o jeito antigo (troca a URL). A chave fica nas opções (`semRecarregar`, ligada).
 */
(function () {
  'use strict';
  var D = self.PonteDesenho;
  var A = self.PonteAprendiz;
  var P = self.PontePausa;
  var L = self.PonteLigacao;
  var BASE = self.PONTE_CONFIG.BASE;
  var CACHE_MS = 2 * 60 * 1000;
  var FILA_CACHE_MS = 60 * 1000;
  var LISTAS_CACHE_MS = 10 * 60 * 1000;
  var ESPERA_MS = 400;
  var CHAVE_DA_LIGACAO = 'ligacao';

  var raiz = document.getElementById('conteudo');
  var raizFila = document.getElementById('fila');
  var raizRespostas = document.getElementById('respostas');
  var blocoAprendizRaiz = document.getElementById('aprendiz');
  var rotuloUnidade = document.getElementById('unidade');
  var botoesAba = {
    conversa: document.getElementById('aba-conversa'),
    fila: document.getElementById('aba-fila'),
    respostas: document.getElementById('aba-respostas'),
  };
  var config = null;
  var abaId = null;
  /** A aba do WhatsApp Web que respondeu por último (para "Abrir conversa"). */
  var abaWhatsapp = null;
  var conversa = null;
  var cache = new Map();
  var pedido = 0;
  var espera = null;
  /** A resposta do cartão que está na tela (para a pausa e o resumo atualizarem sem perguntar de novo). */
  var naTela = null;
  var secao = 'conversa';
  var filaGuardada = null;
  var pedidoFila = 0;
  /** Fase 3: as etiquetas da conta e as respostas prontas (10 min, como no servidor). */
  var etiquetasGuardadas = null;
  var respostasGuardadas = null;
  var pedidoRespostas = 0;
  var buscaDasRespostas = '';
  var nomeDasRespostas;
  /** Fase 3: o modo "Começar a ligar" (null = fora dele) e o que ficou guardado do dia. */
  var lig = null;
  var estadoGuardado = null;
  /**
   * 0.4.0: o guia aberto (null = o cartão está na tela). `estado` guarda o que a atendente digitou e a saída escolhida
   * (o redesenho não perde); `mudou` = algo foi gravado, e ao voltar o cartão é lido de novo.
   */
  var guiaAberto = null;
  var pedidoGuia = 0;
  /** O que foi digitado no guia de cada cartão (só na memória, 30 min): trocar de aba e voltar não perde. */
  var rascunhos = new Map();
  var RASCUNHO_MS = 30 * 60 * 1000;

  function trocar(no) {
    raiz.replaceChildren(no);
  }

  function botao(texto, aoClicar) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'botao';
    b.textContent = texto;
    b.addEventListener('click', aoClicar);
    return b;
  }

  function lerConfig() {
    return chrome.storage.local.get(['slug', 'chave', 'nome', 'semRecarregar']).then(function (c) {
      config = c && c.slug && c.chave
        // 0.5.0: "Abrir conversa sem recarregar" vem ligada; só a atendente desliga (nas opções)
        ? { slug: String(c.slug), chave: String(c.chave), nome: String(c.nome || '').trim().slice(0, 80), semRecarregar: c.semRecarregar !== false }
        : null;
      rotuloUnidade.textContent = config ? nomeDoSlug(config.slug) : '';
      rotuloUnidade.title = config ? config.slug : '';
    });
  }

  /** "doutor-hernia-acailandia" → "Acailandia" (até o servidor dizer o nome de verdade, com acento). */
  function nomeDoSlug(slug) {
    return String(slug || '').replace(/^doutor-hernia-/, '').split('-').filter(Boolean)
      .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
  }

  /** O nome da unidade que o servidor devolveu (`unidadeDaConta` no cartão, `unidade` na fila). */
  function nomeDaUnidade(nome) {
    if (config && typeof nome === 'string' && nome.trim()) rotuloUnidade.textContent = nome.trim().slice(0, 60);
  }

  function mostrarConfigurar() {
    var a = D.aviso(document, 'configurar', 'Configure a unidade', 'Informe o slug e a chave da unidade (a mesma do widget do cartão no Kommo).');
    a.appendChild(botao('Abrir as opções', function () { chrome.runtime.openOptionsPage(); }));
    return a;
  }

  function mostrarErro(tipo) {
    var a;
    if (tipo === 'chave') {
      a = D.aviso(document, 'erro', 'A chave da unidade não confere', 'Confira o slug e a chave nas opções da Ponte.');
      a.appendChild(botao('Abrir as opções', function () { chrome.runtime.openOptionsPage(); }));
    } else if (tipo === 'limite') {
      a = D.aviso(document, 'erro', 'Muitas consultas seguidas', 'Aguarde um minuto e troque de conversa de novo.');
    } else {
      a = D.aviso(document, 'erro', 'Não consegui falar com o servidor', 'Pode ser a internet ou o Kommo fora do ar.');
      a.appendChild(botao('Tentar de novo', function () { if (conversa) receber(conversa, true); }));
    }
    trocar(a);
  }

  /**
   * Uma chamada ao servidor da Doutor Digital com a chave da unidade. Erro vira `Error` com a frase para a
   * atendente. Corpo JSON (nada de dado de paciente na URL, que fica em log de acesso).
   */
  function chamar(metodo, caminho, corpo) {
    if (!config) return Promise.reject(new Error('Configure a unidade nas opções da Ponte.'));
    var url = BASE + '/api/public/widget/' + encodeURIComponent(config.slug) + caminho;
    var init = { method: metodo, headers: { 'X-Widget-Key': config.chave }, cache: 'no-store' };
    if (corpo) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(corpo);
    }
    return fetch(url, init).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (j) {
        if (resp.ok) return j;
        if (resp.status === 403) throw new Error('A chave da unidade não confere. Confira nas opções.');
        var e = j && typeof j.error === 'string' ? j.error : '';
        // 429 com motivo (o teto de etiquetas ▶ por hora) mostra o motivo; o do limitador é o genérico
        if (resp.status === 429 && !/^muitas chamadas/i.test(e) && e) throw new Error(e.charAt(0).toUpperCase() + e.slice(1) + '.');
        if (resp.status === 429) throw new Error('Muitas ações seguidas: aguarde um minuto.');
        if (j && j.precisaConfirmar) {
          // etiqueta que manda mensagem: o painel pergunta e tenta de novo com a confirmação
          var pede = new Error(e ? e.charAt(0).toUpperCase() + e.slice(1) + '.' : 'Confirme antes.');
          pede.precisaConfirmar = true;
          throw pede;
        }
        throw new Error(e ? e.charAt(0).toUpperCase() + e.slice(1) + '.' : 'Não consegui falar com o servidor.');
      });
    }, function () {
      throw new Error('Não consegui falar com o servidor.');
    });
  }

  /** As respostas do cartão `leadId` guardadas (cache e tela), para atualizar sem perguntar o cartão de novo. */
  function respostasDoCartao(leadId) {
    var lista = [];
    cache.forEach(function (g) { if (g.r && g.r.cartao && g.r.cartao.id === leadId) lista.push(g.r); });
    if (naTela && naTela.cartao && naTela.cartao.id === leadId && lista.indexOf(naTela) < 0) lista.push(naTela);
    return lista;
  }

  function redesenharSeNaTela(leadId) {
    // com o guia aberto, o cartão não volta para a tela por cima dele (a pausa ou a etiqueta terminou depois)
    if (guiaAberto) return;
    if (naTela && naTela.cartao && naTela.cartao.id === leadId) trocar(D.cartao(document, naTela, acoes));
  }

  /** Atualiza a pausa no cartão guardado (e na tela) sem perguntar o cartão de novo. */
  function aplicarPausa(leadId, pausaDoLead) {
    respostasDoCartao(leadId).forEach(function (r) {
      r.cartao.pausaDoLead = pausaDoLead || null;
      r.cartao.sofia = P.sofiaDepois(r.cartao.sofia, pausaDoLead);
    });
    redesenharSeNaTela(leadId);
  }

  /** As etiquetas RELIDAS do Kommo (o servidor devolve a lista depois de gravar) no cartão guardado e na tela. */
  function aplicarEtiquetas(leadId, etiquetas) {
    // sem a lista relida, não inventa: deixa como está (o cartão é relido na próxima troca de conversa)
    if (Array.isArray(etiquetas)) respostasDoCartao(leadId).forEach(function (r) { r.cartao.etiquetas = etiquetas.slice(); });
    redesenharSeNaTela(leadId);
  }

  function quem() {
    return (config && config.nome) || null;
  }

  /** Esquece o cartão guardado (ele mudou no Kommo): a próxima vez que aparecer, é lido de novo. */
  function esquecerCartao(leadId) {
    cache.forEach(function (g, k) { if (g.r && g.r.cartao && g.r.cartao.id === leadId) cache.delete(k); });
  }

  // ── 0.4.0: o guia "O que eu faço agora?" ──

  function desenharGuia() {
    if (!guiaAberto || !guiaAberto.g) return;
    trocar(D.guia(document, guiaAberto.g, acoesDoGuia, guiaAberto.estado));
  }

  /** Abre (ou relê) o guia do cartão. Trocar de conversa no meio descarta a resposta. */
  function abrirGuia(leadId) {
    var id = ++pedidoGuia;
    var daConversa = pedido;
    var mesmo = guiaAberto && guiaAberto.leadId === leadId;
    var r = rascunhos.get(leadId);
    var estado = mesmo ? guiaAberto.estado : r && Date.now() - r.em < RASCUNHO_MS ? r.estado : { valores: {}, saida: null };
    if (rascunhos.size > 50) rascunhos.clear();
    rascunhos.set(leadId, { em: Date.now(), estado: estado });
    guiaAberto = { leadId: leadId, g: null, estado: estado, mudou: mesmo ? guiaAberto.mudou : false, como: mesmo ? guiaAberto.como : (naTela && naTela.como) || null };
    trocar(D.aviso(document, 'procurando', 'Abrindo o guia…'));
    chamar('GET', '/ponte/guia?leadId=' + encodeURIComponent(leadId)).then(function (g) {
      if (id !== pedidoGuia || daConversa !== pedido || !guiaAberto || guiaAberto.leadId !== leadId) return;
      guiaAberto.g = g;
      guiaAberto.estado.ok = '';
      desenharGuia();
    }, function (e) {
      if (id !== pedidoGuia || daConversa !== pedido || !guiaAberto) return;
      var a = D.aviso(document, 'erro', 'Não consegui abrir o guia', e && e.message);
      a.appendChild(botao('Tentar de novo', function () { abrirGuia(leadId); }));
      a.appendChild(botao('Voltar ao cartão', voltarDoGuia));
      trocar(a);
    });
  }

  /** Volta ao cartão. Se algo foi gravado, o cartão é lido de novo (a etapa e o resumo mudaram). */
  function voltarDoGuia() {
    var g = guiaAberto;
    guiaAberto = null;
    if (g && g.mudou) {
      esquecerCartao(g.leadId);
      // achado pela busca (ou escolhido na lista): relê o MESMO cartão; senão, a conversa procura de novo
      if (g.como === 'manual' || !conversa) return buscar({ lead: g.leadId }, conversa && conversa.chave, true);
      return receber(conversa, true);
    }
    if (naTela) return trocar(D.cartao(document, naTela, acoes));
    if (conversa) receber(conversa, true);
  }

  /** O servidor gravou: o guia novo (relido do Kommo) entra na tela, com o que foi feito no topo. */
  function depoisDeGravar(leadId, j, texto) {
    esquecerCartao(leadId);
    if (!guiaAberto || guiaAberto.leadId !== leadId) return;
    guiaAberto.mudou = true;
    if (j && j.guia) guiaAberto.g = j.guia;
    guiaAberto.estado = { valores: {}, saida: null, ok: texto };
    rascunhos.set(leadId, { em: Date.now(), estado: guiaAberto.estado });
    desenharGuia();
  }

  function listaGravada(j) {
    return ((j && j.gravados) || []).map(function (x) { return x.nome + ': ' + x.texto; }).join('; ');
  }

  var acoesDoGuia = {
    voltar: function () { voltarDoGuia(); },
    atualizar: function () { if (guiaAberto) abrirGuia(guiaAberto.leadId); },
    gravarCampos: function (leadId, campos) {
      return chamar('POST', '/ponte/campos', { leadId: leadId, campos: campos, por: quem() }).then(function (j) {
        var feito = listaGravada(j);
        depoisDeGravar(leadId, j, feito ? 'Gravado no Kommo: ' + feito + '.' : 'Nada mudou: o cartão já estava assim.');
      });
    },
    mover: function (leadId, de, para, campos) {
      // só chega aqui depois da prévia e do "Mover agora": é a confirmação explícita que o servidor exige
      return chamar('POST', '/ponte/mover', { leadId: leadId, de: de, para: para, campos: campos || [], por: quem(), confirmado: true }).then(function (j) {
        var feito = listaGravada(j);
        depoisDeGravar(leadId, j, 'Movido para ' + ((j && j.para) || 'a nova etapa') + '.' + (feito ? ' Gravado junto: ' + feito + '.' : ''));
      });
    },
  };

  var acoes = {
    escolher: function (leadId) {
      buscar({ lead: leadId }, conversa && conversa.chave, true);
    },
    buscar: function (nome) {
      buscar({ nome: nome, manual: true }, conversa && conversa.chave, true);
    },
    pausar: function (leadId, p) {
      return chamar('POST', '/ponte/pausa', { leadId: leadId, ate: p.ate, motivo: p.motivo || null, por: (config && config.nome) || null })
        .then(function (j) { aplicarPausa(leadId, j.pausaDoLead); });
    },
    retomar: function (leadId) {
      return chamar('DELETE', '/ponte/pausa', { leadId: leadId, por: (config && config.nome) || null })
        .then(function (j) { aplicarPausa(leadId, j.pausaDoLead); });
    },
    resumirComIa: function (leadId) {
      return chamar('POST', '/ponte/resumo-ia', { leadId: leadId }).then(function (j) {
        var res = { linhas: j.linhas || [], aviso: j.aviso || null, ia: !!j.ia };
        // guarda junto do cartão: trocar de conversa e voltar não perde (nem gasta de novo)
        cache.forEach(function (g) { if (g.r && g.r.cartao && g.r.cartao.id === leadId) g.r.resumoIa = res; });
        if (naTela && naTela.cartao && naTela.cartao.id === leadId) naTela.resumoIa = res;
        return res;
      });
    },
    semNome: function () {
      return !(config && config.nome);
    },
    // 0.4.0: o guia da etapa
    abrirGuia: function (leadId) { abrirGuia(leadId); },
    // fase 3: etiquetas
    listarEtiquetas: function () {
      if (etiquetasGuardadas && Date.now() - etiquetasGuardadas.em < LISTAS_CACHE_MS) return Promise.resolve(etiquetasGuardadas.lista);
      return chamar('GET', '/ponte/etiquetas').then(function (j) {
        etiquetasGuardadas = { em: Date.now(), lista: j.etiquetas || [] };
        return etiquetasGuardadas.lista;
      });
    },
    porEtiqueta: function (leadId, nome, confirmado) {
      return chamar('POST', '/ponte/etiquetas', { leadId: leadId, nome: nome, por: quem(), confirmado: !!confirmado })
        .then(function (j) { aplicarEtiquetas(leadId, j.etiquetas); });
    },
    tirarEtiqueta: function (leadId, nome) {
      return chamar('DELETE', '/ponte/etiquetas', { leadId: leadId, nome: nome, por: quem() })
        .then(function (j) { aplicarEtiquetas(leadId, j.etiquetas); });
    },
  };

  /** 0.5.0: o cartão entra com uma animação curta só quando o PACIENTE muda (pausar ou pôr etiqueta não pisca). */
  var ultimoNaTela = null;

  function desenhar(r) {
    guiaAberto = null;
    naTela = r && r.achado && r.cartao ? r : null;
    if (r && r.unidadeDaConta) nomeDaUnidade(r.unidadeDaConta);
    if (naTela) {
      var no = D.cartao(document, r, acoes);
      if (ultimoNaTela !== r.cartao.id) no.classList.add('entra');
      ultimoNaTela = r.cartao.id;
      trocar(no);
    }
    else if (r && r.candidatos && r.candidatos.length) trocar(D.candidatos(document, r, acoes));
    else trocar(D.nada(document, r, acoes, conversa && conversa.fonteTelefone !== 'cabecalho' ? conversa.nome : ''));
    atualizarNomeDasRespostas();
  }

  function corpoDaConversa(c) {
    var p = {};
    if (c.telefone) p.telefone = c.telefone;
    // quando o cabeçalho É o número, ele já foi como telefone; mandar de novo como nome só atrapalha
    if (c.nome && c.fonteTelefone !== 'cabecalho') p.nome = c.nome;
    if (c.impressoes && c.impressoes.length) p.impressoes = c.impressoes.slice(0, 8);
    return p;
  }

  /**
   * Pergunta ao servidor. `chaveDaConversa` guarda a resposta para esta conversa: cartão achado vale por
   * 2 min mesmo que cheguem mensagens novas; "não achei" só vale enquanto as impressões forem as mesmas
   * (uma mensagem nova pode ser justamente a que faltava para casar).
   *
   * POST com corpo JSON: nome e telefone do paciente não vão na URL (que fica em log de acesso).
   */
  function buscar(corpo, chaveDaConversa, manual) {
    var id = ++pedido;
    var assinatura = JSON.stringify(corpo);
    var guardado = chaveDaConversa ? cache.get(chaveDaConversa) : null;
    if (!manual && guardado && Date.now() - guardado.em < CACHE_MS && (guardado.r.achado || guardado.assinatura === assinatura)) {
      desenhar(guardado.r);
      return;
    }
    if (!config) return trocar(mostrarConfigurar());
    naTela = null;
    atualizarNomeDasRespostas();
    trocar(D.aviso(document, 'procurando', 'Procurando o cartão…'));
    var url = BASE + '/api/public/widget/' + encodeURIComponent(config.slug) + '/ponte/cartao';
    fetch(url, {
      method: 'POST',
      headers: { 'X-Widget-Key': config.chave, 'Content-Type': 'application/json' },
      body: assinatura,
      cache: 'no-store',
    })
      .then(function (resp) {
        if (resp.status === 403) throw { tipo: 'chave' };
        if (resp.status === 429) throw { tipo: 'limite' };
        if (!resp.ok) throw { tipo: 'servidor' };
        return resp.json();
      })
      .then(function (r) {
        if (id !== pedido) return; // a atendente já trocou de conversa
        if (chaveDaConversa && (r.achado || !manual)) cache.set(chaveDaConversa, { em: Date.now(), r: r, assinatura: manual ? null : assinatura });
        desenhar(r);
      })
      .catch(function (e) {
        if (id !== pedido) return;
        mostrarErro(e && e.tipo);
      });
  }

  function receber(c, forcar) {
    conversa = c;
    clearTimeout(espera);
    pedido++; // qualquer resposta pendente é de outra conversa
    naTela = null;
    guiaAberto = null; // outra conversa: o guia do paciente anterior fecha
    // outra conversa: a resposta pronta não pode sair com o nome do paciente anterior
    atualizarNomeDasRespostas();
    if (!config) return trocar(mostrarConfigurar());
    if (!c) {
      return trocar(D.aviso(document, 'sem-whatsapp', 'Abra o WhatsApp Web nesta janela',
        'A Ponte mostra o cartão do Kommo da conversa aberta em web.whatsapp.com. Se ele já está aberto, recarregue a página dele (F5): ' +
        'a aba aberta antes de instalar ou atualizar a Ponte não é lida até recarregar.'));
    }
    if (!c.aberta) return trocar(D.aviso(document, 'sem-conversa', 'Abra uma conversa', 'Clique numa conversa no WhatsApp Web.'));
    if (c.tipo === 'grupo') return trocar(D.aviso(document, 'grupo', 'Conversa de grupo', 'A Ponte só procura cartão de paciente.'));
    if (!c.telefone && !c.nome && !(c.impressoes && c.impressoes.length)) return desenhar({ achado: false });
    if (forcar && c.chave) cache.delete(c.chave);
    // espera a atendente parar de clicar: passar por 5 conversas não vira 5 consultas
    espera = setTimeout(function () { buscar(corpoDaConversa(c), c.chave, false); }, ESPERA_MS);
  }

  function pedirConversaAtual() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (abas) {
      var aba = abas && abas[0];
      abaId = aba ? aba.id : null;
      if (abaId == null) return receber(null);
      var essa = abaId;
      return chrome.tabs.sendMessage(essa, { tipo: 'ponte:qual-conversa' }).then(
        function (estado) {
          abaWhatsapp = essa; // respondeu: é o WhatsApp Web, com a Ponte rodando
          receber(estado || null);
        },
        function () { receber(null); }, // a aba ativa não é o WhatsApp Web
      );
    });
  }

  // ── fase 2: a fila do dia ──

  /**
   * 0.5.0: pede ao content script para abrir a conversa pelo link wa.me da Ponte (sem recarregar). Resolve `true` se
   * abriu; `false` se não (o WhatsApp não tratou o link, a conversa não apareceu em ~4 s, ou a aba tem o script de uma
   * versão antiga) — e aí quem chamou usa o jeito antigo.
   */
  function abrirSemRecarregar(aba, telefone) {
    return chrome.tabs.sendMessage(aba, { tipo: 'ponte:abrir-conversa', telefone: String(telefone) }).then(function (r) {
      if (r && r.aberta) return true;
      console.info('[Ponte] a conversa não abriu pelo link wa.me (' + ((r && r.motivo) || 'sem resposta') + '): abrindo pelo jeito antigo, com recarga.');
      return false;
    }, function (e) {
      console.info('[Ponte] o WhatsApp Web não respondeu ao link wa.me (' + ((e && e.message) || 'sem resposta') + '): abrindo pelo jeito antigo, com recarga.');
      return false;
    });
  }

  /**
   * "Abrir conversa": abre o chat do telefone na aba do WhatsApp Web. NAVEGAÇÃO — nada é digitado nem enviado.
   * 0.5.0: primeiro pelo link wa.me da própria Ponte, sem recarregar (`abrir.js`, no content script); se não abrir,
   * o jeito antigo: troca a URL da aba para `web.whatsapp.com/send?phone=…` (o WhatsApp Web recarrega). Com a chave
   * "Abrir conversa sem recarregar" desligada nas opções, vai direto pelo jeito antigo.
   * `ficar`: no modo "Começar a ligar" o painel fica na fila (é lá que estão os botões de resultado).
   */
  function abrirConversa(telefone, ficar) {
    var url = D.urlDaConversa(telefone);
    if (!url) return Promise.reject(new Error('Telefone inválido.'));
    var aba = abaWhatsapp;
    if (aba == null) return Promise.reject(new Error('Abra o WhatsApp Web nesta janela primeiro.'));
    // Antes de navegar, confirma que a aba AINDA é o WhatsApp Web: só lá a Ponte responde. Se a atendente
    // abriu outra coisa nela (o Kommo, por exemplo), a Ponte não pode trocar a página dela.
    return chrome.tabs.sendMessage(aba, { tipo: 'ponte:qual-conversa' }).then(
      function () {
        var link = config && config.semRecarregar !== false ? abrirSemRecarregar(aba, telefone) : Promise.resolve(false);
        return link.then(function (abriu) {
          // abriu sem recarregar: só traz a aba para a frente (sem trocar a URL, não recarrega)
          return abriu ? chrome.tabs.update(aba, { active: true }) : chrome.tabs.update(aba, { url: url, active: true });
        }).then(function () { if (!ficar) mostrarSecao('conversa'); });
      },
      function () {
        if (abaWhatsapp === aba) abaWhatsapp = null;
        throw new Error('Não achei o WhatsApp Web aberto. Abra (ou recarregue) a aba dele nesta janela e tente de novo.');
      });
  }

  function copiarAntigo(texto) {
    var t = document.createElement('textarea');
    t.value = texto;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    t.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('Não consegui copiar. Selecione o número e copie.'));
  }

  /** Copia para a área de transferência (para ligar). Só copia: não disca, não envia. */
  function copiar(texto) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(texto).catch(function () { return copiarAntigo(texto); });
    }
    return copiarAntigo(texto);
  }

  var acoesDaFila = {
    atualizar: function () { carregarFila(true); },
    abrirConversa: function (telefone) { return abrirConversa(telefone, false); },
    copiar: copiar,
    comecarLigacao: function () { comecarLigacao(); },
    feitosHoje: function () {
      if (!estadoGuardado || !filaGuardada || !config) return 0;
      var e = L.estadoDoDia(estadoGuardado, L.diaLocal(new Date(Date.now())), config.slug, Date.now());
      return L.feitosNaFila(L.filaDeLigacao(filaGuardada.f), e);
    },
  };

  /** 0.5.0: o total da fila no botão da aba (depois da 1ª leitura). */
  function mostrarTotalDaFila(f) {
    var n = document.getElementById('aba-fila-total');
    if (!n) return;
    var total = ((f && f.grupos) || []).reduce(function (s, g) { return s + (g.total || 0); }, 0);
    n.textContent = total ? String(total) : '';
    n.hidden = !total;
  }

  function carregarFila(forcar) {
    if (lig) return desenharLigacao();
    if (!config) return raizFila.replaceChildren(mostrarConfigurar());
    if (!forcar && filaGuardada && Date.now() - filaGuardada.em < FILA_CACHE_MS) {
      return raizFila.replaceChildren(D.fila(document, filaGuardada.f, acoesDaFila, new Date()));
    }
    var id = ++pedidoFila;
    raizFila.replaceChildren(D.aviso(document, 'procurando', 'Montando a fila de hoje…'));
    chamar('GET', '/ponte/fila').then(function (f) {
      if (id !== pedidoFila || lig) return;
      filaGuardada = { em: Date.now(), f: f };
      mostrarTotalDaFila(f);
      nomeDaUnidade(f && f.unidade);
      raizFila.replaceChildren(D.fila(document, f, acoesDaFila, new Date()));
    }, function (e) {
      if (id !== pedidoFila) return;
      var a = D.aviso(document, 'erro', 'Não consegui montar a fila', e && e.message);
      a.appendChild(botao('Tentar de novo', function () { carregarFila(true); }));
      raizFila.replaceChildren(a);
    });
  }

  // ── fase 3: "Começar a ligar" ──
  // A Ponte abre a conversa (navegação) e a atendente clica no 📞 do WhatsApp. Ela nunca clica, digita nem envia.

  function salvarLigacao() {
    if (!lig) return;
    estadoGuardado = lig.estado;
    var o = {};
    o[CHAVE_DA_LIGACAO] = lig.estado; // só ids e horas — nunca nome nem telefone
    chrome.storage.local.set(o).catch(function () {});
  }

  function pararRelogio() {
    if (lig && lig.relogio) clearInterval(lig.relogio);
    if (lig) lig.relogio = null;
  }

  function vistaDaLigacao() {
    var feitos = L.feitosNaFila(lig.itens, lig.estado);
    return {
      item: lig.item,
      fase: lig.fase,
      esperaAte: lig.esperaAte,
      motivoEspera: lig.motivoEspera,
      posicao: Math.min(lig.itens.length, feitos + 1),
      total: lig.itens.length,
      pulados: lig.pulados,
      naoLidos: lig.naoLidos,
      aviso: lig.aviso,
      gravando: lig.gravando,
      ritmo: lig.ritmo,
      msg: lig.msg,
      ultimo: lig.ultimo,
    };
  }

  function desenharLigacao() {
    if (!lig) return;
    raizFila.replaceChildren(D.modoLigacao(document, vistaDaLigacao(), acoesDaLigacao, new Date(Date.now())));
  }

  /** Abre a conversa do paciente da vez. Só conta no ritmo se abriu de verdade. */
  function abrirDaVez() {
    var it = lig.item;
    lig.fase = 'abrindo';
    lig.msg = '';
    desenharLigacao();
    abrirConversa(it.telefone, true).then(function () {
      if (!lig || lig.item !== it) return;
      // conta no ritmo e começa uma TENTATIVA nova: o id vai junto do resultado e o servidor grava uma vez só
      lig.estado = L.registrarAbertura(lig.estado, it.leadId, Date.now(), L.novaTentativa());
      salvarLigacao();
      lig.fase = 'aberto';
      desenharLigacao();
    }, function (e) {
      if (!lig || lig.item !== it) return;
      lig.fase = 'erro';
      lig.msg = (e && e.message) || 'Não consegui abrir a conversa.';
      desenharLigacao();
    });
  }

  /** Espera o ritmo (intervalo e teto por hora) e abre. A contagem aparece na tela. */
  function agendarAbertura() {
    pararRelogio();
    var q = L.quandoPodeAbrir(lig.estado, Date.now(), lig.ritmo);
    if (q.em <= Date.now()) return abrirDaVez();
    lig.fase = 'esperando';
    lig.esperaAte = q.em;
    lig.motivoEspera = q.motivo;
    desenharLigacao();
    lig.relogio = setInterval(function () {
      if (!lig || lig.fase !== 'esperando') return pararRelogio();
      var falta = lig.esperaAte - Date.now();
      if (falta <= 0) {
        pararRelogio();
        return abrirDaVez();
      }
      var n = raizFila.querySelector('[data-papel="espera"]');
      if (n) n.textContent = L.textoDaEspera(falta);
    }, 1000);
  }

  /**
   * O próximo da fila. Sem telefone: se o servidor AFIRMA que não tem, pula de vez (com aviso e marcado como
   * feito); se só não deu para ler agora, deixa para depois SEM marcar nada. O que já está aberto não abre de novo.
   */
  function avancar() {
    pararRelogio();
    for (;;) {
      var it = L.proximo(lig.itens, lig.estado, lig.naoLidos.map(function (p) { return p.leadId; }));
      if (!it) {
        lig.item = null;
        lig.fase = 'fim';
        salvarLigacao();
        return desenharLigacao();
      }
      if (L.temTelefone(it)) {
        lig.item = it;
        break;
      }
      if (L.semTelefoneConfirmado(it)) {
        lig.pulados.push({ leadId: it.leadId, nome: it.nome, link: it.link });
        lig.estado = L.marcarFeito(lig.estado, it.leadId);
      } else {
        lig.naoLidos.push({ leadId: it.leadId, nome: it.nome, link: it.link });
      }
    }
    salvarLigacao();
    if (lig.estado.atual === lig.item.leadId) {
      // o painel foi fechado com esta conversa aberta: não abre de novo nem conta no ritmo (e a tentativa segue a mesma)
      if (!lig.estado.tentativa) lig.estado.tentativa = L.novaTentativa();
      salvarLigacao();
      lig.fase = 'aberto';
      return desenharLigacao();
    }
    // pausada, a fila não abre ninguém sozinha (o "Pular este" só passa para o próximo)
    if (lig.fase === 'pausado') return desenharLigacao();
    agendarAbertura();
  }

  function comecarLigacao() {
    if (!config || !filaGuardada) return;
    var itens = L.filaDeLigacao(filaGuardada.f);
    if (!itens.length) return;
    lig = {
      itens: itens,
      ritmo: L.ritmoDe(filaGuardada.f.ritmo),
      estado: L.estadoDoDia(estadoGuardado, L.diaLocal(new Date(Date.now())), config.slug, Date.now()),
      item: null,
      fase: 'esperando',
      pulados: [],
      naoLidos: [],
      aviso: filaGuardada.f.avisoTelefones || '',
      gravando: false,
      msg: '',
      ultimo: '',
      relogio: null,
    };
    avancar();
  }

  function sairDaLigacao() {
    pararRelogio();
    lig = null;
    carregarFila(false);
  }

  var acoesDaLigacao = {
    resultado: function (leadId, resultado) {
      // uma gravação por vez: os botões ficam travados até o servidor responder, mesmo se a tela for redesenhada
      if (!lig || lig.gravando) return Promise.resolve();
      var it = lig.item;
      lig.gravando = true;
      lig.msg = '';
      desenharLigacao();
      return chamar('POST', '/ponte/ligacao', { leadId: leadId, resultado: resultado, por: quem(), tentativa: lig.estado.tentativa || null }).then(function (j) {
        if (!lig) return;
        lig.gravando = false;
        var gravado = (j && j.resultado) || resultado;
        var rotulo = (L.RESULTADOS.filter(function (r) { return r.id === gravado; })[0] || {}).rotulo || gravado;
        lig.ultimo = 'Gravado no Kommo: ' + ((it && it.nome) || 'cartão ' + leadId) + ' · ' + rotulo.toLowerCase() +
          (j && j.avisos && j.avisos.length ? ' (' + j.avisos.join(' ') + ')' : '');
        lig.estado = L.marcarFeito(lig.estado, leadId);
        avancar();
      }, function (e) {
        if (!lig) return;
        lig.gravando = false;
        lig.msg = (e && e.message) || 'Não consegui gravar a ligação agora. Tente de novo.';
        desenharLigacao();
      });
    },
    pular: function () {
      if (!lig || !lig.item || lig.gravando) return;
      lig.ultimo = 'Pulado (nada gravado): ' + (lig.item.nome || 'cartão ' + lig.item.leadId);
      lig.msg = '';
      lig.estado = L.marcarFeito(lig.estado, lig.item.leadId);
      avancar();
    },
    pausar: function () {
      if (!lig || lig.fase !== 'esperando') return;
      pararRelogio();
      lig.fase = 'pausado';
      desenharLigacao();
    },
    continuar: function () {
      if (!lig) return;
      lig.fase = 'esperando';
      avancar();
    },
    reabrir: function () {
      if (!lig || !lig.item) return;
      if (lig.fase === 'erro') return abrirDaVez();
      // a mesma conversa de novo: não conta no ritmo
      abrirConversa(lig.item.telefone, true).catch(function (e) {
        if (!lig) return;
        lig.msg = (e && e.message) || 'Não consegui abrir a conversa.';
        desenharLigacao();
      });
    },
    recomecar: function () {
      if (!lig) return;
      lig.estado = { v: 1, dia: lig.estado.dia, slug: lig.estado.slug, feitos: [], atual: null, tentativa: null, aberturas: lig.estado.aberturas };
      lig.pulados = [];
      lig.naoLidos = [];
      lig.ultimo = '';
      avancar();
    },
    sair: sairDaLigacao,
  };

  // ── fase 3: respostas prontas (só copiar) ──

  function primeiroNomeNaTela() {
    return (naTela && naTela.cartao && naTela.cartao.primeiroNome) || null;
  }

  /**
   * 0.5.0: a etapa e a unidade do cartão na tela, para as respostas sugeridas (e para esconder os modelos de outra
   * unidade). Sem cartão na tela: nada sugerido, todos os modelos.
   */
  function contextoDasRespostas() {
    var c = naTela && naTela.cartao;
    if (!c) return {};
    var b = c.barraTratamento && c.barraTratamento.noFunil ? c.barraTratamento : c.barra;
    var atual = ((b && b.etapas) || []).filter(function (e) { return e.atual; })[0];
    // a unidade do cartão (o campo, na 0.5.0; no servidor de antes, a da franquia — e nada se ela pediu a unidade)
    var u = self.PonteTrilha.unidadeDoCartao(c, naTela.franquia);
    var opcoes = c.unidade && typeof c.unidade === 'object' && Array.isArray(c.unidade.opcoes) ? c.unidade.opcoes : null;
    return {
      etapa: (atual && atual.nome) || c.etapa || null,
      unidade: u && u.nome ? u.nome : null,
      unidades: opcoes,
    };
  }

  function chaveDasRespostas() {
    var x = contextoDasRespostas();
    return [primeiroNomeNaTela() || '', x.etapa || '', x.unidade || ''].join('|');
  }

  var acoesDasRespostas = {
    atualizar: function () { carregarRespostas(true); },
    copiar: copiar,
    aoBuscar: function (t) { buscaDasRespostas = t; },
  };

  function desenharRespostas() {
    nomeDasRespostas = chaveDasRespostas();
    raizRespostas.replaceChildren(D.respostas(document, respostasGuardadas.r, acoesDasRespostas, primeiroNomeNaTela(), buscaDasRespostas, contextoDasRespostas()));
  }

  /** O paciente da tela mudou: a lista é redesenhada com o nome, a etapa e a unidade novos (ou sem, enquanto procura). */
  function atualizarNomeDasRespostas() {
    if (secao === 'respostas' && respostasGuardadas && chaveDasRespostas() !== nomeDasRespostas) desenharRespostas();
  }

  function carregarRespostas(forcar) {
    if (!config) return raizRespostas.replaceChildren(mostrarConfigurar());
    if (!forcar && respostasGuardadas && Date.now() - respostasGuardadas.em < LISTAS_CACHE_MS) return desenharRespostas();
    var id = ++pedidoRespostas;
    raizRespostas.replaceChildren(D.aviso(document, 'procurando', 'Lendo as respostas prontas…'));
    chamar('GET', '/ponte/respostas').then(function (r) {
      if (id !== pedidoRespostas) return;
      respostasGuardadas = { em: Date.now(), r: r };
      desenharRespostas();
    }, function (e) {
      if (id !== pedidoRespostas) return;
      var a = D.aviso(document, 'erro', 'Não consegui ler as respostas prontas', e && e.message);
      a.appendChild(botao('Tentar de novo', function () { carregarRespostas(true); }));
      raizRespostas.replaceChildren(a);
    });
  }

  function mostrarSecao(nome) {
    secao = nome === 'fila' || nome === 'respostas' ? nome : 'conversa';
    raiz.hidden = secao !== 'conversa';
    blocoAprendizRaiz.hidden = secao !== 'conversa';
    raizFila.hidden = secao !== 'fila';
    raizRespostas.hidden = secao !== 'respostas';
    Object.keys(botoesAba).forEach(function (k) { botoesAba[k].setAttribute('aria-selected', String(k === secao)); });
    if (secao === 'fila') carregarFila(false);
    if (secao === 'respostas') carregarRespostas(false);
  }

  botoesAba.conversa.addEventListener('click', function () { mostrarSecao('conversa'); });
  botoesAba.fila.addEventListener('click', function () { mostrarSecao('fila'); });
  botoesAba.respostas.addEventListener('click', function () { mostrarSecao('respostas'); });

  chrome.runtime.onMessage.addListener(function (msg, remetente) {
    if (!msg || msg.tipo !== 'ponte:conversa') return;
    // só a aba ativa desta janela manda no painel (pode haver outro WhatsApp aberto em outra janela)
    if (!remetente.tab || remetente.tab.id !== abaId) return;
    abaWhatsapp = abaId;
    var antes = conversa && conversa.chave;
    var estado = msg.estado;
    // mesma conversa, só chegou mensagem e o cartão já está na tela: não pisca o "procurando"
    if (estado && antes && estado.chave === antes) {
      // o guia aberto não fecha com uma mensagem nova na MESMA conversa (a atendente pode estar digitando nele)
      if (guiaAberto) {
        conversa = estado;
        return;
      }
      var g = cache.get(antes);
      if (g && g.r.achado && Date.now() - g.em < CACHE_MS) {
        conversa = estado;
        return;
      }
    }
    receber(estado);
  });
  chrome.tabs.onActivated.addListener(function () { pedirConversaAtual(); });
  chrome.storage.onChanged.addListener(function (mudou, area) {
    if (area !== 'local') return;
    if (mudou.slug || mudou.chave) {
      cache.clear();
      filaGuardada = null;
      etiquetasGuardadas = null;
      respostasGuardadas = null;
      if (lig) {
        pararRelogio();
        lig = null;
      }
      lerConfig().then(function () {
        pedirConversaAtual();
        if (secao === 'fila') carregarFila(true);
        if (secao === 'respostas') carregarRespostas(true);
      });
    } else if (mudou.nome || mudou.semRecarregar) {
      lerConfig();
    }
  });

  var blocoAprendiz = D.aprendiz(document, A.DICAS);
  if (blocoAprendiz) blocoAprendizRaiz.appendChild(blocoAprendiz);
  // a posição da fila de ligações do dia (fechar o painel não perde)
  chrome.storage.local.get([CHAVE_DA_LIGACAO]).then(function (c) {
    estadoGuardado = (c && c[CHAVE_DA_LIGACAO]) || null;
  }, function () {});
  lerConfig().then(pedirConversaAtual);
})();
