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

/**
 * 0.6.0: pacote já configurado. `gerar-pacotes-ponte.sh` põe um `unidade.json` ({ slug, chave }) dentro da pasta; na
 * instalação ele vai para o storage, se as opções ainda estiverem vazias (nunca sobrescreve o que alguém salvou).
 * Sem o arquivo (pasta do repositório), nada muda: as opções abrem vazias como antes.
 */
function preConfigurar() {
  var url;
  try {
    url = chrome.runtime.getURL('unidade.json');
  } catch (e) {
    return Promise.resolve();
  }
  return Promise.resolve().then(function () { return fetch(url); }).then(function (r) { return r.ok ? r.json() : null; }).then(function (u) {
    if (!u || typeof u.slug !== 'string' || typeof u.chave !== 'string') return;
    return chrome.storage.local.get(['slug', 'chave']).then(function (c) {
      if (c && c.slug && c.chave) return;
      return chrome.storage.local.set({ slug: u.slug.trim().toLowerCase(), chave: u.chave.trim() });
    });
  }).catch(function () {});
}

chrome.runtime.onInstalled.addListener(function (det) {
  ligarPainelNoIcone();
  self.PonteContador.comecar(chrome, CONTADOR);
  preConfigurar().then(function () {
    if (det.reason === 'install') chrome.runtime.openOptionsPage();
  });
});
chrome.runtime.onStartup.addListener(function () {
  ligarPainelNoIcone();
  self.PonteContador.comecar(chrome, CONTADOR);
});
