/**
 * Barra lateral por papel (CHATWOOT_BARRA_POR_PAPEL): desligada o `menu.js` sai BYTE A BYTE igual ao de main; ligada o bloco entra no fim, independente,
 * parseia, só LÊ o Chatwoot (uma consulta, só POST de busca), esconde só por atributo, e o selo da Sofia e a janela do «Resolver» seguem no arquivo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/x';
process.env.SESSION_JWT_SECRET ??= 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';

const { barraPorPapelJs, barraPorPapelLigada, chavePasta, ETIQUETAS_DO_CONTADOR, PASTAS_DA_BARRA } = await import('./chatwoot-barra-papel.js');
const { montarMenuJs } = await import('../controllers/funil.controller.js');
const { ETIQUETA_HUMANO } = await import('./chatwoot-sofia.js');
const { ETIQUETA_PAUSA } = await import('./chatwoot-pausa.js');
const { seloSofiaJs } = await import('./chatwoot-selo-sofia.js');

const LIGADA = { CHATWOOT_BARRA_POR_PAPEL: '1' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// O menu.js que a MAIN de e14d8e85 entrega (montarMenuJs com o __AGENTE__ já trocado), por argumento: tamanho e SHA-256 medidos no código de main.
// Sem a chave ligada o menu.js tem de sair BYTE A BYTE igual: é o que diz que ninguém, em nenhuma clínica, viu a barra mudar. Se alguém mexer DE PROPÓSITO
// no menu.js, estes números mudam junto (o teste diz qual): para renovar, imprima length e sha256 de montarMenuJs('https://agente.exemplo.test', [], { 'x.exemplo.test': 5 }) e de [3, 7] em main.
// Renovado de propósito (perf/menu-js): o freio das passadas do menu, do selo da Sofia e da barra agora deixa passar JÁ a primeira mudança depois de uma pausa
// (antes esperava 300–400 ms); só o texto desses três freios mudou, o conteúdo do resto do arquivo é o mesmo.
const DE_MAIN: Array<[readonly number[], number, string]> = [
  [[], 119410, '985d61576d74d2484ec5d05bc2f4455bfc7d3c3f51f1464bc7bad02642d295bb'],
  [[3, 7], 119416, '24a7137d25be3b32ce0b9968d63f6f4790d94350b6d822811ffff77563a8c25a'],
];
const DOMINIOS = { 'x.exemplo.test': 5 };

test('SEM a chave o menu.js sai BYTE A BYTE igual ao de main (tamanho e SHA-256); «0», vazio, «true» e «2» também não ligam', () => {
  const salvo = process.env.CHATWOOT_BARRA_POR_PAPEL;
  // as chaves de OUTROS blocos do menu.js mudam o arquivo: o teste mede com todas no padrão
  const outras = ['CHATWOOT_SELO_SOFIA', 'CHATWOOT_ATALHOS', 'CHATWOOT_RESOLVER_OBRIGATORIO'];
  const guardadas = outras.map((k) => [k, process.env[k]] as const);
  for (const k of outras) delete process.env[k];
  try {
    for (const v of [undefined, '', '0', 'true', '2', ' ']) {
      if (v === undefined) delete process.env.CHATWOOT_BARRA_POR_PAPEL;
      else process.env.CHATWOOT_BARRA_POR_PAPEL = v;
      for (const [contas, tamanho, hash] of DE_MAIN) {
        const js = montarMenuJs('https://agente.exemplo.test', contas, DOMINIOS);
        assert.equal(js.length, tamanho, `com ${JSON.stringify(v)}: tamanho de ${JSON.stringify(contas)} mudou: ${js.length} (main: ${tamanho})`);
        assert.equal(sha(js), hash, `com ${JSON.stringify(v)}: o menu.js de ${JSON.stringify(contas)} não é o de main`);
      }
      assert.equal(barraPorPapelJs(), '');
    }
  } finally {
    if (salvo === undefined) delete process.env.CHATWOOT_BARRA_POR_PAPEL;
    else process.env.CHATWOOT_BARRA_POR_PAPEL = salvo;
    for (const [k, v] of guardadas) if (v !== undefined) process.env[k] = v;
  }
  assert.equal(barraPorPapelLigada({}), false);
  assert.equal(barraPorPapelLigada({ CHATWOOT_BARRA_POR_PAPEL: '1' }), true);
  assert.equal(barraPorPapelLigada({ CHATWOOT_BARRA_POR_PAPEL: ' 1 ' }), true);
});

test('COM a chave: o bloco entra no FIM do menu.js, dentro do seu try; o resto do arquivo é exatamente o de main', () => {
  const salvo = process.env.CHATWOOT_BARRA_POR_PAPEL;
  try {
    process.env.CHATWOOT_BARRA_POR_PAPEL = '1';
    const com = montarMenuJs('https://agente.exemplo.test', [], DOMINIOS);
    delete process.env.CHATWOOT_BARRA_POR_PAPEL;
    const sem = montarMenuJs('https://agente.exemplo.test', [], DOMINIOS);
    const bloco = `;try{\n${barraPorPapelJs(LIGADA)}\n}catch(e){}\n`;
    assert.ok(com.endsWith(bloco), 'o bloco é o último, no próprio try/catch');
    assert.equal(com.slice(0, com.length - bloco.length), sem, 'tirando o bloco, volta ao menu.js de sempre');
    assert.doesNotThrow(() => new Function(com), 'o arquivo inteiro parseia (erro de sintaxe derrubaria menu, assistente, guia e selo)');
    // não quebra o selo da Sofia nem a janela do «Resolver»
    assert.ok(com.includes('data-dd-sofia') && com.includes(seloSofiaJs().slice(0, 80)), 'o selo da Sofia segue no arquivo');
    assert.ok(com.includes('var OBRIGATORIOS = true;'), 'a janela de campos obrigatórios do «Resolver» segue no arquivo');
  } finally {
    if (salvo === undefined) delete process.env.CHATWOOT_BARRA_POR_PAPEL;
    else process.env.CHATWOOT_BARRA_POR_PAPEL = salvo;
  }
});

test('o bloco parseia, não usa innerHTML nem eval, e a chave do navegador (window.__barraPapelDD) evita carregar duas vezes', () => {
  const js = barraPorPapelJs(LIGADA);
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes('__PASTAS__') && !js.includes('__ETIQUETAS__'), 'nenhum marcador ficou para trás');
  assert.equal((js.match(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/g) ?? []).length, 0);
  assert.ok(js.includes('window.__barraPapelDD'));
  assert.ok(js.includes('window.top !== window'), 'só na janela principal, não em iframe');
});

test('só LÊ o Chatwoot: a única requisição que não é GET é o POST de BUSCA conversations/filter; nunca PATCH/PUT/DELETE e nunca grava', () => {
  const js = barraPorPapelJs(LIGADA);
  const metodos = [...js.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(metodos, ['POST']);
  assert.equal((js.match(/fetch\(/g) ?? []).length, 2, 'duas chamadas: o perfil (só se o estado do Chatwoot não responder) e o contador');
  assert.ok(js.includes("'/api/v1/accounts/' + conta + '/conversations/filter'"));
  assert.ok(js.includes("'/api/v1/profile'"));
  assert.ok(!/PATCH|PUT|DELETE|custom_attributes|assignee|\/labels'/.test(js.replace('/conversations/filter', '')), 'nada de gravar etiqueta, atributo ou dono');
  // a mesma sessão do menu: o cookie do próprio Chatwoot, nunca para fora do domínio dele (URL relativa)
  assert.ok(!/https?:\/\//.test(js), 'nenhum endereço absoluto: tudo vai ao próprio Chatwoot');
});

test('contador: etiquetas e status certos, filtro em AND, lê meta.all_count; 60 s de rotina, 15 s por troca de tela, aba escondida não chama', () => {
  assert.deepEqual([...ETIQUETAS_DO_CONTADOR], [ETIQUETA_HUMANO, ETIQUETA_PAUSA], 'as mesmas etiquetas que a Sofia põe (chatwoot-sofia.ts e chatwoot-pausa.ts)');
  const js = barraPorPapelJs(LIGADA);
  assert.ok(js.includes('var PASTAS = ') && js.includes('ETIQUETAS = ["esperando-humano","ia-pausada"]'));
  assert.ok(js.includes("{ attribute_key: 'status', filter_operator: 'equal_to', values: ['open'], query_operator: 'AND' }"), 'só conversas ABERTAS');
  assert.ok(js.includes("{ attribute_key: 'labels', filter_operator: 'equal_to', values: ETIQUETAS, query_operator: null }"), 'qualquer uma das duas etiquetas (equal_to em etiqueta é «alguma delas»)');
  assert.ok(js.includes('j.meta.all_count'));
  assert.ok(js.includes('setInterval(function(){ contar(false); }, 60000)'), 'a rotina é de 60 s');
  assert.ok(js.includes('porTroca ? 15000 : 30000'), 'trocar de tela chama no máximo a cada 15 s; a rotina (tick de 60 s) nunca é barrada por uma chamada recente de troca de tela');
  assert.ok(js.includes("customViews/getConversationCustomViews") && js.includes('return consultaDaPasta() || { payload: ['), 'conta com o filtro da PRÓPRIA pasta (o número bate com a lista); a consulta da proposta é a reserva');
  assert.ok(js.includes('ctl.abort()') && js.includes('}, 15000)'), 'chamada pendurada desiste em 15 s');
  assert.ok(js.includes('cont.conta !== conta') && js.includes('cont.n = null; cont.ultima = 0'), 'trocou de conta: o número da anterior não aparece');
  assert.ok(js.includes('Date.now() - perfil.falhou < 60000'), 'perfil que falha não é pedido de novo a cada passada (400 ms)');
  assert.ok(js.includes("document.visibilityState !== 'visible'"), 'aba escondida não chama');
  assert.ok(js.includes('cont.preso') && js.includes('.catch(function(){ if (cont.conta === conta) cont.n = null; })'), 'uma chamada por vez; falhou, o número some em vez de ficar velho');
  // vermelho de verdade, e é pseudo-elemento (nenhum nó novo dentro do link que o Vue mantém)
  assert.ok(js.includes('#DC2626') && js.includes("'a[' + CONTA + ']::after{content:attr(' + CONTA + ')"));
  assert.ok(js.includes("'99+'"));
});

test('a atendente (papel agent): grupos escondidos por ÍCONE, telas de gestão fora, e o resto fica; tudo por atributo, nada é removido', () => {
  const js = barraPorPapelJs(LIGADA);
  for (const ic of ['i-woot-captain', 'i-lucide-building-2', 'i-lucide-chart-spline', 'i-lucide-megaphone', 'i-lucide-library-big', 'i-lucide-bolt']) {
    assert.ok(js.includes(`'${ic}'`), `esconde o grupo do ícone ${ic}`);
  }
  for (const m of ['data-oport-menu', 'data-funil-menu', 'data-robos-menu', 'data-disparos-menu']) assert.ok(js.includes(`'${m}'`), `tela ${m} fora da barra dela`);
  assert.ok(js.includes("if (papel === 'agent') barraDaAtendente(ul); else desfazer(ul);"), 'só o papel agent enxuga; administrador (e qualquer outro) vê tudo');
  assert.ok(js.includes('var papel = papelAtual(); if (!papel) return;'), 'sem papel conhecido nada some (falha aberta)');
  assert.ok(js.includes("[' + OCULTO + ']{display:none!important}") || js.includes("'[' + OCULTO + ']{display:none!important}'"), 'esconder é só CSS');
  // a janela do «Resolver» e o resto da assistente moram em .conversation-details-wrap / botão próprio: o bloco só toca no <aside><nav>
  assert.ok(!js.includes('.resolve-actions') && !js.includes('conversation-details-wrap') && !js.includes('data-dd-sofia'));
  assert.ok(js.includes('Sofia (ensinar e testar)') && js.includes("'Ferramentas'") && js.includes("'Sem dono'") && js.includes("'Minhas'") && js.includes("'Todas'"));
  assert.ok(js.includes('☀️ Hoje'));
  assert.ok(js.includes("'data-hoje-menu', 'data-oport-menu', 'data-mkt-menu', 'data-gestor-menu'") && js.includes('ordem(item(m), -50 + i)'), 'Hoje (e o submenu dele) sobe para o topo para TODOS os papéis');
});

test('as 5 pastas: na ordem da proposta e comparadas sem emoji, sem acento e sem caixa', () => {
  assert.deepEqual([...PASTAS_DA_BARRA], ['A Sofia passou para mim', 'Quentes', 'Confirmar e remarcar', 'Resgatar', 'Conferir']);
  const nomesNoCrm = ['🙋 A Sofia passou para mim', '🔥 Quentes', '📅 Confirmar e remarcar', '🔁 Resgatar', '⚠️ Conferir'];
  assert.deepEqual(nomesNoCrm.map(chavePasta), PASTAS_DA_BARRA.map(chavePasta), 'o nome com emoji vira a mesma chave');
  assert.equal(chavePasta('⚠️ CONFERIR'), 'conferir');
  assert.equal(chavePasta('Não atribuídas (3)'), 'nao atribuidas');
  const js = barraPorPapelJs(LIGADA);
  assert.ok(js.includes('["a sofia passou para mim","quentes","confirmar e remarcar","resgatar","conferir"]'), 'o navegador recebe as chaves já normalizadas');
  // a função do navegador e a do servidor normalizam do mesmo jeito (o teste roda a do navegador de verdade)
  const chaveNavegador = new Function(`${js.match(/function chave\(t\)\{[^\n]*\}/)![0]}; return chave;`)() as (t: string) => string;
  for (const n of [...nomesNoCrm, 'Não atribuídas (3)', 'Todos', 'Minhas (12)']) assert.equal(chaveNavegador(n), chavePasta(n), n);
});

test('o freio da barra: a primeira mudança depois de uma pausa passa já (sem esperar 400 ms), e a rajada segue contada a cada 400 ms', () => {
  const js = barraPorPapelJs(LIGADA);
  assert.match(js, /espera = null; ultima = Date\.now\(\);/, 'a passada marca a hora em que rodou');
  assert.match(js, /setTimeout\(passar, Math\.max\(0, 400 - \(Date\.now\(\) - ultima\)\)\)/);
  assert.doesNotMatch(js, /setTimeout\(passar, 400\)/, 'nada de espera fixa de 400 ms');
});
