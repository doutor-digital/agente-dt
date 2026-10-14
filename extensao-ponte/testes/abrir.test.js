// 0.5.0 — abrir a conversa SEM recarregar: o link wa.me da Ponte (abrir.js) numa página falsa do WhatsApp Web
// (as fixtures). A prova que importa: o ÚNICO clique é no link que a Ponte criou, o link some na hora, nada do WhatsApp
// é clicado nem mudado, e se o WhatsApp não tratar o link a aba NÃO sai dele (a navegação é cancelada) — o painel
// cai para o jeito antigo.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const A = require('../abrir.js');
const Leitor = require('../leitor.js');

const fixture = (nome) => fs.readFileSync(path.join(__dirname, 'fixtures', nome), 'utf8');

/** A conversa de um número no formato da fixture @c.us (o que o WhatsApp mostraria depois de abrir). */
function conversaDe(doc, telefone) {
  const main = doc.getElementById('main');
  main.innerHTML = '<header><div role="button"><span dir="auto" title="+55 99 90000-0001">+55 99 90000-0001</span></div></header>' +
    `<div role="application"><div role="row"><div data-id="false_${telefone}@c.us_3EB0NOVA"><div data-pre-plain-text="[10:00, 14/10/2026] +55: "><span class="selectable-text">oi</span></div></div></div></div>`;
}

/**
 * A página falsa. `whatsapp`: como o "WhatsApp" reage ao clique num link wa.me —
 *   'abre'     trata o link (preventDefault) e abre a conversa do número;
 *   'trata'    trata o link mas a conversa não aparece;
 *   'ignora'   não trata (o navegador navegaria para wa.me).
 */
function pagina(nome, whatsapp) {
  const dom = new JSDOM(fixture(nome), { url: 'https://web.whatsapp.com/' });
  const w = dom.window;
  const doc = w.document;
  const cliques = [];
  // registra TODO clique da página (captura): quem foi clicado
  doc.addEventListener('click', (e) => cliques.push(e.target), true);
  // o "WhatsApp" escuta os cliques no app (delegação, como o React)
  doc.getElementById('app').addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="https://wa.me/"]');
    if (!a || whatsapp === 'ignora') return;
    e.preventDefault();
    if (whatsapp === 'abre-e-para') e.stopPropagation();
    if (whatsapp === 'abre' || whatsapp === 'abre-e-para') {
      const tel = a.getAttribute('href').replace('https://wa.me/', '');
      setTimeout(() => conversaDe(doc, tel), 30);
    }
  });
  const mudancas = [];
  new w.MutationObserver((rs) => rs.forEach((r) => mudancas.push(r))).observe(doc.body, { childList: true, subtree: true, attributes: true });
  const ler = () => Leitor.lerConversa(doc, 1);
  return { w, doc, cliques, mudancas, ler };
}

