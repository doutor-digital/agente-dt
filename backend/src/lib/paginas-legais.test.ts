import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGINA_PRIVACIDADE, PAGINA_TERMOS } from './paginas-legais.js';

test('termos e privacidade: marca da Doutor Digital, LGPD, sem nome do Chatwoot nem marcador por preencher', () => {
  for (const p of [PAGINA_TERMOS, PAGINA_PRIVACIDADE]) {
    assert.ok(p.startsWith('<!doctype html>') && p.includes('Doutor Digital Atende') && p.includes('lang="pt-BR"'));
    assert.ok(!/chatwoot/i.test(p), 'sem o nome do Chatwoot');
    assert.ok(!/\$\{|TODO|XXX|\[preencher/i.test(p), 'sem marcador por preencher');
    assert.ok(p.includes('href="/termos"') && p.includes('href="/privacidade"'));
  }
  assert.ok(PAGINA_PRIVACIDADE.includes('13.709/2018') && PAGINA_PRIVACIDADE.includes('operadora') && PAGINA_PRIVACIDADE.includes('controladora'));
  assert.ok(PAGINA_TERMOS.includes('não faz diagnóstico'));
});
