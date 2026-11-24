/**
 * Tela "Agente" do Chatwoot: a página abre sem erro de script, só fala com a origem do Chatwoot, não usa innerHTML com dado do
 * servidor; e o CORS do botão libera só as rotas novas do 👍/👎 (com POST só no avaliar).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { paginaDoAgente, paginaDoAgenteKommo } = await import('../lib/agente-pagina.js');
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
  assert.ok(html.includes(`var CW = origemDoPai("${CW}")`));
  assert.ok(html.includes('!origemDoCrm(ev.origin) || ev.source !== window.parent'));
  assert.ok(!html.includes('__ORIGEM_CW__'));
});

test('tela Placar: faixa de atenção, card «Consultas marcadas» abre a lista completa, tema claro e escuro, 44 px no celular', () => {
  const html = paginaDoAgente(CW);
  for (const id of ['nRevisar', 'nPausadas', 'nPedidos', 'grandes', 'peq', 'dlgConsultas', 'dlgLista', 'listaPausadasPainel']) assert.ok(html.includes(`id="${id}"`), id);
  const js = scriptDe(html);
  assert.ok(js.includes('abrirConsultas') && js.includes('consultasDoPeriodo'), 'o card de consultas abre a lista que vem do painel');
  assert.ok(js.includes('m.quem') && js.includes("'Quem agendou'"), 'a lista mostra quem agendou');
  assert.ok(js.includes("'funil-tema'") && html.includes('[data-tema=escuro]') && html.includes('prefers-color-scheme'), 'tema do CRM (e quando ele muda) + o do aparelho');
  assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
  assert.ok(html.includes('.bt{min-height:44px}'), 'botões de 44 px no celular');
});

test('Placar: trocar de unidade recarrega os pedidos abertos e limpa o painel; erro limpa TUDO (não só os gráficos)', () => {
  const js = scriptDe(paginaDoAgente(CW));
  const troca = /function escolherUnidade\(u\)\{[\s\S]*?\n  \}/.exec(js)?.[0] ?? '';
  assert.ok(troca.includes('carregarPedidos()') && troca.includes('painelVazio()'), 'a troca de unidade recarrega pedidos e limpa o painel');
  const vazio = /function painelVazio\(\)\{[\s\S]*?\n  \}/.exec(js)?.[0] ?? '';
  for (const id of ["'grandes'", "'peq'", "'nRevisar'", "'listaRevisar'", "'listaMarcadas'", "'listaPausadasPainel'", "'tabDia'", "'lidoEm'", "'nPausadas'"]) assert.ok(vazio.includes(id), id);
  for (const fn of ['carregarPainel', 'contarPausadas', 'carregarPedidos']) assert.ok(new RegExp(`async function ${fn}\\(\\)\\{[\\s\\S]*?U\\.slug !== slug`).test(js), `${fn} descarta resposta de outra unidade`);
  assert.ok(js.includes('painelVazio(); erroEm($(\'grandes\'), e.message); }'), 'o erro do painel limpa tudo antes de mostrar a mensagem');
  assert.ok(js.includes('function fecharDialogo(d)') && !/\.close\(\)/.test(js.replace('if (d.close) d.close();', '')), 'o dialog tem fallback sem showModal/close');
});

test('Placar no modo Kommo: parseia, sem «para revisar», sem «quem agendou», consultas com «Abrir cartão»', () => {
  const html = paginaDoAgenteKommo('doutor-hernia-caxias');
  assert.doesNotThrow(() => new Function(scriptDe(html)));
  assert.ok(html.includes('body.km .col-quem,body.km #tRevisar,body.km #blocoPix{display:none}'));
  const js = scriptDe(html);
  assert.ok(js.includes("if (!KM) desenharRevisar("), 'sem revisão no Kommo');
  assert.ok(js.includes("'Abrir cartão'") && js.includes('Ver as consultas'));
  assert.ok(!html.includes('__KOMMO__') && !html.includes('__ORIGEM_CW__'));
});

test('PR 2a: todo número do painel abre a lista (só no CRM), com o bloco do Pix; nada de link nem chave Pix na página', () => {
  const html = paginaDoAgente(CW);
  const js = scriptDe(html);
  for (const medida of ['respondidas', 'marcaram', 'equipe', 'pix', 'fora', 'avaliacoes']) assert.ok(js.includes(`'${medida}'`), medida);
  for (const id of ['blocoPix', 'listaPix', 'dlgFiltros', 'dlgCab']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(js.includes("'/api/public/agente/detalhe?slug='"), 'rota da lista');
  // no Kommo o card não vira botão e o bloco do Pix some (a rota é só do CRM)
  assert.ok(js.includes('if (medida && !KM)') && js.includes('if (!KM) carregarBlocos();'), 'detalhe atrás de !KM');
  assert.ok(html.includes('body.km #blocoPix'), 'bloco do Pix escondido no Kommo');
  // a página só lê valor, situação e datas do Pix: nunca o link nem a chave
  assert.ok(!/\b(linkId|paymentId|copiaECola|chavePix)\b/.test(js) && !/\bl\.pix\.(url|link)\b/.test(js), 'a página não toca link nem chave Pix');
  for (const campo of ['l.pix.valorCentavos', 'l.pix.situacao', 'l.pix.geradoEm']) assert.ok(js.includes(campo), campo);
  // o card «À noite ou fim de semana» conta respostas: a lista diz «respostas em conversas» e usa o total de respostas
  assert.ok(js.includes('r.totalRespostas'), 'o total da lista de «fora do horário» bate com o card');
  const kmHtml = paginaDoAgenteKommo('doutor-hernia-caxias');
  assert.ok(scriptDe(kmHtml).includes('if (medida && !KM)'));
});

test('abrirDialogo não reabre um dialog JÁ aberto (a 2ª chamada lança em navegador antigo) e tem fallback sem showModal', () => {
  const js = scriptDe(paginaDoAgente(CW));
  const fonte = /function abrirDialogo\(d\)\{[^\n]*\}/.exec(js)?.[0];
  assert.ok(fonte, 'achou abrirDialogo');
  const abrir = new Function(`${fonte}; return abrirDialogo;`)() as (d: unknown) => void;
  // navegador anterior à spec de 2023: showModal() num dialog aberto lança
  const antigo = { open: false, chamadas: 0, showModal() { this.chamadas++; if (this.open) throw new Error('InvalidStateError'); this.open = true; }, setAttribute() {} };
  abrir(antigo);
  assert.doesNotThrow(() => { abrir(antigo); abrir(antigo); }, 'carregando, dados e cada clique de filtro chamam de novo');
  assert.equal(antigo.chamadas, 1, 'showModal só na primeira');
  // sem showModal: abre pelo atributo
  const attrs: string[] = [];
  abrir({ open: false, setAttribute: (k: string) => attrs.push(k) });
  assert.deepEqual(attrs, ['open']);
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

test('atalhos na caixa de resposta: só acionam o nativo, nunca empurram o «Enviar», somem na nota privada, «📋» com a janela fechada, limpam a "/" e desligam pelo servidor', () => {
  const js = assistenteJs({}).split('__AGENTE__').join(JSON.stringify('https://agente.exemplo.test'));
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('var ATALHOS = true;'));
  assert.ok(assistenteJs({ CHATWOOT_ATALHOS: '0' }).includes('var ATALHOS = false;'), 'CHATWOOT_ATALHOS=0 desliga');
  const ini = js.indexOf('var ATALHOS');
  const fim = js.indexOf("window.addEventListener('message'", ini);
  const bloco = js.slice(ini, fim);
  assert.ok(bloco.includes("document.execCommand('insertText', false, token)") && bloco.includes("? ' /' : '/'"), 'o "/" abre a lista nativa');
  assert.ok(bloco.includes("b.querySelector('.i-ph-whatsapp-logo')") && bloco.includes('n.click()'), 'modelos = botão nativo');
  assert.ok(bloco.includes("hidden = emNotaPrivada() || !editorLivre(wrap)"), '«⚡» some na nota privada e sem editor');
  assert.ok(bloco.includes("hidden = !botaoNativoDeModelos(wrap)"), '«📋» só com o nativo');
  assert.ok(bloco.includes('.i-ph-whatsapp-logo') && bloco.includes('ICONES_NATIVOS'), 'janela fechada (sem emoji/clipe) ainda acha a barra');
  assert.ok(bloco.includes('enviar.scrollWidth') && bloco.includes("classList.add('compacto')") && bloco.includes('box.hidden = true'), 'mede a sobra: nome → ícone → some');
  assert.ok(bloco.includes("document.querySelector('[data-popover-content]')") && bloco.includes("execCommand('delete')"), 'tira a "/" solta');
  assert.ok(bloco.includes('conversaDaUrl() !== w.conversa') && bloco.includes('!w.ed.contains(ativo)'), 'desiste se trocou de conversa ou foi para outro campo');
  assert.ok(!bloco.includes('font:500') && !js.includes('/1.2 inherit'), 'sem atalho font com inherit (CSS inválido)');
  assert.equal((bloco.match(/innerHTML/g) ?? []).length, 0);
  assert.ok(js.includes('try { marcarCaixaDeResposta(); } catch (e) {}'));
});
