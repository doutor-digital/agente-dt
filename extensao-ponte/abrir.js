/**
 * Ponte 0.5.0 — abrir a conversa de um telefone SEM recarregar o WhatsApp Web.
 *
 * Até a 0.4.0, "Abrir conversa" e o modo "Começar a ligar" trocavam a URL da aba para `web.whatsapp.com/send?phone=…`:
 * o WhatsApp Web recarregava inteiro a cada paciente. Agora o content script cria UM link da própria Ponte,
 * `<a href="https://wa.me/<dígitos>">`, escondido, aciona `.click()` NESSE elemento e o tira da página. O WhatsApp Web
 * trata link wa.me dentro dele mesmo: abre a conversa sem recarregar.
 *
 * Isto NÃO está documentado pelo WhatsApp: é o que se observa quando alguém clica num link wa.me dentro do WhatsApp
 * Web. Por isso há duas travas, e qualquer dúvida cai no jeito antigo (com recarga), feito pelo painel:
 *   1. se o WhatsApp não tratar o clique (ninguém chamou `preventDefault`), a Ponte cancela a navegação — a aba NÃO sai
 *      do WhatsApp para a página do wa.me — e devolve `{ aberta: false, motivo: 'nao-tratou' }` na hora;
 *   2. se tratou, espera até ~4 s a conversa daquele número aparecer no cabeçalho (`leitor.js`); não apareceu →
 *      `{ aberta: false, motivo: 'nao-abriu' }`.
 *
 * O que NUNCA faz: clicar em botão ou elemento do WhatsApp (o único clique é no link que a Ponte criou), digitar,
 * enviar, ligar, pôr texto no link (`?text=`), usar módulo interno do WhatsApp. Puro: recebe `doc`, `win` e quem lê a
 * conversa, para o teste rodar no jsdom.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteAbrir = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ESPERA_MS = 4000;
  var INTERVALO_MS = 250;

  /** O link wa.me do telefone (só dígitos, de 10 a 15). Nunca leva texto. */
  function linkDoWaMe(telefone) {
    var t = String(telefone == null ? '' : telefone).replace(/\D+/g, '');
    return /^\d{10,15}$/.test(t) ? 'https://wa.me/' + t : null;
  }

  /** Os dois números são o mesmo? Os 8 últimos dígitos (o DDD e o 9 podem vir ou não). */
  function mesmoNumero(a, b) {
    var x = String(a == null ? '' : a).replace(/\D+/g, '');
    var y = String(b == null ? '' : b).replace(/\D+/g, '');
    return x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8);
  }

  /**
   * A conversa aberta é a do telefone? `antes` = a leitura de antes do clique. Conversa com id opaco (@lid) não mostra
   * o número: aí vale "trocou de conversa depois do clique" (o WhatsApp abriu a do link).
   */
  function abriuEsta(c, telefone, antes) {
    if (!c || !c.aberta || c.tipo === 'grupo') return false;
    if (c.telefone) return mesmoNumero(c.telefone, telefone);
    return !!(c.chave && (!antes || !antes.aberta || c.chave !== antes.chave));
  }

  /**
   * Abre a conversa do `telefone` pelo link wa.me da Ponte. `o.lerConversa()` → a leitura de `leitor.js`;
   * `o.esperaMs`, `o.intervaloMs` (o teste encurta). Devolve uma promessa de `{ aberta, motivo?, jaEstava? }`.
   */
  function abrirPorLink(doc, win, telefone, o) {
    var opc = o || {};
    var ler = opc.lerConversa || function () { return { aberta: false }; };
    var url = linkDoWaMe(telefone);
    if (!url) return Promise.resolve({ aberta: false, motivo: 'telefone' });
    var antes = null;
    try { antes = ler(); } catch (e) { antes = null; }
    // já é esta conversa: nada a fazer (nem clique)
    if (antes && antes.aberta && antes.telefone && mesmoNumero(antes.telefone, telefone)) {
      return Promise.resolve({ aberta: true, jaEstava: true });
    }

    var a = doc.createElement('a');
    a.href = url;
    a.rel = 'noopener noreferrer';
    a.setAttribute('data-ponte', 'abrir-conversa');
    a.setAttribute('aria-hidden', 'true');
    a.tabIndex = -1;
    a.textContent = 'Ponte';
    a.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none';
    // dentro do app do WhatsApp (é lá que ele escuta os cliques); sem ele, no corpo da página
    var onde = doc.getElementById('app') || doc.body || doc.documentElement;

    var tratou = null;
    var evento = null;
    // a ÚLTIMA parada do clique: se ninguém do WhatsApp tratou, a Ponte cancela a navegação (a aba não sai dele)
    function guarda(ev) {
      if (ev.target !== a) return;
      tratou = !!ev.defaultPrevented;
      if (!ev.defaultPrevented) ev.preventDefault();
    }
    // o próprio evento, guardado no link: se o WhatsApp tratar E parar o clique (stopPropagation), a guarda nem roda
    a.addEventListener('click', function (ev) { evento = ev; }, true);
    win.addEventListener('click', guarda, false);
    try {
      onde.appendChild(a);
      a.click();
    } finally {
      win.removeEventListener('click', guarda, false);
      if (a.parentNode) a.parentNode.removeChild(a);
    }
    if (tratou === null) tratou = !!(evento && evento.defaultPrevented);
    if (!tratou) return Promise.resolve({ aberta: false, motivo: 'nao-tratou' });

    var espera = opc.esperaMs == null ? ESPERA_MS : opc.esperaMs;
    var passo = opc.intervaloMs == null ? INTERVALO_MS : opc.intervaloMs;
    return new Promise(function (resolver) {
      var inicio = Date.now();
      (function conferir() {
        var c = null;
        try { c = ler(); } catch (e) { c = null; }
        if (abriuEsta(c, telefone, antes)) return resolver({ aberta: true });
        if (Date.now() - inicio >= espera) return resolver({ aberta: false, motivo: 'nao-abriu' });
        win.setTimeout(conferir, passo);
      })();
    });
  }

  return Object.freeze({
    ESPERA_MS: ESPERA_MS,
    linkDoWaMe: linkDoWaMe,
    mesmoNumero: mesmoNumero,
    abriuEsta: abriuEsta,
    abrirPorLink: abrirPorLink,
  });
});
