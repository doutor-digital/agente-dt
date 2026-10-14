/**
 * Ponte — respostas prontas para COPIAR (fase 3). Pura: sem chrome.* e sem DOM (o teste do servidor,
 * `backend/src/lib/ponte-respostas.test.ts`, carrega este arquivo).
 *
 * As respostas são os modelos gerais do Kommo (texto livre, não os do WhatsApp). A Ponte só COPIA: nunca põe
 * texto na caixa do WhatsApp e nunca envia. A atendente cola na conversa e envia ela mesma.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteRespostas = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Os marcadores de nome: `{{contact.name}}` (o que o Kommo grava), `{{contact.first_name}}`, "[Nome do contato]"
   * (o que a tela do Kommo mostra) e os simples `{{nome}}`, `{nome}` e `[nome]`.
   */
  var MARCADOR_DE_NOME = /\{\{\s*contact\.(?:first_)?name\s*\}\}|\{\{\s*nome\s*\}\}|\{\s*nome\s*\}|\[\s*nome(?:\s+do\s+contato)?\s*\]/gi;

  /** Troca o marcador de nome pelo primeiro nome do paciente; sem nome conhecido, deixa "[nome]" para completar. */
  function preencherNome(texto, primeiroNome) {
    var nome = String(primeiroNome == null ? '' : primeiroNome).trim();
    return String(texto == null ? '' : texto).replace(MARCADOR_DE_NOME, nome || '[nome]');
  }

  /** Sobrou algo entre colchetes para a atendente completar antes de enviar? */
  function temLacuna(texto) {
    return /\[[^\]\n]{1,80}\]/.test(String(texto == null ? '' : texto));
  }

  function paraBusca(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** As respostas cujo nome ou texto têm todas as palavras da busca. */
  function filtrar(lista, busca) {
    var palavras = paraBusca(busca).split(' ').filter(Boolean);
    if (!palavras.length) return (lista || []).slice();
    return (lista || []).filter(function (r) {
      var k = paraBusca((r && r.nome) + ' ' + (r && r.texto));
      return palavras.every(function (p) { return k.indexOf(p) >= 0; });
    });
  }

  return Object.freeze({
    preencherNome: preencherNome,
    temLacuna: temLacuna,
    filtrar: filtrar,
  });
});
