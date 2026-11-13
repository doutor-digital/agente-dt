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
    assert.equal(c.telefone, '5599900000043');
    assert.equal(c.fonteTelefone, 'c.us');
    assert.equal(c.tipo, 'contato');
    assert.equal(c.lid, false);
    assert.equal(c.chave, '5599900000043@c.us');
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
    assert.equal(d.telefone, '5599900000043');
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

describe('leitor — lerFalas ("Passar para a Sofia")', () => {
  it('lê os dois lados, na ordem da tela, com a hora do WhatsApp', () => {
    const r = L.lerFalas(abrir('whatsapp-cus.html'), 60);
    assert.equal(r.aberta, true);
    assert.equal(r.chave, '5599900000043@c.us');
    const pacientes = r.falas.filter((f) => f.de === 'paciente').map((f) => f.texto);
    assert.deepEqual(pacientes.slice(-2), ['R$ 250,00 no pix?', 'Pode sim']);
    assert.ok(r.falas.some((f) => f.de === 'equipe'), 'faltou fala da clínica');
    assert.ok(r.falas.every((f) => f.texto && (f.de === 'paciente' || f.de === 'equipe')));
    assert.match(r.falas.find((f) => f.texto === 'Pode sim').hora, /^10:07/);
  });

  it('respeita o teto (fica com as mais recentes)', () => {
    const r = L.lerFalas(abrir('whatsapp-cus.html'), 2);
    assert.equal(r.falas.length, 2);
    assert.equal(r.falas.at(-1).texto, 'Pode sim');
  });

  it('grupo não passa: lista vazia; sem conversa: aberta false', () => {
    assert.deepEqual(L.lerFalas(abrir('whatsapp-grupo.html'), 60).falas, []);
    assert.deepEqual(L.lerFalas(new JSDOM('<html><body></body></html>').window.document, 60), { aberta: false });
  });

  it('quandoDoPreTexto', () => {
    assert.equal(L.quandoDoPreTexto('[10:32, 13/10/2026] Maria: '), '10:32, 13/10/2026');
    assert.equal(L.quandoDoPreTexto('sem colchete'), null);
  });
});

describe('leitor — foto de perfil (0.7.0)', () => {
  it('pega a foto do cabeçalho só quando é do WhatsApp (https)', () => {
    const doc = abrir('whatsapp-cus.html');
    assert.equal(L.lerConversa(doc, 5).foto, null);
    const cab = doc.querySelector('#main header');
    const img = doc.createElement('img');
    img.setAttribute('src', 'https://pps.whatsapp.net/v/t61/foto.jpg?oh=1');
    cab.appendChild(img);
    assert.equal(L.lerConversa(doc, 5).foto, 'https://pps.whatsapp.net/v/t61/foto.jpg?oh=1');
    img.setAttribute('src', 'https://exemplo.com/x.jpg');
    assert.equal(L.lerConversa(doc, 5).foto, null);
  });
});

describe('leitor — lerFalas sem data-id (WhatsApp mudou a página)', () => {
  it('lê pelas bolhas message-in/message-out e pelo pre-texto', () => {
    const doc = new JSDOM(`<html><body><div id="main"><header><span dir="auto" title="Maria Souza">Maria Souza</span></header>
      <div class="message-in"><div data-pre-plain-text="[10:00, 13/11/2026] Maria Souza: "><span class="selectable-text">quanto custa?</span></div></div>
      <div class="message-out"><div data-pre-plain-text="[10:01, 13/11/2026] Clínica: "><span class="selectable-text">R$ 200</span></div></div>
      <div><div data-pre-plain-text="[10:02, 13/11/2026] Maria Souza: "><span class="selectable-text">tem sábado?</span></div></div>
    </div></body></html>`).window.document;
    const r = L.lerFalas(doc, 60);
    assert.deepEqual(r.falas.map((f) => [f.de, f.texto]), [['paciente', 'quanto custa?'], ['equipe', 'R$ 200'], ['paciente', 'tem sábado?']]);
    assert.equal(r.diag.blocos, 3);
  });

  it('sem bloco copiável: cai nas bolhas', () => {
    const doc = new JSDOM(`<html><body><div id="main"><header><span dir="auto" title="Ana">Ana</span></header>
      <div class="message-in"><span class="selectable-text">oi</span></div>
      <div class="message-out"><span class="selectable-text">olá!</span></div>
    </div></body></html>`).window.document;
    assert.deepEqual(L.lerFalas(doc, 60).falas.map((f) => [f.de, f.texto]), [['paciente', 'oi'], ['equipe', 'olá!']]);
  });
});
