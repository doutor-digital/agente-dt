/** Ponte — opções: slug + chave da unidade em `chrome.storage.local`, e um teste no `/ping` dos widgets. */
(function () {
  'use strict';
  var BASE = self.PONTE_CONFIG.BASE;
  var form = document.getElementById('form');
  var slug = document.getElementById('slug');
  var chave = document.getElementById('chave');
  var resultado = document.getElementById('resultado');

  function dizer(texto, classe) {
    resultado.textContent = texto;
    resultado.className = classe || '';
  }

  chrome.storage.local.get(['slug', 'chave']).then(function (c) {
    slug.value = (c && c.slug) || '';
    chave.value = (c && c.chave) || '';
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var s = slug.value.trim().toLowerCase();
    var k = chave.value.trim();
    if (!/^[a-z0-9-]+$/.test(s) || !k) {
      dizer('Confira o slug (letras, números e hífen) e a chave.', 'erro');
      return;
    }
    dizer('Testando…');
    chrome.storage.local.set({ slug: s, chave: k }).then(function () {
      return fetch(BASE + '/api/public/widget/' + encodeURIComponent(s) + '/ping', { headers: { 'X-Widget-Key': k }, cache: 'no-store' });
    }).then(function (r) {
      if (r.status === 403) throw new Error('A chave não confere com esta unidade.');
      if (r.status === 404) throw new Error('Unidade não encontrada.');
      if (!r.ok) throw new Error('O servidor respondeu ' + r.status + '.');
      return r.json();
    }).then(function (j) {
      dizer('Conectado: ' + (j.unidade || s) + '. Pode fechar esta aba.', 'ok');
    }).catch(function (e) {
      dizer('Salvo, mas o teste falhou: ' + ((e && e.message) || 'sem conexão com o servidor') , 'erro');
    });
  });
})();
