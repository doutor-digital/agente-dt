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

  /** O número que aparece no cabeçalho de contato não salvo ("+55 63 99102-1043") → só dígitos. */
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

    return {
      aberta: true,
      tipo: grupo ? 'grupo' : jidDaConversa ? 'contato' : 'desconhecido',
      nome: nome,
      telefone: telefone,
      fonteTelefone: fonteTelefone,
      lid: !!jids.lid && !jids['c.us'],
      // chave da conversa só para o painel saber que trocou; não sai do navegador
      chave: jidDaConversa || (nome ? 'nome:' + nome : null),
      recebidas: grupo ? [] : recebidas.slice(-max),
    };
  }

  return Object.freeze({
    lerConversa: lerConversa,
    lerDataId: lerDataId,
    horaDoPreTexto: horaDoPreTexto,
    telefoneDoCabecalho: telefoneDoCabecalho,
    textoDoElemento: textoDoElemento,
  });
});
