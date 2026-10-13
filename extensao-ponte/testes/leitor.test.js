// O leitor contra fixtures que IMITAM o DOM do WhatsApp Web. Passar aqui não prova que o WhatsApp real é
// assim — isso só o teste de 1 dia no computador de uma atendente prova (ver README).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const L = require('../leitor.js');
const I = require('../impressao.js');
const { vetores } = require('./vetores-impressao.json');

const html = (nome) => fs.readFileSync(path.join(__dirname, 'fixtures', nome), 'utf8');
const abrir = (nome) => new JSDOM(html(nome)).window.document;
const vetor = (inicio) => vetores.find((v) => v.texto.startsWith(inicio));

describe('leitor — conversa com @c.us (número de telefone)', () => {
  const c = L.lerConversa(abrir('whatsapp-cus.html'), 5);

  it('lê o nome do cabeçalho, não o "visto por último"', () => {
    assert.equal(c.aberta, true);
    assert.equal(c.nome, 'Maria Souza');
  });

  it('o telefone vem do data-id @c.us da conversa aberta (não da lista lateral)', () => {
    assert.equal(c.telefone, '5563991021043');
    assert.equal(c.fonteTelefone, 'c.us');
    assert.equal(c.tipo, 'contato');
    assert.equal(c.lid, false);
    assert.equal(c.chave, '5563991021043@c.us');
  });

  it('pega só as RECEBIDAS com texto, as 5 últimas, na ordem da tela', () => {
    assert.deepEqual(c.recebidas.map((m) => m.hora), ['09:50', '09:58', '10:01', '10:02', '10:07']);
    assert.deepEqual(c.recebidas.map((m) => m.texto), [
      'Bom dia',
      'Quero marcar uma avaliação 🙏',
      'Tenho HÉRNIA de disco L4-L5, dói muito!!!',
      'R$ 250,00 no pix?',
      'Pode sim',
    ]);
    assert.ok(!c.recebidas.some((m) => /Maria!|chave/.test(m.texto)), 'mensagem enviada pela clínica entrou');
  });

  it('o texto da tela (negrito sem asterisco, emoji em <img>, <br>) normaliza igual ao texto cru do servidor', () => {
    assert.equal(I.normalizar(c.recebidas[1].texto), vetor('*Quero*').normalizado);
    assert.equal(I.normalizar(c.recebidas[2].texto), vetor('Tenho HÉRNIA').normalizado);
    assert.equal(I.normalizar(c.recebidas[3].texto), vetor('R$ 250').normalizado);
  });
});

describe('leitor — conversa com @lid (id opaco, NÃO é telefone)', () => {
  const c = L.lerConversa(abrir('whatsapp-lid.html'), 5);

  it('não transforma os dígitos do @lid em telefone', () => {
    assert.equal(c.telefone, null);
    assert.equal(c.fonteTelefone, null);
    assert.equal(c.lid, true);
    assert.equal(c.tipo, 'contato');
    assert.equal(L.lerDataId('false_204567890123456@lid_3EB0C001').telefone, null);
  });

  it('ainda manda o nome e as mensagens (para nome e impressão)', () => {
    assert.equal(c.nome, 'Joana Prado');
    assert.deepEqual(c.recebidas.map((m) => [m.hora, m.texto]), [['15:05', 'Boa tarde'], ['00:10', 'ainda atende hoje?']]);
  });

  it('contato não salvo: o número que está NO CABEÇALHO vale como telefone', () => {
    const d = L.lerConversa(abrir('whatsapp-lid-numero.html'), 5);
    assert.equal(d.telefone, '5563991021043');
    assert.equal(d.fonteTelefone, 'cabecalho');
    assert.equal(d.lid, true);
    assert.notEqual(d.telefone, '998877665544332');
  });
});

describe('leitor — grupo e tela sem conversa', () => {
  it('grupo: não pega o telefone do participante e não lê mensagens', () => {
    const c = L.lerConversa(abrir('whatsapp-grupo.html'), 5);
    assert.equal(c.tipo, 'grupo');
    assert.equal(c.telefone, null);
    assert.deepEqual(c.recebidas, []);
  });

  it('sem #main: nenhuma conversa aberta', () => {
    const doc = new JSDOM('<div id="app"><div id="side"><span dir="auto" title="X">X</span></div></div>').window.document;
    assert.deepEqual(L.lerConversa(doc, 5), { aberta: false });
  });

  it('data-id fora do formato é ignorado', () => {
    assert.equal(L.lerDataId('qualquer-coisa'), null);
    assert.equal(L.lerDataId(''), null);
    assert.equal(L.horaDoPreTexto('sem hora'), null);
    assert.equal(L.horaDoPreTexto('[12:00 PM, 10/13/2026] X: '), '12:00');
  });
});

describe('leitor — só leitura', () => {
  it('não clica, não foca, não dispara evento, não rola e não muda o DOM', () => {
    const w = new JSDOM(html('whatsapp-cus.html')).window;
    const proibido = (nome) => function () { throw new Error(`a Ponte chamou ${nome}`); };
    w.HTMLElement.prototype.click = proibido('click');
    w.HTMLElement.prototype.focus = proibido('focus');
    w.HTMLElement.prototype.blur = proibido('blur');
    w.Element.prototype.scrollIntoView = proibido('scrollIntoView');
    w.EventTarget.prototype.dispatchEvent = proibido('dispatchEvent');
    const antes = w.document.documentElement.outerHTML;
    const obs = new w.MutationObserver(() => {});
    obs.observe(w.document, { subtree: true, childList: true, attributes: true, characterData: true });
    L.lerConversa(w.document, 5);
    assert.equal(obs.takeRecords().length, 0);
    assert.equal(w.document.documentElement.outerHTML, antes);
  });
});
