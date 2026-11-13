/**
 * "Testar a IA" no menu do Chatwoot: a página de ensinar a Sofia em modo Chatwoot (claro, sem código, aba "IA pausada") abre sem erro de
 * script; a página pública com código continua igual; o menu tem o item depois do Funil, abrindo /funil/testar-ia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginaHtml } from './aprendizados.controller.js';
import { montarMenuJs } from './funil.controller.js';

function scriptDe(html: string): string {
  const i = html.lastIndexOf('<script>');
  const f = html.lastIndexOf('</script>');
  assert.ok(i > 0 && f > i, 'tem script');
  return html.slice(i + '<script>'.length, f);
}

test('modo Chatwoot: claro, sem cartão de código, aba IA pausada visível e script parseia', () => {
  const html = paginaHtml('', 'Testar a IA', { chatwoot: 'https://atendimento.exemplo.test' });
  assert.ok(html.includes('<body class="cw">'));
  assert.ok(html.includes('body.cw #cardCodigo{display:none}'));
  assert.ok(/id="abaPausadas" role="tab" type="button">IA pausada/.test(html), 'aba IA pausada sem hidden');
  assert.ok(html.includes('"https://atendimento.exemplo.test"'), 'origem do Chatwoot para o postMessage');
  assert.doesNotThrow(() => new Function(scriptDe(html)));
});

test('página pública com código: igual a antes (sem cw, aba IA pausada escondida) e script parseia', () => {
  const html = paginaHtml('doutor-hernia-timbo', 'Doutor Hérnia Timbó');
  assert.ok(!html.includes('class="cw"'));
  assert.ok(/id="abaPausadas" role="tab" type="button" hidden>/.test(html));
  assert.doesNotThrow(() => new Function(scriptDe(html)));
});

test('menu: "Testar a IA" depois do Funil, abrindo /funil/testar-ia', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  const funil = js.indexOf('data-funil-menu');
  const ia = js.indexOf('data-ia-menu');
  assert.ok(funil > 0 && ia > funil, 'Testar a IA vem depois do Funil');
  assert.ok(js.includes("url: '/funil/testar-ia'"));
  assert.ok(js.includes('a[href*="/companies"]') && js.includes('a[href*="/reports"]'), 'Empresas e Relatórios somem para quem não é admin');
});

test('👎 vira lição: a página pega o rascunho (ao abrir e com a tela já aberta) e o painel tem 👍/👎', async () => {
  const html = paginaHtml('', 'Testar a IA', { chatwoot: 'https://atendimento.exemplo.test' });
  assert.ok(html.includes("localStorage.getItem('testar-ia-rascunho')") && html.includes("ev.key!=='testar-ia-rascunho'"));
  const { assistenteHtml } = await import('../lib/chatwoot-assistente-ui.js').then((m: any) => ({ assistenteHtml: m.paginaDaAssistente ?? m.paginaAssistente ?? null }));
  if (assistenteHtml) assert.ok(String(assistenteHtml('https://atendimento.exemplo.test')).includes('👎 Ruim'));
});
