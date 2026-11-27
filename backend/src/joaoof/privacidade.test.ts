import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDaPessoa, mascarar, trechoCurto, TRECHO_MAX } from './privacidade.js';

test('mascara telefone em vários formatos, CPF e e-mail', () => {
  const t = 'Contato: 55 99 91711-305 / +559492003973 / (94) 9141-8594 / CPF 123.456.789-09 / ana@x.com.br';
  const m = mascarar(t);
  assert.doesNotMatch(m, /\d{4}-\d{3}|\d{8}/);
  assert.doesNotMatch(m, /123\.456/);
  assert.doesNotMatch(m, /ana@x/);
  assert.match(m, /\[número\]/);
  assert.match(m, /\[e-mail\]/);
});

test('corta a query do link (ela leva o telefone) e troca a menção interna por @pessoa', () => {
  const m = mascarar('veja https://x.kommo.com/leads/detail/30082281?filter%5Bterm%5D=94+92136-180 e fala com @264205617909889');
  assert.match(m, /leads\/detail\/30082281(?!\?)/);
  assert.doesNotMatch(m, /92136/);
  assert.match(m, /@pessoa/);
});

test('link com telefone no CAMINHO (wa.me) é mascarado; só o link de lead do Kommo guarda o id', () => {
  assert.doesNotMatch(mascarar('fala com https://wa.me/5594992171305 hoje'), /5594992171305/);
  assert.doesNotMatch(mascarar('https://api.whatsapp.com/send/94992171305/?text=oi'), /94992171305/);
  assert.match(mascarar('lead https://parauapebasdoutorhernia.kommo.com/leads/detail/30082281?filter%5Bterm%5D=1'), /kommo\.com\/leads\/detail\/30082281$/);
});

test('não estraga data, hora, valor nem contagem de leads', () => {
  const t = 'Agendado 23/11 às 15h30 · R$ 1.534,98 · 84 conversas · 2026-11-27 · 02-12 ás 10:00';
  assert.equal(mascarar(t), t);
});

test('trechoCurto mascara, junta espaços e respeita o teto', () => {
  const longo = `Paciente 94 99533-437 ${'texto '.repeat(200)}`;
  const t = trechoCurto(longo);
  assert.ok(t.length <= TRECHO_MAX);
  assert.ok(t.endsWith('…'));
  assert.doesNotMatch(t, /99533/);
  assert.equal(trechoCurto('  oi \n\n  tudo  bem '), 'oi tudo bem');
});

test('chaveDaPessoa: estável, sem número no resultado e SEM segredo não há chave', () => {
  const seg = 'segredo-de-teste-com-16+';
  const a = chaveDaPessoa('55 94 99999-1111', seg);
  const b = chaveDaPessoa('5594999991111', seg);
  assert.ok(a);
  assert.equal(a, b);
  assert.doesNotMatch(a!, /9999/);
  assert.notEqual(a, chaveDaPessoa('5594999991112', seg));
  assert.equal(chaveDaPessoa('5594999991111', undefined), null);
  assert.equal(chaveDaPessoa('5594999991111', 'curto'), null);
  assert.equal(chaveDaPessoa('123', seg), null);
});

test('corte por CARACTERE: nunca deixa surrogate órfão (a Anthropic recusa com 400)', async () => {
  const { cortar } = await import('./privacidade.js');
  const { limpoParaPedido } = await import('./ferramentas.js');
  const soltos = (t: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t);
  const emojis = '😀'.repeat(50); // cada um ocupa 2 unidades UTF-16
  for (let max = 1; max < 40; max++) {
    for (const t of [cortar(emojis, max), trechoCurto(emojis, max), limpoParaPedido(emojis, max)]) {
      assert.equal(soltos(t), false, `max ${max}`);
    }
  }
  assert.equal(Array.from(cortar(`ab${emojis}`, 5)).length, 5);
  assert.equal(cortar('curto', 50), 'curto');
  assert.equal(soltos(trechoCurto(`Texto antes 🙂 depois ${'x'.repeat(300)}`)), false);
  // o corte exatamente no emoji da borda
  const borda = `${'a'.repeat(279)}😀fim`;
  assert.equal(soltos(trechoCurto(borda, 280)), false);
});

test('NUL (\\u0000) é removido: o Postgres o rejeita em coluna text e derrubaria a gravação da unidade inteira', () => {
  assert.equal(mascarar('ab\u0000cd https://x.kommo.com/leads/detail/30082281\u0000'), 'abcd https://x.kommo.com/leads/detail/30082281');
  assert.doesNotMatch(trechoCurto('oi\u0000 tudo\u0000bem'), /\u0000/);
});
