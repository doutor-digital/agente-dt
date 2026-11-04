import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { iaApiHandler, paginaHtml } from './ia-unidade.controller.js';

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

test('a página /ia: o código digitado só é guardado depois que o servidor aceita (não apaga o código bom da /pausa)', () => {
  const script = paginaHtml('x', 'X').split('<script>')[1];
  const clique = script.split("$('btnEntrar')")[1].split('\n')[0];
  assert.ok(!clique.includes('guardarCodigo'), 'o clique em "Ver" não pode gravar antes de conferir');
  assert.ok(script.includes('if(novoCodigo) guardarCodigo(novoCodigo);'));
});

test('a página /ia: depois das tentativas automáticas mostra mensagem em vez de ficar em "Lendo o Kommo…"', () => {
  assert.ok(paginaHtml('x', 'X').includes('O Kommo está demorando mais que o normal'));
});

test('a página /ia: usa o mesmo código guardado pela página de pausar a Sofia (a recepção digita uma vez só)', () => {
  const html = paginaHtml('doutor-hernia-timbo', 'Timbó');
  assert.ok(html.includes("var KC='pausa-codigo-'+SLUG"));
});

// ── a porta da API: 404 não conta, só erro de código conta ──

function chamar(slug: string, codigo: string | undefined, ip = '10.0.0.1') {
  const out: { status: number; body?: unknown } = { status: 200 };
  const res = {
    setHeader() {},
    status(c: number) {
      out.status = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  };
  const req = { params: { slug }, ip, query: {}, header: (n: string) => (n === 'x-codigo' ? codigo : undefined) };
  return iaApiHandler(req as never, res as never).then(() => out);
}

test('API /ia: slug inventado (404) não conta tentativa; 12 códigos errados bloqueiam a unidade real e 5.000 slugs inventados não destravam', async () => {
  const unidade = { id: 'u1', slug: 'doutor-hernia-timbo', isActive: true, pausaCodigo: '482913', kommoSubdomain: null, kommoAccessToken: null, name: 'Timbó', spineTimezone: 'America/Sao_Paulo', businessHoursTimezone: null };
  const antes = (prisma as unknown as { unit: Record<string, unknown> }).unit;
  Object.defineProperty(prisma, 'unit', {
    value: { ...antes, findUnique: async (a: { where: { slug: string } }) => (a.where.slug === unidade.slug ? unidade : null) },
    configurable: true,
  });
  try {
    for (let i = 0; i < 12; i++) assert.equal((await chamar('doutor-hernia-timbo', '000000')).status, 403);
    assert.equal((await chamar('doutor-hernia-timbo', '000000')).status, 429);
    assert.equal((await chamar('doutor-hernia-timbo', '482913')).status, 429, 'bloqueado: nem o código certo passa');
    for (let i = 0; i < 5000; i++) await chamar(`inventado-${i}`, '000000');
    assert.equal((await chamar('doutor-hernia-timbo', '000000')).status, 429, 'os 404 não zeraram o contador');
    assert.equal((await chamar('inventado-1', '000000')).status, 404, 'slug inventado é sempre 404, nunca 429');
    assert.equal((await chamar('doutor-hernia-timbo', '000000', '10.0.0.2')).status, 403, 'outro ip tem a sua conta');
  } finally {
    Object.defineProperty(prisma, 'unit', { value: antes, configurable: true });
  }
});
