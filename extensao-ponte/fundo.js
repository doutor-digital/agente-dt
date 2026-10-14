/**
 * Ponte — service worker. Liga o painel lateral ao clique no ícone, abre as opções na 1ª instalação e, desde a
 * 0.4.0, mantém o NÚMERO NO ÍCONE: quantos pacientes esperam resposta (`contador.js`), perguntado ao servidor da
 * Doutor Digital a cada 5 min. Não lê página nenhuma.
 */
'use strict';

importScripts('config.js', 'contador.js');

var CONTADOR = { base: self.PONTE_CONFIG.BASE, fetch: function (url, init) { return fetch(url, init); } };

function ligarPainelNoIcone() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
}

// os ouvintes do contador ficam no topo: o service worker dorme e acorda pelo alarme
self.PonteContador.ligar(chrome, CONTADOR);

chrome.runtime.onInstalled.addListener(function (det) {
  ligarPainelNoIcone();
  self.PonteContador.comecar(chrome, CONTADOR);
  if (det.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(function () {
  ligarPainelNoIcone();
  self.PonteContador.comecar(chrome, CONTADOR);
});
