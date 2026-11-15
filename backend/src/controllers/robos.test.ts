/**
 * Tela «Robôs»: a página parseia e só fala com a origem do Chatwoot, não usa innerHTML com dado do servidor, usa as rotas certas; as rotas
 * existem; o menu do Chatwoot ganha o item «Robôs» (com ícone) e continua parseando.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { paginaDosRobos } = await import('../lib/robos-pagina.js');
const { montarMenuJs } = await import('./funil.controller.js');

const CW = 'https://atendimento.exemplo.test';
function scriptDe(html: string): string {
  const i = html.lastIndexOf('<script>');
  const f = html.lastIndexOf('</script>');
  assert.ok(i > 0 && f > i, 'tem script');
  return html.slice(i + '<script>'.length, f);
}

test('a página dos Robôs parseia, só aceita a origem do Chatwoot e tem o molde (lista, prancheta, Editor/Execuções, proteções)', () => {
  const html = paginaDosRobos(CW);
  assert.doesNotThrow(() => new Function(scriptDe(html)));
  assert.ok(html.includes(`var CW = "${CW}"`));
  assert.ok(html.includes('ev.origin !== CW || ev.source !== window.parent'));
  assert.ok(!html.includes('__ORIGEM_CW__'));
  // a logo da Doutor Digital entra embutida (sem placeholder sobrando) e todo ícone usado existe como símbolo
  assert.ok(!html.includes('__LOGO_DD__'));
  assert.ok(html.includes('src="data:image/png;base64,'), 'logo DD embutida');
  for (const usado of new Set(Array.from(html.matchAll(/'(i-[a-z]+)'/g), (m) => m[1]))) assert.ok(html.includes(`<symbol id="${usado}"`), `símbolo ${usado}`);
  for (const id of ['id="lista"', 'id="tela"', 'id="abEd"', 'id="abEx"', 'id="swAtivo"', 'id="busca"']) assert.ok(html.includes(id), id);
  for (const bloco of ["'Gatilho'", "'Esperar'", "'Só se'", "'Não envia'", 'Proteções de todo robô']) assert.ok(html.includes(bloco), bloco);
  assert.ok(html.includes('radial-gradient(var(--dot)'), 'prancheta pontilhada');
  assert.ok(html.includes('prefers-color-scheme:dark'), 'tema escuro');
});

test('nenhum dado do servidor entra por innerHTML, e o script não usa crase nem ${} (é um String.raw)', () => {
  const js = scriptDe(paginaDosRobos(CW));
  assert.equal((js.match(/innerHTML/g) ?? []).length, 0);
  assert.equal(js.includes('`'), false);
  assert.equal(js.includes('${'), false);
});

test('a página usa as rotas da tela Robôs e as rotas existem no roteador', () => {
  const js = scriptDe(paginaDosRobos(CW));
  for (const rota of ["'/api/public/robos?slug='", "'/api/public/robos/enviados?slug='", "'/api/public/robos/'", "'/api/public/testar-ia/unidades'"]) assert.ok(js.includes(rota), rota);
  const rotas = readFileSync(fileURLToPath(new URL('../routes/api.routes.ts', import.meta.url)), 'utf8');
  assert.ok(rotas.includes("apiRouter.get('/public/robos', robosHandler)"));
  assert.ok(rotas.includes("apiRouter.get('/public/robos/enviados', robosEnviadosHandler)"));
  assert.ok(rotas.includes("apiRouter.post('/public/robos/:regra', robosMudarHandler)"));
  const servidor = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');
  assert.ok(servidor.includes("app.get('/funil/robos', paginaRobosHandler)"));
});

test('Fase A: Gatilho e «Só se» são só leitura; Esperar e Enviar são editáveis só para quem pode; a direção não tem seletor', () => {
  const js = scriptDe(paginaDosRobos(CW));
  assert.ok(js.includes('Somente leitura: o gatilho'));
  assert.ok(js.includes('Somente leitura: as condições'));
  // o painel de Esperar mostra a direção como texto fixo (t.direcao), nunca como select antes/depois
  assert.ok(js.includes("'dir', t.direcao + ' ' + t.ancora"));
  assert.equal(js.includes("['antes', 'depois']"), false);
  // sem permissão, nada de Aplicar: o botão só existe quando editavel
  assert.ok(js.includes('if (editavel && aplicar)'));
  assert.ok(js.includes('s.disabled = !PODE'));
  // «+ Novo» é da Fase B: existe, mas desligado
  assert.ok(paginaDosRobos(CW).includes('id="btNovo" disabled'));
});

test('o menu do Chatwoot ganha «Robôs» (url /funil/robos, ícone próprio) e o menu.js continua parseando', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("nome: 'Robôs'") && js.includes("url: '/funil/robos'") && js.includes("marca: 'data-robos-menu'"));
  assert.ok(js.includes('ICONES.robos'));
});

test('aba Automações: seletor «Robôs de mensagem | Automações», cartão com 3 estados, confirmação do que não tem volta, regras nativas e rotas', () => {
  const html = paginaDosRobos(CW);
  const js = scriptDe(html);
  assert.ok(html.includes('id="mRobos"') && html.includes('id="mAuto"') && html.includes('Robôs de mensagem') && html.includes('Automações'));
  for (const g of ['Sofia', 'Agenda', 'Mensagens', 'Rastreio', 'Organização', 'Avisos para a equipe', 'Regras nativas do Chatwoot']) assert.ok(js.includes(`'${g}'`), g);
  for (const r of ["'/api/public/robos/automacoes?slug='", "'/api/public/robos/automacoes/'"]) assert.ok(js.includes(r), r);
  assert.ok(js.includes('Entendi, ligar mesmo') && js.includes('NÃO TEM VOLTA'), 'confirmação explícita');
  assert.ok(js.includes("a.semVolta && alvo === 'ligado'"));
  assert.ok(js.includes('Sem registro: o log do servidor não guardou nada'), 'sem log, «sem registro»');
  assert.ok(js.includes('b.disabled = !PODE'), 'atendente só vê');
  assert.ok(js.includes('window.open(AUTO.nativas.link'), 'link para a tela nativa');
  const rotas = readFileSync(fileURLToPath(new URL('../routes/api.routes.ts', import.meta.url)), 'utf8');
  assert.ok(rotas.includes("apiRouter.get('/public/robos/automacoes', robosAutomacoesHandler)"));
  assert.ok(rotas.includes("apiRouter.post('/public/robos/automacoes/:id', robosAutomacaoMudarHandler)"));
});

test('a tela salva TODOS os seletores alterados, um pedido por vez, e só diz «Salvo» depois que o servidor confirmou; o texto de ajuda diz a verdade sobre a janela', () => {
  const js = scriptDe(paginaDosRobos(CW));
  assert.ok(js.includes('mud.map(function(z){ return { modelo:'), 'um pedido por seletor alterado');
  assert.ok(js.includes('async function enviar(partes, botao, fecha)') && js.includes('for (var i = 0; i < partes.length; i++)'));
  // o toast de sucesso vem DEPOIS do await do POST (e uma falha no meio avisa quantas foram salvas)
  const i = js.indexOf('async function enviar(partes');
  const bloco = js.slice(i, js.indexOf('async function ligarDesligar', i));
  assert.ok(bloco.indexOf("await api('POST'") < bloco.indexOf("toast('Salvo."), 'Salvo só depois da resposta');
  assert.ok(bloco.includes('alterações foram salvas'));
  assert.ok(js.includes('só se for em até 2 horas depois do horário') && js.includes('até 12 horas depois do horário'));
  assert.equal(js.includes('sai na próxima abertura'), false, 'o texto antigo, que prometia o que o lembrete «antes» não faz');
});
