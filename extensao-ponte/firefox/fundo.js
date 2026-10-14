/**
 * Ponte — script de fundo da versão para o FIREFOX. O Firefox não tem o painel lateral do Chrome
 * (`chrome.sidePanel`); o equivalente é a barra lateral (`sidebar_action`), aberta ao clicar no ícone.
 * Desde a 0.4.0, mantém o NÚMERO NO ÍCONE (pacientes esperando resposta, `contador.js`, a cada 5 min). O
 * `config.js` e o `contador.js` vêm antes deste arquivo (`background.scripts` do manifest). Não lê página nenhuma.
 */
'use strict';

var api = typeof browser !== 'undefined' ? browser : chrome;
var CONTADOR = { base: self.PONTE_CONFIG.BASE, fetch: function (url, init) { return fetch(url, init); } };

api.action.onClicked.addListener(function () {
  // toggle() só funciona dentro do clique do usuário — por isso fica direto no handler
  api.sidebarAction.toggle();
});

self.PonteContador.ligar(api, CONTADOR);

api.runtime.onInstalled.addListener(function (det) {
  self.PonteContador.comecar(api, CONTADOR);
  if (det.reason === 'install') api.runtime.openOptionsPage();
});
api.runtime.onStartup.addListener(function () {
  self.PonteContador.comecar(api, CONTADOR);
});
