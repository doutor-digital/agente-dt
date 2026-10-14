/**
 * Ponte — content script do WhatsApp Web (mundo ISOLADO, só leitura).
 *
 * Observa a página com um MutationObserver (a URL não muda quando a atendente troca de conversa), lê a
 * conversa aberta com `leitor.js` e avisa o painel lateral SÓ do que ele precisa: nome do cabeçalho,
 * telefone (quando é telefone de verdade) e as IMPRESSÕES das últimas mensagens recebidas. O texto das
 * mensagens morre aqui dentro: não vai para o painel, não vai para o servidor, não vai para storage.
 *
 * Nada aqui clica, digita, foca, rola ou marca como lida. Não há UI injetada na página: o painel é o
 * `chrome.sidePanel`, uma página da própria extensão.
 *
 * 0.5.0 — a ÚNICA exceção, a pedido do painel ("Abrir conversa" e "Começar a ligar"): `abrir.js` cria um link
 * `https://wa.me/<dígitos>` da própria Ponte, aciona o clique NESSE link (nunca num elemento do WhatsApp) e o tira da
 * página na hora. Se o WhatsApp não abrir a conversa, o painel volta ao jeito antigo (troca a URL, com recarga).
 */
(function () {
  'use strict';
  var S = self.PonteSeletores;
  var L = self.PonteLeitor;
  var I = self.PonteImpressao;
  var A = self.PonteAbrir;
  var MAX_MENSAGENS = 5;
  var ESPERA_MS = 700;

  var ultimaAssinatura = null;
  var assinaturaDaTela = null;
  var tinhaConversa = null;
  var agendado = null;
  var observador = null;

  function extensaoViva() {
    // depois de recarregar a extensão, o script antigo fica órfão na página: para de observar e sai
    return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  }

  /** O que o painel recebe. Texto de mensagem NÃO entra aqui — só a impressão. */
  function montarEstado() {
    var c = L.lerConversa(document, MAX_MENSAGENS);
    if (!c.aberta) return Promise.resolve({ aberta: false });
    var agora = new Date();
    return Promise.all(
      c.recebidas.map(function (m) {
        var minuto = I.minutoDeSaoPaulo(m.hora, agora);
        return minuto ? I.impressao(m.texto, minuto) : null;
      }),
    ).then(function (hashes) {
      return {
        aberta: true,
        tipo: c.tipo,
        chave: c.chave,
        nome: c.nome,
        telefone: c.telefone,
        fonteTelefone: c.fonteTelefone,
        lid: c.lid,
        impressoes: hashes.filter(Boolean),
      };
    });
  }

  function avisarPainel(estado) {
    try {
      // painel fechado = ninguém escutando; o erro é esperado e não importa
      var p = chrome.runtime.sendMessage({ tipo: 'ponte:conversa', estado: estado });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      /* idem */
    }
  }

  /**
   * Barato, sem hash: cabeçalho + quantas mensagens + id da última. Se nada disso mudou, a leitura completa
   * (e os hashes) nem roda — o WhatsApp mexe no DOM o tempo todo por coisas que não importam aqui.
   */
  function retratoDaTela() {
    var painel = document.querySelector(S.PAINEL_CONVERSA);
    if (!painel) return 'sem-conversa';
    var cab = document.querySelector(S.CABECALHO);
    var msgs = painel.querySelectorAll(S.MENSAGEM);
    var ultima = msgs.length ? msgs[msgs.length - 1].getAttribute('data-id') : '';
    return (cab ? cab.textContent : '') + '|' + msgs.length + '|' + ultima;
  }

  function conferir() {
    agendado = null;
    if (!extensaoViva()) {
      if (observador) observador.disconnect();
      return;
    }
    var retrato = retratoDaTela();
    if (retrato === assinaturaDaTela) return;
    assinaturaDaTela = retrato;
    montarEstado().then(function (estado) {
      var assinatura = JSON.stringify(estado);
      if (assinatura === ultimaAssinatura) return;
      ultimaAssinatura = assinatura;
      avisarPainel(estado);
    }).catch(function () {});
  }

  // vários disparos por segundo viram uma leitura a cada ESPERA_MS, no máximo
  function agendar() {
    if (!agendado) agendado = setTimeout(conferir, ESPERA_MS);
  }

  /**
   * Só interessa mutação DENTRO da conversa aberta (ou a troca do painel inteiro). A lista de conversas da
   * esquerda muda o tempo todo (prévia, "digitando…", contador) e é ignorada aqui — a Ponte nem a lê.
   */
  function relevante(registros) {
    var painel = document.querySelector(S.PAINEL_CONVERSA);
    var tem = !!painel;
    if (tem !== tinhaConversa) {
      tinhaConversa = tem;
      return true;
    }
    if (!painel) return false;
    for (var i = 0; i < registros.length; i++) {
      var alvo = registros[i].target;
      if (painel.contains(alvo) || (alvo.contains && alvo.contains(painel))) return true;
    }
    return false;
  }

  observador = new MutationObserver(function (registros) {
    if (!agendado && relevante(registros)) agendar();
  });
  observador.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // o painel acabou de abrir (ou trocou de aba) e pergunta qual é a conversa agora
  chrome.runtime.onMessage.addListener(function (msg, _remetente, responder) {
    // 0.5.0: abrir a conversa de um telefone pelo link wa.me da Ponte, sem recarregar
    if (msg && msg.tipo === 'ponte:abrir-conversa') {
      if (!A) {
        responder({ aberta: false, motivo: 'sem-abrir' });
        return false;
      }
      A.abrirPorLink(document, window, msg.telefone, { lerConversa: function () { return L.lerConversa(document, 1); } }).then(function (r) {
        if (!r.aberta) console.info('[Ponte] a conversa não abriu pelo link wa.me (' + r.motivo + '): o painel abre pelo jeito antigo, com recarga.');
        responder(r);
      }, function () { responder({ aberta: false, motivo: 'erro' }); });
      return true; // resposta assíncrona
    }
    if (!msg || msg.tipo !== 'ponte:qual-conversa') return false;
    montarEstado().then(function (estado) {
      ultimaAssinatura = JSON.stringify(estado);
      responder(estado);
    }).catch(function () { responder({ aberta: false }); });
    return true; // resposta assíncrona
  });

  agendar();
})();
