/**
 * Ponte — o painel lateral (chrome.sidePanel). Recebe do content script o que identifica a conversa aberta
 * (nome, telefone quando há, impressões das mensagens) e pergunta ao servidor qual é o cartão do Kommo.
 *
 * Guarda em memória (some quando o painel fecha) só a resposta do servidor por conversa, por 2 minutos,
 * para não perguntar de novo a cada clique. Nada de conversa vai para `chrome.storage`.
 */
(function () {
  'use strict';
  var D = self.PonteDesenho;
  var A = self.PonteAprendiz;
  var BASE = self.PONTE_CONFIG.BASE;
  var CACHE_MS = 2 * 60 * 1000;
  var ESPERA_MS = 400;

  var raiz = document.getElementById('conteudo');
  var rotuloUnidade = document.getElementById('unidade');
  var config = null;
  var abaId = null;
  var conversa = null;
  var cache = new Map();
  var pedido = 0;
  var espera = null;

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
    return chrome.storage.local.get(['slug', 'chave']).then(function (c) {
      config = c && c.slug && c.chave ? { slug: String(c.slug), chave: String(c.chave) } : null;
      rotuloUnidade.textContent = config ? config.slug : '';
    });
  }

  function mostrarConfigurar() {
    var a = D.aviso(document, 'configurar', 'Configure a unidade', 'Informe o slug e a chave da unidade (a mesma do widget do cartão no Kommo).');
    a.appendChild(botao('Abrir as opções', function () { chrome.runtime.openOptionsPage(); }));
    trocar(a);
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

  var acoes = {
    escolher: function (leadId) {
      buscar({ lead: leadId }, conversa && conversa.chave, true);
    },
    buscar: function (nome) {
      buscar({ nome: nome, manual: true }, conversa && conversa.chave, true);
    },
  };

  function desenhar(r) {
    if (r && r.achado && r.cartao) trocar(D.cartao(document, r, acoes));
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
    if (!config) return mostrarConfigurar();
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
    if (!config) return mostrarConfigurar();
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
      return chrome.tabs.sendMessage(abaId, { tipo: 'ponte:qual-conversa' }).then(
        function (estado) { receber(estado || null); },
        function () { receber(null); }, // a aba ativa não é o WhatsApp Web
      );
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, remetente) {
    if (!msg || msg.tipo !== 'ponte:conversa') return;
    // só a aba ativa desta janela manda no painel (pode haver outro WhatsApp aberto em outra janela)
    if (!remetente.tab || remetente.tab.id !== abaId) return;
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
    if (area === 'local' && (mudou.slug || mudou.chave)) {
      cache.clear();
      lerConfig().then(pedirConversaAtual);
    }
  });

  var blocoAprendiz = D.aprendiz(document, A.DICAS);
  if (blocoAprendiz) document.getElementById('aprendiz').appendChild(blocoAprendiz);
  lerConfig().then(pedirConversaAtual);
})();
