/**
 * Ponte — service worker. Só liga o painel lateral ao clique no ícone e abre as opções na 1ª instalação.
 * Não lê página nenhuma e não fala com o servidor.
 */
'use strict';

function ligarPainelNoIcone() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
}

chrome.runtime.onInstalled.addListener(function (det) {
  ligarPainelNoIcone();
  if (det.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(ligarPainelNoIcone);
