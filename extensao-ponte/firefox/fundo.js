/**
 * Ponte — script de fundo da versão para o FIREFOX. O Firefox não tem o painel lateral do Chrome
 * (`chrome.sidePanel`); o equivalente é a barra lateral (`sidebar_action`), aberta ao clicar no ícone.
 * Não lê página nenhuma e não fala com o servidor.
 */
'use strict';

var api = typeof browser !== 'undefined' ? browser : chrome;

api.action.onClicked.addListener(function () {
  // toggle() só funciona dentro do clique do usuário — por isso fica direto no handler
  api.sidebarAction.toggle();
});

api.runtime.onInstalled.addListener(function (det) {
  if (det.reason === 'install') api.runtime.openOptionsPage();
});
