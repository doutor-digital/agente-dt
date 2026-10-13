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
 */
(function () {
  'use strict';
  var D = self.PonteDesenho;
  var A = self.PonteAprendiz;
  var P = self.PontePausa;
  var BASE = self.PONTE_CONFIG.BASE;
  var CACHE_MS = 2 * 60 * 1000;
  var FILA_CACHE_MS = 60 * 1000;
  var ESPERA_MS = 400;

  var raiz = document.getElementById('conteudo');
  var raizFila = document.getElementById('fila');
  var blocoAprendizRaiz = document.getElementById('aprendiz');
  var rotuloUnidade = document.getElementById('unidade');
  var botoesAba = { conversa: document.getElementById('aba-conversa'), fila: document.getElementById('aba-fila') };
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
    return chrome.storage.local.get(['slug', 'chave', 'nome']).then(function (c) {
      config = c && c.slug && c.chave
        ? { slug: String(c.slug), chave: String(c.chave), nome: String(c.nome || '').trim().slice(0, 80) }
        : null;
      rotuloUnidade.textContent = config ? config.slug : '';
    });
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
        if (resp.status === 429) throw new Error('Muitas ações seguidas: aguarde um minuto.');
        var e = j && typeof j.error === 'string' ? j.error : '';
        throw new Error(e ? e.charAt(0).toUpperCase() + e.slice(1) + '.' : 'Não consegui falar com o servidor.');
      });
    }, function () {
      throw new Error('Não consegui falar com o servidor.');
    });
  }

  /** Atualiza a pausa no cartão guardado (e na tela) sem perguntar o cartão de novo. */
  function aplicarPausa(leadId, pausaDoLead) {
    var respostas = [];
    cache.forEach(function (g) { if (g.r && g.r.cartao && g.r.cartao.id === leadId) respostas.push(g.r); });
    if (naTela && naTela.cartao && naTela.cartao.id === leadId && respostas.indexOf(naTela) < 0) respostas.push(naTela);
    respostas.forEach(function (r) {
      r.cartao.pausaDoLead = pausaDoLead || null;
      r.cartao.sofia = P.sofiaDepois(r.cartao.sofia, pausaDoLead);
    });
    if (naTela && naTela.cartao && naTela.cartao.id === leadId) trocar(D.cartao(document, naTela, acoes));
  }

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
  };

  function desenhar(r) {
    naTela = r && r.achado && r.cartao ? r : null;
    if (naTela) trocar(D.cartao(document, r, acoes));
    else if (r && r.candidatos && r.candidatos.length) trocar(D.candidatos(document, r, acoes));
    else trocar(D.nada(document, r, acoes, conversa && conversa.fonteTelefone !== 'cabecalho' ? conversa.nome : ''));
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
   * "Abrir conversa": troca a URL da aba do WhatsApp Web para o chat do telefone. NAVEGAÇÃO — o mesmo que clicar
   * num link do WhatsApp; nada é digitado nem enviado. O WhatsApp Web recarrega e abre a conversa.
   */
  function abrirConversa(telefone) {
    var url = D.urlDaConversa(telefone);
    if (!url) return Promise.reject(new Error('Telefone inválido.'));
    var aba = abaWhatsapp;
    if (aba == null) return Promise.reject(new Error('Abra o WhatsApp Web nesta janela primeiro.'));
    // Antes de navegar, confirma que a aba AINDA é o WhatsApp Web: só lá a Ponte responde. Se a atendente
    // abriu outra coisa nela (o Kommo, por exemplo), a Ponte não pode trocar a página dela.
    return chrome.tabs.sendMessage(aba, { tipo: 'ponte:qual-conversa' }).then(
      function () {
        return chrome.tabs.update(aba, { url: url, active: true }).then(function () { mostrarSecao('conversa'); });
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
    abrirConversa: abrirConversa,
    copiar: copiar,
  };

  function carregarFila(forcar) {
    if (!config) return raizFila.replaceChildren(mostrarConfigurar());
    if (!forcar && filaGuardada && Date.now() - filaGuardada.em < FILA_CACHE_MS) {
      return raizFila.replaceChildren(D.fila(document, filaGuardada.f, acoesDaFila, new Date()));
    }
    var id = ++pedidoFila;
    raizFila.replaceChildren(D.aviso(document, 'procurando', 'Montando a fila de hoje…'));
    chamar('GET', '/ponte/fila').then(function (f) {
      if (id !== pedidoFila) return;
      filaGuardada = { em: Date.now(), f: f };
      raizFila.replaceChildren(D.fila(document, f, acoesDaFila, new Date()));
    }, function (e) {
      if (id !== pedidoFila) return;
      var a = D.aviso(document, 'erro', 'Não consegui montar a fila', e && e.message);
      a.appendChild(botao('Tentar de novo', function () { carregarFila(true); }));
      raizFila.replaceChildren(a);
    });
  }

  function mostrarSecao(nome) {
    secao = nome === 'fila' ? 'fila' : 'conversa';
    raiz.hidden = secao !== 'conversa';
    blocoAprendizRaiz.hidden = secao !== 'conversa';
    raizFila.hidden = secao !== 'fila';
    Object.keys(botoesAba).forEach(function (k) { botoesAba[k].setAttribute('aria-selected', String(k === secao)); });
    if (secao === 'fila') carregarFila(false);
  }

  botoesAba.conversa.addEventListener('click', function () { mostrarSecao('conversa'); });
  botoesAba.fila.addEventListener('click', function () { mostrarSecao('fila'); });

  chrome.runtime.onMessage.addListener(function (msg, remetente) {
    if (!msg || msg.tipo !== 'ponte:conversa') return;
    // só a aba ativa desta janela manda no painel (pode haver outro WhatsApp aberto em outra janela)
    if (!remetente.tab || remetente.tab.id !== abaId) return;
    abaWhatsapp = abaId;
    var antes = conversa && conversa.chave;
    var estado = msg.estado;
    // mesma conversa, só chegou mensagem e o cartão já está na tela: não pisca o "procurando"
    if (estado && antes && estado.chave === antes) {
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
      lerConfig().then(function () {
        pedirConversaAtual();
        if (secao === 'fila') carregarFila(true);
      });
    } else if (mudou.nome) {
      lerConfig();
    }
  });

  var blocoAprendiz = D.aprendiz(document, A.DICAS);
  if (blocoAprendiz) blocoAprendizRaiz.appendChild(blocoAprendiz);
  lerConfig().then(pedirConversaAtual);
})();
