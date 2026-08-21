import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectarTipo,
  urlPermitida,
  extrairTextoHtml,
  extrairDescricaoYoutube,
  parseQaPairs,
} from './knowledge-links.service.js';

test('detectarTipo reconhece youtube, avaliações e artigos', () => {
  assert.equal(detectarTipo('https://www.youtube.com/watch?v=abc123'), 'video');
  assert.equal(detectarTipo('https://youtu.be/abc123'), 'video');
  assert.equal(detectarTipo('https://maps.app.goo.gl/xyz'), 'avaliacao');
  assert.equal(detectarTipo('https://share.google/R5nNV4poGm4y7lZcu'), 'avaliacao');
  assert.equal(detectarTipo('https://pubmed.ncbi.nlm.nih.gov/12345/'), 'artigo');
  assert.equal(detectarTipo('https://www.scielo.br/j/rbf/a/xyz'), 'artigo');
  assert.equal(detectarTipo('https://doi.org/10.1000/xyz'), 'artigo');
  assert.equal(detectarTipo('https://clinica.com.br/sobre'), 'pagina');
});

test('urlPermitida barra endereços internos e protocolos estranhos', () => {
  assert.equal(urlPermitida('https://www.scielo.br/artigo'), true);
  assert.equal(urlPermitida('http://exemplo.com'), true);
  assert.equal(urlPermitida('ftp://exemplo.com'), false);
  assert.equal(urlPermitida('https://localhost/admin'), false);
  assert.equal(urlPermitida('http://127.0.0.1:8080'), false);
  assert.equal(urlPermitida('http://10.0.0.5/x'), false);
  assert.equal(urlPermitida('http://servico.internal/x'), false);
  assert.equal(urlPermitida('nao é url'), false);
});

test('extrairTextoHtml tira script/style e devolve texto legível com título', () => {
  const html = `<html><head><title>Hérnia de disco: estudo</title>
    <style>.x{color:red}</style><script>alert(1)</script></head>
    <body><nav>menu</nav><p>O tratamento conservador teve 85% de sucesso.</p>
    <p>Pacientes relataram menos dor.</p></body></html>`;
  const { titulo, texto } = extrairTextoHtml(html);
  assert.equal(titulo, 'Hérnia de disco: estudo');
  assert.ok(texto.includes('85% de sucesso'));
  assert.ok(!texto.includes('alert(1)'));
  assert.ok(!texto.includes('color:red'));
  assert.ok(!texto.includes('menu'));
});

test('extrairDescricaoYoutube pega a descrição do player', () => {
  const html = 'blah "shortDescription":"Depoimento da paciente Maria.\\nMelhorou em 3 semanas." blah';
  const d = extrairDescricaoYoutube(html);
  assert.ok(d.includes('Depoimento da paciente Maria.'));
  assert.ok(d.includes('Melhorou em 3 semanas.'));
});

test('parseQaPairs valida, aceita pt/en e corta o excesso', () => {
  const raw = JSON.stringify({
    pares: [
      { question: 'O tratamento funciona sem cirurgia?', answer: 'Um estudo acompanhou pacientes e a maioria melhorou sem operar, com tratamento conservador.' },
      { pergunta: 'Quanto tempo leva?', resposta: 'Os pacientes do estudo relataram melhora ao longo de algumas semanas de tratamento.' },
      { question: 'x', answer: 'curta' },
      ...Array.from({ length: 10 }, (_, i) => ({
        question: `Pergunta válida número ${i}?`,
        answer: 'Resposta com tamanho suficiente para passar na validação mínima do parser.',
      })),
    ],
  });
  const pares = parseQaPairs(raw);
  assert.ok(pares.length <= 8);
  assert.equal(pares[0].question, 'O tratamento funciona sem cirurgia?');
  assert.equal(pares[1].question, 'Quanto tempo leva?');
  assert.ok(pares.every((p) => p.question.length >= 8 && p.answer.length >= 20));
});

test('parseQaPairs não quebra com lixo', () => {
  assert.deepEqual(parseQaPairs('não é json'), []);
  assert.deepEqual(parseQaPairs('{}'), []);
  assert.deepEqual(parseQaPairs('{"pares": "x"}'), []);
});

test('ehPlaylistYoutube diferencia playlist de vídeo único', async () => {
  const { ehPlaylistYoutube } = await import('./knowledge-links.service.js');
  assert.equal(ehPlaylistYoutube('https://www.youtube.com/playlist?list=PL48lIFXu2xrs10'), true);
  assert.equal(ehPlaylistYoutube('https://www.youtube.com/watch?v=abc12345678&list=PLxyz'), true);
  assert.equal(ehPlaylistYoutube('https://www.youtube.com/watch?v=abc12345678'), false);
  assert.equal(ehPlaylistYoutube('https://youtu.be/abc12345678'), false);
});

test('extrairVideoIdsYoutube deduplica, preserva ordem e respeita o teto', async () => {
  const { extrairVideoIdsYoutube } = await import('./knowledge-links.service.js');
  const html =
    '"videoId":"WXuRnbq9pQo" x "videoId":"AAAAAAAAAAA" y "videoId":"WXuRnbq9pQo" z ' +
    Array.from({ length: 20 }, (_, i) => `"videoId":"BBBBBBBBB${String(i).padStart(2, '0').slice(0, 2)}"`).join(' ');
  const ids = extrairVideoIdsYoutube(html, 5);
  assert.equal(ids.length, 5);
  assert.equal(ids[0], 'WXuRnbq9pQo');
  assert.equal(ids[1], 'AAAAAAAAAAA');
  assert.equal(new Set(ids).size, ids.length);
});
