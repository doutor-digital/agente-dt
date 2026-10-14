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

  function desenhar(r) {
    naTela = r && r.achado && r.cartao ? r : null;
    if (naTela) trocar(D.cartao(document, r, acoes));
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
   * "Abrir conversa": troca a URL da aba do WhatsApp Web para o chat do telefone. NAVEGAÇÃO — o mesmo que clicar
   * num link do WhatsApp; nada é digitado nem enviado. O WhatsApp Web recarrega e abre a conversa.
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
        return chrome.tabs.update(aba, { url: url, active: true }).then(function () { if (!ficar) mostrarSecao('conversa'); });
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

  var acoesDasRespostas = {
    atualizar: function () { carregarRespostas(true); },
    copiar: copiar,
    aoBuscar: function (t) { buscaDasRespostas = t; },
  };

  function desenharRespostas() {
    nomeDasRespostas = primeiroNomeNaTela();
    raizRespostas.replaceChildren(D.respostas(document, respostasGuardadas.r, acoesDasRespostas, nomeDasRespostas, buscaDasRespostas));
  }

  /** O paciente da tela mudou: a lista é redesenhada com o nome novo (ou sem nome, enquanto procura). */
  function atualizarNomeDasRespostas() {
    if (secao === 'respostas' && respostasGuardadas && primeiroNomeNaTela() !== nomeDasRespostas) desenharRespostas();
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
    } else if (mudou.nome) {
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
