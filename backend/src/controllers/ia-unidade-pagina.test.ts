import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginaHtml } from './ia-unidade.controller.js';

test('a página /ia: escapa o nome da unidade, usa o slug só como dado e o script compila', () => {
  const html = paginaHtml('doutor-hernia-timbo', 'Hérnia <script>alert(1)</script> & "Cia"');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'o nome da unidade vem escapado');
  assert.ok(html.includes('Hérnia &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Cia&quot;'));
  assert.ok(html.includes('var SLUG="doutor-hernia-timbo"'));
  const script = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script), 'o JavaScript da página tem erro de sintaxe');
  // dado de paciente só entra na tela por textContent: nunca innerHTML
  assert.ok(!script.includes('innerHTML'));
  // o código vai no cabeçalho, nunca na URL (a URL fica no log de acesso)
  assert.ok(script.includes("'x-codigo'"));
  assert.ok(!script.includes('?codigo='));
});

test('a página /ia: usa o mesmo código guardado pela página de pausar a Sofia (a recepção digita uma vez só)', () => {
  const html = paginaHtml('doutor-hernia-timbo', 'Timbó');
  assert.ok(html.includes("var KC='pausa-codigo-'+SLUG"));
});
