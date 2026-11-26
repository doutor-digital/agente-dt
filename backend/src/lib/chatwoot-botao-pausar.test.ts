/**
 * Botão «Pausar Sofia» na conversa (menu.js): desligado por padrão (a unidade que não pediu fica idêntica), parseia, só usa os endpoints da pausa que já existem,
 * a CORS deixa o menu chamá-los, e o servidor diz se a Sofia do CRM está ligada para a unidade (senão o botão não aparece).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { botaoPausarJs, botaoPausarLigado } = await import('./chatwoot-botao-pausar.js');
const { montarMenuJs } = await import('../controllers/funil.controller.js');
const { corsDoAssistente, sofiaDoCrmAtiva } = await import('../controllers/assistente.controller.js');
const { _semearParaTeste, _esquecerOBancoParaTeste } = await import('./automacoes-estado.js');
const { DO_CATALOGO, FIXAS } = await import('./robos-automacoes.js');

const AGENTE = 'https://agente.exemplo.test';
const ORIGEM = JSON.stringify(AGENTE);

test('desligado por padrão: sem CHATWOOT_BOTAO_PAUSAR=1 não entra nada no menu.js (o menu é idêntico ao de antes)', () => {
  for (const v of [undefined, '', '0', 'true', 'sim']) assert.equal(botaoPausarLigado({ CHATWOOT_BOTAO_PAUSAR: v }), false, String(v));
  assert.equal(botaoPausarJs(ORIGEM, {}), '');
  const antes = process.env.CHATWOOT_BOTAO_PAUSAR;
  delete process.env.CHATWOOT_BOTAO_PAUSAR;
  try {
    assert.ok(!montarMenuJs(AGENTE).includes('__botaoPausarDD'));
    process.env.CHATWOOT_BOTAO_PAUSAR = '1';
    const js = montarMenuJs(AGENTE);
    assert.ok(js.includes('__botaoPausarDD'), 'com a chave, o bloco entra no menu.js');
    assert.doesNotThrow(() => new Function(js), 'o menu.js inteiro continua parseando');
    assert.ok(js.includes(';try{\n(function(){\n  if (window.top !== window || window.__botaoPausarDD)'), 'bloco independente: dentro do próprio try');
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_BOTAO_PAUSAR;
    else process.env.CHATWOOT_BOTAO_PAUSAR = antes;
  }
});

test('o bloco parseia, usa SÓ os endpoints da pausa que já existem, nunca innerHTML, e escreve só com o clique', () => {
  const js = botaoPausarJs(ORIGEM, { CHATWOOT_BOTAO_PAUSAR: '1' });
  assert.ok(js.length > 500);
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('var AGENTE = ' + ORIGEM + ','), 'o endereço do servidor entra como JSON');
  const rotas = [...js.matchAll(/\/api\/public\/[a-z/-]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(rotas)], ['/api/public/assistente/pausa']);
  assert.equal((js.match(/innerHTML/g) ?? []).length, 0);
  assert.equal((js.match(/method: 'POST'/g) ?? []).length, 1, 'um único POST, dentro do clique');
  const posPost = js.indexOf("method: 'POST'");
  assert.ok(js.lastIndexOf('function clicar', posPost) > 0 && js.lastIndexOf('function clicar', posPost) > js.lastIndexOf('function ler', posPost), 'o POST está em clicar()');
  assert.ok(js.includes("acao: est.pausada ? 'reativar' : 'pausar'"), 'o mesmo botão pausa e reativa');
  assert.ok(js.includes("'Pausar Sofia'") && js.includes("'Reativar Sofia'"));
  assert.ok(js.includes('j.sofia !== false'), 'unidade com a Sofia desligada: a barra não aparece');
  assert.ok(js.includes('r.status === 422') && js.includes('r.status === 401'), 'sem Sofia ou sessão vencida: a barra não aparece e não insiste');
  assert.ok(js.includes('window.confirm('), 'pausar pergunta antes (passa a conversa para quem clicou)');
  assert.ok(js.includes('if (j.sofia === false) est.aplicavel = false;'), 'o POST também diz se a Sofia foi desligada');
  assert.ok(js.includes('> 90000'), 'releitura a cada 90 s');
  assert.ok(js.includes('wrap.insertBefore(b, wrap.firstChild); // uma vez só'), 'entra uma vez e nunca é reposicionada (o selo usa o mesmo topo)');
  assert.ok(!/[`]|\$\{/.test(js), 'sem crase nem interpolação dentro do String.raw');
});

test('CORS: o menu (origem do Chatwoot) pode LER e MUDAR a pausa; outra origem e outras rotas seguem fechadas', () => {
  const cw = 'https://crm.exemplo.test';
  const c = corsDoAssistente('/api/public/assistente/pausa', cw, [cw]);
  assert.ok(c);
  assert.deepEqual(c!.methods.sort(), ['GET', 'OPTIONS', 'POST']);
  assert.ok(c!.allowedHeaders.includes('Content-Type') && c!.allowedHeaders.includes('X-CW-Token'));
  assert.equal(c!.credentials, false);
  assert.equal(corsDoAssistente('/api/public/assistente/pausa', 'https://outro.test', [cw]), null, 'só a origem do Chatwoot');
  assert.equal(corsDoAssistente('/api/public/assistente/sugerir', cw, [cw]), null, 'as outras rotas do painel continuam sem CORS');
});

test('só onde há Sofia LIGADA: só no papel e desligada = não (o servidor manda sofia: false)', () => {
  const SLUG = 'doutor-hernia-parauapebas';
  try {
    _esquecerOBancoParaTeste();
    assert.equal(sofiaDoCrmAtiva(SLUG, {}), false, 'sem chave e sem linha: desligada');
    assert.equal(sofiaDoCrmAtiva(SLUG, { CHATWOOT_IA_SLUGS: SLUG }), true);
    assert.equal(sofiaDoCrmAtiva(SLUG, { CHATWOOT_IA_SLUGS: 'outra-unidade' }), false);
    _semearParaTeste([{ slug: SLUG, automacao: 'chatwoot-ia', estado: 'seco' }]);
    assert.equal(sofiaDoCrmAtiva(SLUG, {}), false, 'só no papel NÃO conta: ela não responde, pausar não faz sentido');
    _semearParaTeste([{ slug: SLUG, automacao: 'chatwoot-ia', estado: 'ligado' }]);
    assert.equal(sofiaDoCrmAtiva(SLUG, {}), true);
    _semearParaTeste([{ slug: SLUG, automacao: 'chatwoot-ia', estado: 'desligado' }]);
    assert.equal(sofiaDoCrmAtiva(SLUG, { CHATWOOT_IA_SLUGS: SLUG }), false, 'a tela vence o .env');
  } finally {
    _esquecerOBancoParaTeste();
  }
});

test('a tela de robôs conhece a chave nova e ela está no código', async () => {
  const f = FIXAS.find((x) => x.variavel === 'CHATWOOT_BOTAO_PAUSAR');
  assert.ok(f, 'fixa do botão');
  assert.ok(DO_CATALOGO && f!.id);
});
