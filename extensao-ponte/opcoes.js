/**
 * Ponte — opções: slug + chave da unidade e o nome da atendente em `chrome.storage.local`, e um teste no
 * `/ping` dos widgets. O nome só serve para dizer no Kommo quem fez ("por Ana"): pausa, etiqueta, ligação, campos e
 * etapa. Salvar a unidade também atualiza o número no ícone (o script de fundo ouve a troca).
 *
 * 0.5.0: a chave "Abrir conversa sem recarregar" (`semRecarregar`, ligada quando nunca foi mexida). Grava na hora,
 * sem precisar do "Salvar e testar".
 */
(function () {
  'use strict';
  var BASE = self.PONTE_CONFIG.BASE;
  var form = document.getElementById('form');
  var slug = document.getElementById('slug');
  var chave = document.getElementById('chave');
  var nome = document.getElementById('nome');
  var semRecarregar = document.getElementById('sem-recarregar');
  var resultado = document.getElementById('resultado');

  function dizer(texto, classe) {
    resultado.textContent = texto;
    resultado.className = classe || '';
  }

  chrome.storage.local.get(['slug', 'chave', 'nome', 'semRecarregar']).then(function (c) {
    slug.value = (c && c.slug) || '';
    chave.value = (c && c.chave) || '';
    nome.value = (c && c.nome) || '';
    // ligada por padrão: só fica desligada se a atendente desligou
    if (semRecarregar) semRecarregar.checked = !(c && c.semRecarregar === false);
  });

  if (semRecarregar) {
    semRecarregar.addEventListener('change', function () {
      chrome.storage.local.set({ semRecarregar: !!semRecarregar.checked }).then(function () {
        dizer(semRecarregar.checked ? 'Pronto: a conversa abre sem recarregar o WhatsApp Web.' : 'Pronto: a conversa abre recarregando o WhatsApp Web (o jeito antigo).', 'ok');
      });
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var s = slug.value.trim().toLowerCase();
    var k = chave.value.trim();
    var n = nome.value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!/^[a-z0-9-]+$/.test(s) || !k) {
      dizer('Confira o slug (letras, números e hífen) e a chave.', 'erro');
      return;
    }
    dizer('Testando…');
    chrome.storage.local.set({ slug: s, chave: k, nome: n }).then(function () {
      return fetch(BASE + '/api/public/widget/' + encodeURIComponent(s) + '/ping', { headers: { 'X-Widget-Key': k }, cache: 'no-store' });
    }).then(function (r) {
      if (r.status === 403) throw new Error('A chave não confere com esta unidade.');
      if (r.status === 404) throw new Error('Unidade não encontrada.');
      if (!r.ok) throw new Error('O servidor respondeu ' + r.status + '.');
      return r.json();
    }).then(function (j) {
      dizer('Conectado: ' + (j.unidade || s) + (n ? ', como ' + n : '') + '. Pode fechar esta aba.', 'ok');
    }).catch(function (e) {
      dizer('Salvo, mas o teste falhou: ' + ((e && e.message) || 'sem conexão com o servidor') , 'erro');
    });
  });
})();