describe('abrir a conversa pelo link wa.me da Ponte (abrir.js)', () => {
  it('o link é wa.me só com os dígitos (nunca texto); telefone inválido não vira link', () => {
    assert.equal(A.linkDoWaMe('5599900000001'), 'https://wa.me/5599900000001');
    assert.equal(A.linkDoWaMe('+55 (99) 90000-0001'), 'https://wa.me/5599900000001');
    assert.equal(A.linkDoWaMe('123'), null);
    assert.equal(A.linkDoWaMe('123456789012345@lid'), 'https://wa.me/123456789012345', 'só dígitos: quem manda o telefone é o servidor');
    assert.equal(A.linkDoWaMe(null), null);
  });

  it('o WhatsApp trata o link: abre a conversa do número; o único clique foi no link da Ponte, que sumiu', async () => {
    const p = pagina('whatsapp-lid.html', 'abre');
    try {
      const r = await A.abrirPorLink(p.doc, p.w, '5599900000001', { lerConversa: p.ler, intervaloMs: 10, esperaMs: 1000 });
      assert.deepEqual(r, { aberta: true });
      assert.equal(p.cliques.length, 1, 'um clique só');
      const alvo = p.cliques[0];
      assert.equal(alvo.tagName, 'A');
      assert.equal(alvo.getAttribute('data-ponte'), 'abrir-conversa');
      assert.equal(alvo.getAttribute('href'), 'https://wa.me/5599900000001');
      assert.equal(p.doc.querySelector('[data-ponte]'), null, 'o link saiu da página');
      assert.equal(p.ler().telefone, '5599900000001');
    } finally {
      p.w.close();
    }
  });

  it('o WhatsApp trata o link e PARA o clique (stopPropagation): a Ponte ainda percebe que ele tratou e não recarrega', async () => {
    const p = pagina('whatsapp-lid.html', 'abre-e-para');
    try {
      const r = await A.abrirPorLink(p.doc, p.w, '5599900000001', { lerConversa: p.ler, intervaloMs: 10, esperaMs: 1000 });
      assert.deepEqual(r, { aberta: true });
    } finally {
      p.w.close();
    }
  });

  it('antes de a conversa trocar, a Ponte só pôs e tirou o próprio link (nada do WhatsApp mudou)', async () => {
    const p = pagina('whatsapp-cus.html', 'trata');
    try {
      const antes = p.doc.getElementById('app').innerHTML;
      const r = await A.abrirPorLink(p.doc, p.w, '5599900000001', { lerConversa: p.ler, intervaloMs: 10, esperaMs: 60 });
      assert.deepEqual(r, { aberta: false, motivo: 'nao-abriu' }, 'tratou mas não abriu em tempo: o painel cai para o jeito antigo');
      assert.equal(p.doc.getElementById('app').innerHTML, antes);
      await new Promise((ok) => setTimeout(ok, 0));
      const nos = p.mudancas.flatMap((m) => [...m.addedNodes, ...m.removedNodes]);
      assert.ok(nos.length >= 2 && nos.every((n) => n.getAttribute && n.getAttribute('data-ponte') === 'abrir-conversa'), 'só o link da Ponte entrou e saiu');
      assert.ok(p.mudancas.every((m) => m.type === 'childList'), 'nenhum atributo do WhatsApp mexido');
    } finally {
      p.w.close();
    }
  });

  it('o WhatsApp NÃO trata o link: a Ponte cancela a navegação (a aba não sai do WhatsApp) e responde na hora', async () => {
    const p = pagina('whatsapp-cus.html', 'ignora');
    let evento = null;
    p.doc.addEventListener('click', (e) => { evento = e; }, true);
    try {
      const r = await A.abrirPorLink(p.doc, p.w, '5599900000001', { lerConversa: p.ler, esperaMs: 5000 });
      assert.deepEqual(r, { aberta: false, motivo: 'nao-tratou' });
      // depois de o clique passar por todos (a guarda da Ponte é a última parada): a navegação foi cancelada
      assert.equal(evento.defaultPrevented, true, 'a Ponte cancelou a ida para o wa.me');
      assert.equal(p.cliques.length, 1);
      assert.equal(p.doc.querySelector('[data-ponte]'), null);
    } finally {
      p.w.close();
    }
  });

  it('a conversa do número já está aberta: nada a fazer, nenhum clique', async () => {
    const p = pagina('whatsapp-cus.html', 'abre');
    try {
      const r = await A.abrirPorLink(p.doc, p.w, '5599900000043', { lerConversa: p.ler });
      assert.deepEqual(r, { aberta: true, jaEstava: true });
      assert.equal(p.cliques.length, 0);
    } finally {
      p.w.close();
    }
  });

  it('telefone inválido: nem cria o link', async () => {
    const p = pagina('whatsapp-cus.html', 'abre');
    try {
      assert.deepEqual(await A.abrirPorLink(p.doc, p.w, '12', { lerConversa: p.ler }), { aberta: false, motivo: 'telefone' });
      assert.equal(p.cliques.length, 0);
    } finally {
      p.w.close();
    }
  });

  it('conversa com id opaco (@lid) não mostra o número: vale a troca de conversa depois do clique; grupo nunca', () => {
    const antes = { aberta: true, chave: 'a@lid', telefone: null, tipo: 'contato' };
    assert.equal(A.abriuEsta({ aberta: true, chave: 'b@lid', telefone: null, tipo: 'contato' }, '5599900000001', antes), true);
    assert.equal(A.abriuEsta({ aberta: true, chave: 'a@lid', telefone: null, tipo: 'contato' }, '5599900000001', antes), false);
    assert.equal(A.abriuEsta({ aberta: true, chave: 'g', telefone: null, tipo: 'grupo' }, '5599900000001', antes), false);
    assert.equal(A.abriuEsta({ aberta: true, chave: 'x', telefone: '5599911112222', tipo: 'contato' }, '5599900000001', antes), false, 'outro número');
    assert.equal(A.mesmoNumero('5599900000001', '99900000001'), true, 'sem o 55');
  });

  it('o content script inteiro responde "ponte:abrir-conversa" pelo link e nunca clica em outra coisa', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    const lista = manifest.content_scripts[0].js;
    assert.ok(lista.indexOf('abrir.js') >= 0 && lista.indexOf('abrir.js') < lista.indexOf('conteudo.js'), 'abrir.js antes do conteudo.js');
    const dom = new JSDOM(fixture('whatsapp-lid.html'), { runScripts: 'outside-only', url: 'https://web.whatsapp.com/' });
    const w = dom.window;
    let ouvinte = null;
    w.chrome = { runtime: { id: 'teste', sendMessage: () => Promise.resolve(), onMessage: { addListener: (f) => { ouvinte = f; } } } };
    const cliques = [];
    w.document.addEventListener('click', (e) => cliques.push(e.target), true);
    w.document.getElementById('app').addEventListener('click', (e) => {
      if (e.target.closest('a[href^="https://wa.me/"]')) {
        e.preventDefault();
        setTimeout(() => conversaDe(w.document, '5599900000001'), 20);
      }
    });
    try {
      for (const arq of lista) w.eval(fs.readFileSync(path.join(__dirname, '..', arq), 'utf8'));
      const r = await new Promise((ok) => assert.equal(ouvinte({ tipo: 'ponte:abrir-conversa', telefone: '5599900000001' }, {}, ok), true));
      assert.deepEqual(JSON.parse(JSON.stringify(r)), { aberta: true });
      assert.equal(cliques.length, 1);
      assert.equal(cliques[0].getAttribute('data-ponte'), 'abrir-conversa');
    } finally {
      w.close();
    }
  });
});
