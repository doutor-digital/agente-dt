// O content script inteiro (os 4 arquivos, na ordem do manifest) numa página falsa do WhatsApp Web, com um
// `chrome` falso. A prova que importa: o que sai para o painel tem nome, telefone e IMPRESSÕES — nenhum texto.
process.env.TZ = 'America/Sao_Paulo'; // a hora da tela = a de São Paulo, para o hash esperado ser fixo

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const I = require('../impressao.js');

const raiz = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(raiz, 'manifest.json'), 'utf8'));
const html = (nome) => fs.readFileSync(path.join(__dirname, 'fixtures', nome), 'utf8');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function carregar(fixture) {
  const dom = new JSDOM(html(fixture), { runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
  w.TextEncoder = TextEncoder;
  const enviadas = [];
  let ouvinte = null;
  w.chrome = {
    runtime: {
      id: 'teste',
      sendMessage: (m) => { enviadas.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(); },
      onMessage: { addListener: (f) => { ouvinte = f; } },
    },
  };
  for (const arq of manifest.content_scripts[0].js) w.eval(fs.readFileSync(path.join(raiz, arq), 'utf8'));
  const perguntar = () => new Promise((res) => {
    const assincrono = ouvinte({ tipo: 'ponte:qual-conversa' }, {}, res);
    assert.equal(assincrono, true);
  });
  return { w, enviadas, perguntar };
}

describe('content script (conteudo.js + leitor + impressão)', () => {
  it('responde ao painel com nome, telefone e impressões — e nenhum texto de mensagem', async () => {
    const { w, perguntar } = carregar('whatsapp-cus.html');
    try {
      const e = await perguntar();
      assert.deepEqual(Object.keys(e).sort(), ['aberta', 'chave', 'fonteTelefone', 'impressoes', 'lid', 'nome', 'telefone', 'tipo']);
      assert.equal(e.nome, 'Maria Souza');
      assert.equal(e.telefone, '5599900000043');
      assert.equal(e.impressoes.length, 5);
      for (const h of e.impressoes) assert.match(h, /^[0-9a-f]{64}$/);
      const json = JSON.stringify(e);
      for (const t of ['Bom dia', 'Quero', 'HÉRNIA', 'hernia', 'pix', 'Pode sim', 'Maria!']) assert.ok(!json.includes(t), `vazou "${t}"`);
      // a 4ª recebida é "R$ 250,00 no pix?" às 10:02 — a impressão é a mesma que o servidor calcula
      assert.equal(e.impressoes[3], await I.impressao('R$ 250,00 no pix?', '10:02'));
    } finally {
      w.close();
    }
  });

  it('avisa sozinho quando a conversa troca (MutationObserver), sem telefone no @lid', async () => {
    const { w, enviadas } = carregar('whatsapp-cus.html');
    try {
      await esperar(900);
      assert.equal(enviadas.length, 1);
      assert.equal(enviadas[0].tipo, 'ponte:conversa');
      assert.equal(enviadas[0].estado.telefone, '5599900000043');

      // a atendente clica em outra conversa: o WhatsApp troca o #main inteiro e a URL fica igual
      const outra = new JSDOM(html('whatsapp-lid.html')).window.document.querySelector('#main');
      w.document.querySelector('#main').replaceWith(w.document.importNode(outra, true));
      await esperar(900);
      assert.equal(enviadas.length, 2);
      const e = enviadas[1].estado;
      assert.equal(e.nome, 'Joana Prado');
      assert.equal(e.telefone, null);
      assert.equal(e.lid, true);
      assert.equal(e.impressoes.length, 2);
      assert.ok(!JSON.stringify(e).includes('Boa tarde'));

      // mutação que não muda nada do que importa não manda de novo
      w.document.body.appendChild(w.document.createElement('span'));
      await esperar(900);
      assert.equal(enviadas.length, 2);

      // mensagem nova do paciente na conversa aberta: manda de novo, com uma impressão a mais
      const linha = w.document.createElement('div');
      linha.innerHTML = '<div data-id="false_204567890123456@lid_3EB0C003" class="message-in"><div class="copyable-text" data-pre-plain-text="[12:20 AM, 10/14/2026] Joana Prado: "><span class="selectable-text"><span>Obrigada</span></span></div></div>';
      w.document.querySelector('#main [role="application"]').appendChild(linha);
      await esperar(900);
      assert.equal(enviadas.length, 3);
      assert.equal(enviadas[2].estado.impressoes.length, 3);
    } finally {
      w.close();
    }
  });

  it('grupo: avisa o painel que é grupo, sem telefone e sem impressões', async () => {
    const { w, perguntar } = carregar('whatsapp-grupo.html');
    try {
      const e = await perguntar();
      assert.equal(e.tipo, 'grupo');
      assert.equal(e.telefone, null);
      assert.equal(e.impressoes.length, 0); // array do jsdom (outro realm): deepEqual com [] compara o protótipo
    } finally {
      w.close();
    }
  });
});

describe('manifest', () => {
  it('permissões mínimas, content script só no WhatsApp Web, mundo isolado, painel lateral', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions.slice().sort(), ['sidePanel', 'storage']);
    assert.deepEqual(manifest.host_permissions, ['https://agente-vps.doutordigitalconsultoria.com/*']);
    assert.equal(manifest.content_scripts.length, 1);
    assert.deepEqual(manifest.content_scripts[0].matches, ['https://web.whatsapp.com/*']);
    assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
    assert.equal(manifest.side_panel.default_path, 'painel.html');
    assert.ok(!('web_accessible_resources' in manifest), 'nada da extensão pode ser injetado na página');
  });
});
