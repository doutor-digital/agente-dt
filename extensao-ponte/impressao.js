/**
 * Ponte — a "impressão" de uma mensagem recebida: o que sai do navegador NO LUGAR do texto.
 *
 * impressão = SHA-256( <texto normalizado> + "|" + <HH:MM em America/Sao_Paulo> ), em hex.
 *
 * CONTRATO COM O SERVIDOR: `backend/src/lib/ponte-impressao.ts` faz a MESMA conta sobre as mensagens que
 * já guarda. Mudou aqui, muda lá — o teste do backend (`ponte-impressao.test.ts`) carrega ESTE arquivo e
 * compara as duas saídas sobre `testes/vetores-impressao.json`.
 *
 * Normalizar = minúsculas, sem acento, e tudo que não é letra ou número vira um espaço só. Tirar a
 * pontuação é de propósito: a tela não mostra o texto cru (*negrito* perde os asteriscos, emoji vira imagem).
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteImpressao = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FUSO = 'America/Sao_Paulo';
  var MINUTO = /^([01]\d|2[0-3]):[0-5]\d$/;

  function normalizar(texto) {
    return String(texto == null ? '' : texto)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function dois(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Quantos minutos o relógio do fuso está à frente do UTC naquele instante (São Paulo: -180). */
  function offsetDoFuso(agora, tz) {
    var partes = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(agora);
    var v = {};
    partes.forEach(function (p) { v[p.type] = p.value; });
    var comoSeFosseUtc = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour) % 24, Number(v.minute));
    var real = Math.floor(agora.getTime() / 60000) * 60000;
    return Math.round((comoSeFosseUtc - real) / 60000);
  }

  /**
   * A hora que o WhatsApp Web mostra é a do RELÓGIO DO COMPUTADOR da atendente. O servidor conta em São Paulo.
   * Converte "HH:MM" local para "HH:MM" de São Paulo (Boa Vista mostra 09:00 quando em SP são 10:00).
   * `offsetLocalMin` só existe para o teste; no navegador vem do próprio relógio.
   */
  function minutoDeSaoPaulo(hora, agora, offsetLocalMin) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || ''));
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    var quando = agora || new Date();
    var local = offsetLocalMin == null ? -quando.getTimezoneOffset() : offsetLocalMin;
    var dif = offsetDoFuso(quando, FUSO) - local;
    var t = (((h * 60 + mi + dif) % 1440) + 1440) % 1440;
    return dois(Math.floor(t / 60)) + ':' + dois(t % 60);
  }

  function hex(buffer) {
    var bytes = new Uint8Array(buffer), s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  /** A impressão (Promise de hex), ou `null` se o texto fica vazio ao normalizar ou o minuto não é HH:MM. */
  function impressao(texto, minuto) {
    var n = normalizar(texto);
    if (!n || !MINUTO.test(String(minuto || ''))) return Promise.resolve(null);
    var bytes = new TextEncoder().encode(n + '|' + minuto);
    return crypto.subtle.digest('SHA-256', bytes).then(hex);
  }

  return Object.freeze({ FUSO: FUSO, normalizar: normalizar, minutoDeSaoPaulo: minutoDeSaoPaulo, impressao: impressao });
});
