/**
 * Tela "Agente" do Chatwoot: a página abre sem erro de script, só fala com a origem do Chatwoot, não usa innerHTML com dado do
 * servidor; e o CORS do botão libera só as rotas novas do 👍/👎 (com POST só no avaliar).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { paginaDoAgente } = await import('../lib/agente-pagina.js');
const { corsDoAssistente } = await import('./assistente.controller.js');
const { assistenteJs } = await import('../lib/chatwoot-assistente-ui.js');

const CW = 'https://atendimento.exemplo.test';

function scriptDe(html: string): string {
  const i = html.lastIndexOf('<script>');
  const f = html.lastIndexOf('</script>');
  assert.ok(i > 0 && f > i, 'tem script');
  return html.slice(i + '<script>'.length, f);
}

test('a página do Agente parseia, tem as 5 abas (Painel primeiro) e só aceita a origem do Chatwoot', () => {
  const html = paginaDoAgente(CW);
  assert.doesNotThrow(() => new Function(scriptDe(html)));
  for (const aba of ['painel', 'ensinar', 'testar', 'pausadas', 'pedir']) assert.ok(html.includes(`id="aba-${aba}"`) && html.includes(`id="pane-${aba}"`), aba);
  assert.ok(html.includes(`var CW = "${CW}"`));
  assert.ok(html.includes('ev.origin !== CW || ev.source !== window.parent'));
  assert.ok(!html.includes('__ORIGEM_CW__'));
});

test('nenhum dado do servidor entra por innerHTML (só textContent)', () => {
  const js = scriptDe(paginaDoAgente(CW));
  assert.equal((js.match(/innerHTML/g) ?? []).length, 0);
});

test('a página usa as rotas certas (regras, prévia, conversa, pausadas, avaliações, pedidos)', () => {
  const js = scriptDe(paginaDoAgente(CW));
  for (const rota of ["'/api/public/aprendizados/'", "'/previa'", "'/conversa'", "'/regra/'", "'/api/public/testar-ia/pausadas'", "'/api/public/testar-ia/unidades'", "'/api/public/agente/painel?slug='", "'/api/public/agente/avaliacoes/'", "'/api/public/agente/pedidos'", "'/api/public/assistente/pausa'"])
    assert.ok(js.includes(rota), rota);
});

test('CORS do botão: GET das respostas e POST do avaliar, só da origem do Chatwoot', () => {
  const r = corsDoAssistente('/api/public/assistente/respostas', CW, CW);
  assert.deepEqual(r?.methods, ['GET', 'OPTIONS']);
  assert.ok(!r?.allowedHeaders.includes('Content-Type'));
  const a = corsDoAssistente('/api/public/assistente/avaliar', CW, CW);
  assert.deepEqual(a?.methods, ['POST', 'OPTIONS']);
  assert.ok(a?.allowedHeaders.includes('Content-Type') && a.allowedHeaders.includes('X-CW-Token'));
  assert.equal(a?.credentials, false);
  assert.equal(corsDoAssistente('/api/public/assistente/avaliar', 'https://outro.exemplo.test', CW), null);
  assert.equal(corsDoAssistente('/api/public/agente/pedidos', CW, CW), null, 'a tela Agente roda no iframe, mesma origem: sem CORS');
  const e = corsDoAssistente('/api/public/assistente/estado', CW, CW);
  assert.deepEqual(e?.allowedHeaders, ['X-CW-Token', 'X-CW-Client', 'X-CW-Uid']);
});

test('o botão do Chatwoot (menu.js) parseia e põe o 👍/👎 só nos balões que o servidor diz serem da Sofia', () => {
  const js = assistenteJs().split('__AGENTE__').join(JSON.stringify('https://agente.exemplo.test'));
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("'/api/public/assistente/respostas?conversa='"));
  assert.ok(js.includes('[class*="grid-area:bubble"]'));
  assert.ok(js.includes("mensagem: Number(id)"));
});

test('atalhos na caixa de resposta: «⚡ Mensagens prontas» digita "/" (lista nativa) e «Modelos do WhatsApp» só clica no botão nativo', () => {
  const js = assistenteJs().split('__AGENTE__').join(JSON.stringify('https://agente.exemplo.test'));
  assert.doesNotThrow(() => new Function(js));
  const ini = js.indexOf('function estiloAtalhos');
  const fim = js.indexOf("window.addEventListener('message'", ini);
  assert.ok(ini > 0 && fim > ini, 'bloco dos atalhos');
  const bloco = js.slice(ini, fim);
  // só aciona o que é do Chatwoot: o "/" das respostas prontas e o botão nativo de modelos (ícone do WhatsApp)
  assert.ok(bloco.includes("document.execCommand('insertText', false, (ed.innerText || '').trim() ? ' /' : '/')"));
  assert.ok(bloco.includes("b.querySelector('.i-ph-whatsapp-logo')") && bloco.includes('n.click()'));
  // sem a barra nativa não põe nada; sem o botão nativo de modelos, o nosso fica escondido
  assert.ok(bloco.includes("document.querySelectorAll('.left-wrap')") && bloco.includes('m.hidden = !nativo'));
  // texto só por textContent, e um bloco por barra (não duplica a cada segundo)
  assert.equal((bloco.match(/innerHTML/g) ?? []).length, 0);
  assert.ok(bloco.includes("wrap.querySelector('[data-dd-atalhos]')"));
  // roda no mesmo relógio de 1 s do botão, protegido por try/catch
  assert.ok(js.includes('try { marcarCaixaDeResposta(); } catch (e) {}'));
});
