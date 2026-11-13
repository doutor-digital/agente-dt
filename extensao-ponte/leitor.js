/**
 * Ponte — LÊ a conversa aberta no WhatsApp Web. Só lê: não clica, não digita, não foca, não rola a tela,
 * não marca como lida, não usa nenhum módulo interno do WhatsApp ("Store", WA-JS e afins). Só o DOM visível.
 *
 * O que sai daqui (e fica no content script — o texto NUNCA vai para o painel nem para o servidor):
 *   - o nome do cabeçalho;
 *   - o telefone, SÓ quando o `data-id` da conversa termina em `@c.us` (ou o cabeçalho mostra o número).
 *     `@lid` é um id opaco do WhatsApp: NUNCA vira telefone;
 *   - o texto e a hora das últimas mensagens RECEBIDAS visíveis — para virar impressão em `conteudo.js`.
 *
 * Seletores: `seletores.js`. Funções puras sobre um `Document`, para o teste rodar no jsdom.
 */
(function (raiz, fabrica) {
  var ehNode = typeof module === 'object' && module.exports;
  var api = fabrica(ehNode ? require('./seletores.js') : raiz.PonteSeletores);
  if (ehNode) module.exports = api;
  else raiz.PonteLeitor = api;
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  /** textContent, com o emoji (<img alt="😀">) trocado pelo alt e <br> por quebra de linha. */
  function textoDoElemento(el) {
    var partes = [];
    (function andar(n) {
      if (n.nodeType === 3) partes.push(n.nodeValue);
      else if (n.nodeType === 1) {
        if (n.tagName === 'IMG') partes.push(n.getAttribute('alt') || '');
        else if (n.tagName === 'BR') partes.push('\n');
        else for (var i = 0; i < n.childNodes.length; i++) andar(n.childNodes[i]);
      }
    })(el);
    return partes.join('').replace(/\s+/g, ' ').trim();
  }

  function primeiroComTexto(raiz, seletores) {
    for (var i = 0; i < seletores.length; i++) {
      var lista = raiz.querySelectorAll(seletores[i]);
      for (var j = 0; j < lista.length; j++) {
        var t = (lista[j].getAttribute('title') || textoDoElemento(lista[j]) || '').trim();
        if (t) return t;
      }
    }
    return '';
  }

  /**
   * `data-id` → de quem é e de qual conversa. O JID da CONVERSA é o 2º pedaço; o 4º (em grupo) é o
   * participante e nunca é usado.
   */
  function lerDataId(valor) {
    var m = S.DATA_ID.exec(String(valor || ''));
    if (!m) return null;
    var jid = m[2];
    var tipo = /@c\.us$/.test(jid) ? 'c.us' : /@lid$/.test(jid) ? 'lid' : /@g\.us$/.test(jid) ? 'g.us' : 'outro';
    var telefone = null;
    if (tipo === 'c.us') {
      var d = jid.slice(0, -'@c.us'.length);
      if (/^\d{10,15}$/.test(d)) telefone = d;
    }
    return { deMim: m[1] === 'true', jid: jid, tipo: tipo, telefone: telefone };
  }

  /** "[10:32, 13/10/2026] Maria: " → "10:32"; "[3:05 PM, 10/13/2026] …" → "15:05". */
  function horaDoPreTexto(pre) {
    var m = S.HORA_PRE_TEXTO.exec(String(pre || ''));
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    var ampm = m[3] ? m[3].toLowerCase() : null;
    if (ampm === 'p' && h < 12) h += 12;
    if (ampm === 'a' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }

  /** O número que aparece no cabeçalho de contato não salvo ("+55 99 90000-0043") → só dígitos. */
  function telefoneDoCabecalho(nome) {
    var s = String(nome || '').trim();
    if (!S.TELEFONE_NO_CABECALHO.test(s)) return null;
    var d = s.replace(/\D+/g, '');
    return d.length >= 10 && d.length <= 15 ? d : null;
  }

  /** O texto de uma mensagem: o span de texto dentro do bloco copiável; sem ele, o bloco inteiro. */
  function textoDaMensagem(bloco) {
    for (var i = 0; i < S.TEXTO_DA_MENSAGEM.length; i++) {
      var el = bloco.querySelector(S.TEXTO_DA_MENSAGEM[i]);
      if (el) return textoDoElemento(el);
    }
    return textoDoElemento(bloco);
  }

  /**
   * A conversa aberta, ou `{ aberta: false }`.
   * `tipo`: 'contato' | 'grupo' | 'desconhecido' (sem mensagem com data-id para saber).
   */
  function lerConversa(doc, maxMensagens) {
    var max = maxMensagens || 5;
    var painel = doc.querySelector(S.PAINEL_CONVERSA);
    if (!painel) return { aberta: false };
    var cabecalho = doc.querySelector(S.CABECALHO);
    var nome = cabecalho ? primeiroComTexto(cabecalho, S.NOME_CABECALHO) : '';

    var elementos = painel.querySelectorAll(S.MENSAGEM);
    var jids = { 'c.us': null, lid: null, 'g.us': null };
    var recebidas = [];
    for (var i = 0; i < elementos.length; i++) {
      var id = lerDataId(elementos[i].getAttribute('data-id'));
      if (!id) continue;
      if (id.tipo in jids) jids[id.tipo] = id;
      if (id.deMim) continue;
      var bloco = elementos[i].matches(S.BLOCO_TEXTO) ? elementos[i] : elementos[i].querySelector(S.BLOCO_TEXTO);
      if (!bloco) continue; // foto/áudio sem legenda: não tem texto para virar impressão
      var hora = horaDoPreTexto(bloco.getAttribute(S.ATRIBUTO_PRE_TEXTO));
      var texto = textoDaMensagem(bloco);
      if (hora && texto) recebidas.push({ texto: texto, hora: hora });
    }

    var grupo = !!jids['g.us'];
    var telefone = null, fonteTelefone = null;
    if (!grupo && jids['c.us'] && jids['c.us'].telefone) {
      telefone = jids['c.us'].telefone;
      fonteTelefone = 'c.us';
    } else if (!grupo && telefoneDoCabecalho(nome)) {
      telefone = telefoneDoCabecalho(nome);
      fonteTelefone = 'cabecalho';
    }
    var jidDaConversa = (jids['g.us'] || jids['c.us'] || jids.lid || {}).jid || null;
    // 0.7.0: a foto de perfil (URL do próprio WhatsApp; só o painel usa, não vai ao servidor)
    var foto = null;
    var imgs = cabecalho ? cabecalho.querySelectorAll('img') : [];
    for (var k = 0; k < imgs.length && !foto; k++) {
      var src = imgs[k].getAttribute('src') || '';
      if (/^https:\/\/[a-z0-9.-]+\.(whatsapp\.net|whatsapp\.com)\//i.test(src)) foto = src;
    }

    return {
      aberta: true,
      tipo: grupo ? 'grupo' : jidDaConversa ? 'contato' : 'desconhecido',
      nome: nome,
      telefone: telefone,
      fonteTelefone: fonteTelefone,
      lid: !!jids.lid && !jids['c.us'],
      // chave da conversa só para o painel saber que trocou; não sai do navegador
      chave: jidDaConversa || (nome ? 'nome:' + nome : null),
      foto: foto,
      recebidas: grupo ? [] : recebidas.slice(-max),
    };
  }

  /** "[10:32, 13/10/2026] Maria: " → "10:32, 13/10/2026" (como o WhatsApp mostra; só para a Sofia se situar). */
  function quandoDoPreTexto(pre) {
    var m = /^\[([^\]]{3,40})\]/.exec(String(pre || ''));
    return m ? m[1].trim() : null;
  }

  /**
   * "🤖 Passar para a Sofia" (12/11/2026): as falas de TEXTO da conversa aberta, dos dois lados, na ordem da tela —
   * `{ de: 'paciente'|'equipe', texto, hora }`. Só quando a atendente clica; vai para o servidor da Doutor Digital (o
   * Kommo Lite não tem o histórico antigo). Foto/áudio sem legenda ficam de fora. Grupo: lista vazia.
   */
  /**
   * De que lado é a mensagem. Na ordem: o `data-id` (true_ = enviada), as classes `message-out`/`message-in` do
   * WhatsApp, e por fim o nome do autor no pre-texto ("[10:32, 13/11/2026] Maria: ") comparado com o da conversa.
   */
  function ladoDoBloco(bloco, nomeDaConversa) {
    var item = bloco.closest('[data-id]');
    var id = item ? lerDataId(item.getAttribute('data-id')) : null;
    if (id) return id.deMim ? 'equipe' : 'paciente';
    if (bloco.closest('.message-out')) return 'equipe';
    if (bloco.closest('.message-in')) return 'paciente';
    var m = /\]\s*([^:]+):\s*$/.exec(bloco.getAttribute(S.ATRIBUTO_PRE_TEXTO) || '');
    if (!m) return null;
    return nomeDaConversa && m[1].trim().toLowerCase() === String(nomeDaConversa).trim().toLowerCase() ? 'paciente' : 'equipe';
  }

  /**
   * "🤖 Passar para a Sofia" (12/11/2026): as falas de TEXTO da conversa aberta, dos dois lados, na ordem da tela —
   * `{ de: 'paciente'|'equipe', texto, hora }`. Só quando a atendente clica; vai para o servidor da Doutor Digital (o
   * Kommo Lite não tem o histórico antigo). Foto/áudio sem legenda ficam de fora. Grupo: lista vazia.
   * 13/11: lê pelo bloco copiável (`data-pre-plain-text`) e, sem ele, pelas bolhas `message-in`/`message-out`;
   * devolve `diag` (o que achou na tela) para o painel explicar quando não acha nada.
   */
  function lerFalas(doc, maxFalas) {
    var max = maxFalas || 60;
    var c = lerConversa(doc, 1);
    if (!c.aberta) return { aberta: false };
    var painel = doc.querySelector(S.PAINEL_CONVERSA);
    var blocos = painel ? painel.querySelectorAll(S.BLOCO_TEXTO) : [];
    var falas = [];
    for (var i = 0; i < blocos.length; i++) {
      var lado = ladoDoBloco(blocos[i], c.nome);
      var texto = textoDaMensagem(blocos[i]);
      if (!lado || !texto) continue;
      falas.push({ de: lado, texto: texto, hora: quandoDoPreTexto(blocos[i].getAttribute(S.ATRIBUTO_PRE_TEXTO)) });
    }
    var bolhas = painel ? painel.querySelectorAll('.message-in, .message-out') : [];
    if (!falas.length) {
      for (var k = 0; k < bolhas.length; k++) {
        var t = '';
        for (var n = 0; n < S.TEXTO_DA_MENSAGEM.length && !t; n++) {
          var alvo = bolhas[k].querySelector(S.TEXTO_DA_MENSAGEM[n]);
          if (alvo) t = textoDoElemento(alvo);
        }
        if (t) falas.push({ de: bolhas[k].classList.contains('message-out') ? 'equipe' : 'paciente', texto: t, hora: null });
      }
    }
    var diag = {
      dataId: painel ? painel.querySelectorAll(S.MENSAGEM).length : 0,
      blocos: blocos.length,
      bolhas: bolhas.length,
      selecionavel: painel ? painel.querySelectorAll('.selectable-text').length : 0,
    };
    return { aberta: true, tipo: c.tipo, chave: c.chave, falas: c.tipo === 'grupo' ? [] : falas.slice(-max), diag: diag };
  }

  return Object.freeze({
    lerConversa: lerConversa,
    lerFalas: lerFalas,
    quandoDoPreTexto: quandoDoPreTexto,
    lerDataId: lerDataId,
    horaDoPreTexto: horaDoPreTexto,
    telefoneDoCabecalho: telefoneDoCabecalho,
    textoDoElemento: textoDoElemento,
  });
});
