/**
 * Ponte — etiquetas do cartão (fase 3). Pura: sem chrome.* e sem DOM, para o teste da extensão e o do servidor
 * (`backend/src/lib/ponte-etiquetas.test.ts`) carregarem este mesmo arquivo.
 *
 * A atendente só ESCOLHE entre as etiquetas que já existem na conta (a Ponte não cria etiqueta). As que começam
 * com ▶ fazem um robô do Kommo mandar uma mensagem de WhatsApp para o paciente: pôr uma delas pede confirmação.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteEtiquetas = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PERGUNTA_DO_ROBO = 'Esta etiqueta faz o robô mandar uma mensagem para o paciente. Pôr mesmo assim?';

  /** A mesma regra do servidor (`ehEtiquetaDeRobo`): começa com ▶ (ou ►, que na tela parece igual). */
  function ehDeRobo(nome) {
    return /^\s*[▶►]/.test(String(nome == null ? '' : nome));
  }

  /** Para buscar: sem acento, sem maiúscula, só letras e números ("retomada" acha "▶ RETOMADA"). */
  function paraBusca(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * As etiquetas da conta que casam com a busca, sem as que o cartão já tem. Começar com o texto vem antes de
   * só conter. `max` corta a lista (a conta pode ter centenas).
   */
  function filtrar(daConta, busca, doCartao, max) {
    var tem = {};
    (doCartao || []).forEach(function (t) { tem[paraBusca(t) + '|' + ehDeRobo(t)] = true; });
    var b = paraBusca(busca);
    var lista = (daConta || []).filter(function (e) {
      return e && e.nome && !tem[paraBusca(e.nome) + '|' + ehDeRobo(e.nome)];
    });
    if (b) {
      lista = lista
        .map(function (e) {
          var k = paraBusca(e.nome);
          var i = k.indexOf(b);
          return { e: e, i: i, comeca: i === 0 || k.indexOf(' ' + b) >= 0 };
        })
        .filter(function (x) { return x.i >= 0; })
        .sort(function (a, z) { return (a.comeca === z.comeca ? 0 : a.comeca ? -1 : 1); })
        .map(function (x) { return x.e; });
    }
    return lista.slice(0, max || 30);
  }

  return Object.freeze({
    PERGUNTA_DO_ROBO: PERGUNTA_DO_ROBO,
    ehDeRobo: ehDeRobo,
    paraBusca: paraBusca,
    filtrar: filtrar,
  });
});
