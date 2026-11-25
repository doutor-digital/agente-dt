/**
 * «Cartão enxuto por etapa» no CRM (Chatwoot) — pedido do João, 25/11/2026, contra a maior reclamação da Kommo: «campo demais». Na conversa, o painel «Informação da conversa» (a lista de atributos)
 * mostra TODOS os atributos (Timbó tem 38). Este bloco mostra só os campos DAQUELA etapa e recolhe o resto em «Mostrar todos os campos (N)». É o molde de 06/11 da Kommo
 * (cabeçalho por etapa, cada etapa só o seu, sem obrigatório antes de GANHO), agora no CRM.
 *
 * Regras:
 *  - os campos de cada etapa vêm do MAPA abaixo (`CARTAO_PADRAO`), que se muda SEM deploy com `CHATWOOT_CARTAO_ETAPAS` (JSON; ver `mapaDoCartao`);
 *  - CAMPO PREENCHIDO NUNCA SOME: o que tem valor aparece mesmo fora da etapa (só o vazio fica recolhido); os campos «sempre» (etapa, funil…) também;
 *  - a etapa vem do próprio atributo `etapa` da conversa (e, no funil do Tratamento, de `etapa_tratamento`), lido do estado (store) do Chatwoot; o nome casa sem diferenciar
 *    maiúscula nem acento; etapa que o mapa NÃO conhece (nome novo, grafia diferente) = nada é recolhido;
 *  - «Pagamento antecipado» só entra na etapa Agendado/Confirmado das contas que aceitam antecipado (`CHATWOOT_CARTAO_SEM_ANTECIPADO` = contas que NÃO aceitam; Timbó = 3);
 *  - nada é escondido de um jeito que quebre a edição: o script NÃO apaga nem move nada do Vue; só põe um atributo (`data-dd-cartao="oculto"`) na linha do campo e o CSS a esconde;
 *    «Mostrar todos os campos» tira o atributo. O botão é o único nó novo, posto ANTES da lista (nunca entre as linhas que o Vue controla) e recolocado se o Vue refizer o painel.
 *    Se o script não achar o painel ou as linhas (o Chatwoot mudou), não faz nada: o painel fica como o Chatwoot o entrega.
 *
 * Como acha as linhas (sem depender de nome de classe do Chatwoot): o título do acordeão «Informação da conversa» e, dentro dele, os rótulos que têm EXATAMENTE o nome de exibição de cada
 * atributo (as definições vêm do estado do Chatwoot); a linha de cada campo é o filho da lista que contém o rótulo (o ancestral comum de todos os rótulos é a lista).
 *
 * Chave: `CHATWOOT_CARTAO_ENXUTO=0` tira o bloco do `menu.js` (vale em até 5 min, o cache do navegador). Padrão: ligado.
 * Bloco INDEPENDENTE dentro do `menu.js` (`;try{ … }catch(e){}`): se falhar ao executar, o menu, a assistente, o guia e o selo seguem.
 */

export const cartaoEnxutoLigado = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.CHATWOOT_CARTAO_ENXUTO ?? '').trim() !== '0';

export interface MapaDoCartao {
  /** campos visíveis em toda etapa */
  sempre: string[];
  /** etapa do funil comercial → campos */
  etapas: Record<string, string[]>;
  /** funil do Tratamento: campos da etapa_tratamento (o resto do funil usa `etapas`) */
  tratamento: string[];
  /** campos a mais quando a etapa do Tratamento é «Alta» */
  alta: string[];
  /** contas que NÃO aceitam pagamento antecipado: lá `pagamento_antecipado` sai de Agendado/Confirmado */
  semAntecipado: number[];
}

const QUALIFICAR = ['qualificacao', 'queixa', 'regiao_dor', 'regiao_da_dor', 'observacoes', 'tipo_de_lead'];
const AGENDADO = ['data_consulta', 'hora_consulta', 'situacao_consulta', 'categoria_consulta', 'pagamento_antecipado', 'quem_agendou', 'valor_consulta', 'tipo_agendamento'];
const FECHOU = ['fechou_tratamento', 'tratamento_indicado', 'valor_tratamento', 'forma_pagamento', 'tipo_fechamento', 'programa'];

/** O mapa de fábrica. Chaves = `attribute_key` do Chatwoot; chave que a conta não tem é ignorada (não quebra nada). */
export const CARTAO_PADRAO: MapaDoCartao = {
  sempre: ['etapa', 'etapa_tratamento', 'funil'],
  etapas: {
    'Novo lead': QUALIFICAR,
    'Sofia qualifica': QUALIFICAR,
    'Esperando humano': [...QUALIFICAR, 'motivo_espera', 'retomar_em'],
    Agendado: AGENDADO,
    Confirmado: AGENDADO,
    Compareceu: ['compareceu', 'situacao_consulta', 'tratamento_indicado', 'fisioterapeuta', 'motivo_nao_fechamento'],
    Fechou: FECHOU,
    'Pós-consulta': FECHOU,
    Resgate: ['motivo_nao_agendamento', 'motivo_nao_fechamento', 'retomar_em'],
    // os papéis que só as contas com etapas próprias têm (chatwoot-etapas.ts): a chave é o PAPEL, o nome na tela é o da conta
    'Em espera': [...QUALIFICAR, 'motivo_espera', 'retomar_em'],
    'Conferir na franquia': AGENDADO,
    Faltou: AGENDADO,
    'Retorno pós-tratamento': AGENDADO,
    Frio: ['motivo_nao_agendamento', 'retomar_em'],
    Perdido: ['motivo_nao_agendamento', 'motivo_nao_fechamento'],
  },
  tratamento: ['proxima_sessao', 'hora_sessao', 'compareceu_ultima_sessao', 'programa', 'valor_parcela', 'vencimento'],
  alta: ['data_alta', 'data_retorno', 'deixou_avaliacao_google'],
  semAntecipado: [],
};

const CHAVE_OK = /^[a-z0-9_]{1,60}$/;
const limpaLista = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && CHAVE_OK.test(x)))] : []);

/**
 * O mapa que vai para o navegador: o de fábrica, sobreposto por `CHATWOOT_CARTAO_ETAPAS` (JSON) — troca o que vier e deixa o resto:
 * `{"sempre":[…], "etapas":{"Agendado":[…]}, "tratamento":[…], "alta":[…]}`. Etapa NOVA entra (nome livre, até 40 letras); lista vazia `[]` zera os campos da etapa.
 * JSON inválido ou chave fora do formato `[a-z0-9_]` é ignorado (nunca derruba o menu). As contas SEM antecipado vêm do BANCO (`contasSemAntecipado`, a mesma lista que o guia «O que fazer
 * agora» recebe em `montarMenuJs`: `units.accepts_advance_payment`) e, somada a ela, `CHATWOOT_CARTAO_SEM_ANTECIPADO` (contas separadas por vírgula; só reforça, nunca tira).
 */
export function mapaDoCartao(env: NodeJS.ProcessEnv = process.env, contasSemAntecipado: readonly number[] = []): MapaDoCartao {
  const m: MapaDoCartao = { sempre: [...CARTAO_PADRAO.sempre], etapas: Object.fromEntries(Object.entries(CARTAO_PADRAO.etapas).map(([k, v]) => [k, [...v]])), tratamento: [...CARTAO_PADRAO.tratamento], alta: [...CARTAO_PADRAO.alta], semAntecipado: [] };
  try {
    const j = JSON.parse(String(env.CHATWOOT_CARTAO_ETAPAS ?? 'null')) as Partial<Record<keyof MapaDoCartao, unknown>> | null;
    if (j && typeof j === 'object') {
      if (Array.isArray(j.sempre)) m.sempre = limpaLista(j.sempre);
      if (Array.isArray(j.tratamento)) m.tratamento = limpaLista(j.tratamento);
      if (Array.isArray(j.alta)) m.alta = limpaLista(j.alta);
      if (j.etapas && typeof j.etapas === 'object' && !Array.isArray(j.etapas))
        for (const [nome, lista] of Object.entries(j.etapas as Record<string, unknown>)) if (nome.length > 0 && nome.length <= 40 && !['__proto__', 'constructor', 'prototype'].includes(nome) && Array.isArray(lista)) m.etapas[nome] = limpaLista(lista);
    }
  } catch {
    /* JSON ruim: fica o mapa de fábrica */
  }
  const daEnv = String(env.CHATWOOT_CARTAO_SEM_ANTECIPADO ?? '').split(',').map((x) => Number(x.trim()));
  m.semAntecipado = [...new Set([...contasSemAntecipado, ...daEnv].filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return m;
}

// String.raw: o que está aqui é o JavaScript que o navegador recebe. Sem crases nem «${» aqui dentro.
const CARTAO_JS = String.raw`(function(){
  if (window.top !== window || window.__cartaoEnxutoDD) return; window.__cartaoEnxutoDD = 1;
  var MAPA = __MAPA__, ATTR = 'data-dd-cartao', TOGGLE = 'data-dd-cartao-toggle', ESTILO = 'data-dd-cartao-estilo';
  var espera = null, todos = { conversa: null, ligado: false }, botao = null, cache = null, abriu = false;

  function conversaDaUrl(){ var m = String(location.pathname).match(/\/conversations\/(\d+)/); return m ? Number(m[1]) : null; }
  function contaDaUrl(){ var m = String(location.pathname).match(/\/accounts\/(\d+)/); return m ? Number(m[1]) : null; }
  function norm(t){ return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

  function css(){
    return '[' + ATTR + '="oculto"]{display:none!important}'
      + '[' + TOGGLE + ']{margin:6px 0 8px}'
      + '[' + TOGGLE + '] button{cursor:pointer;border:1px solid #cdd2e3;background:#f3f4f8;color:#2437a0;border-radius:8px;min-height:28px;padding:0 10px;font:600 12px/1 Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif}'
      + '[' + TOGGLE + '] button:hover{background:#e8eaf3}'
      + '.dark [' + TOGGLE + '] button{border-color:#43484e;background:#212225;color:#9eb1ff}.dark [' + TOGGLE + '] button:hover{background:#2e3135}'
      + '@media (max-width:560px){[' + TOGGLE + '] button{min-height:44px;padding:0 14px;font-size:13px}}';
  }
  function garantirEstilo(){
    if (document.querySelector('style[' + ESTILO + ']')) return;
    var st = document.createElement('style'); st.setAttribute(ESTILO, '1'); st.textContent = css();
    (document.head || document.documentElement).appendChild(st);
  }

  // ── o estado do Chatwoot: a conversa aberta e as definições dos atributos (chave → nome de exibição) ─────────────────────────────
  function loja(){
    try { var app = document.getElementById('app'); var vue = app && app.__vue_app__; return vue && vue.config && vue.config.globalProperties && vue.config.globalProperties.$store; } catch (e) { return null; }
  }
  function conversa(id){
    try { var s = loja(), chat = s && s.getters && s.getters.getSelectedChat; return chat && Number(chat.id) === id ? chat : null; } catch (e) { return null; }
  }
  function definicoes(){
    try {
      var s = loja(), lista = null;
      if (s && s.getters && typeof s.getters['attributes/getAttributesByModel'] === 'function') lista = s.getters['attributes/getAttributesByModel']('conversation_attribute');
      else if (s && s.state && s.state.attributes && Array.isArray(s.state.attributes.records)) lista = s.state.attributes.records.filter(function(a){ return a.attribute_model === 'conversation_attribute' || a.attribute_model === 0; });
      return Array.isArray(lista) ? lista : null;
    } catch (e) { return null; }
  }
  // «preenchido»: tem valor (o 0 e o false de uma caixa desmarcada são valores); vazio = nada, texto vazio ou lista vazia
  function preenchido(v){ return !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)); }

  // ── quais campos aparecem nesta etapa ─────────────────────────────────────────────────────────────────────────────────────────
  function semAcento(t){ return norm(t).normalize ? norm(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '') : norm(t); }
  // devolve os campos visíveis da etapa, ou null quando a etapa NÃO é conhecida (nome novo, grafia diferente): aí nada é recolhido — o painel fica como o Chatwoot o entrega
  function camposDaEtapa(attrs, conta, chat){
    var vis = {}; function pôr(l){ (l || []).forEach(function(k){ vis[k] = 1; }); }
    pôr(MAPA.sempre);
    // o FUNIL decide primeiro: «Comercial» é lead (mesmo com um etapa_tratamento antigo de quando já foi paciente); só sem funil o etapa_tratamento preenchido indica tratamento
    var funil = norm(attrs.funil), tratamento = funil === 'tratamento' || (funil !== 'comercial' && preenchido(attrs.etapa_tratamento));
    // o nome que a conta dá à etapa vira PAPEL (as chaves do mapa são papéis); conta sem mapa: o nome como está
    var E = window.__ddEtapas, tem = E && E.mapa(conta);
    var papelC = tem ? E.papel(conta, String(attrs.etapa || '')) : attrs.etapa;
    var papelT = tem ? E.papelT(conta, String(attrs.etapa_tratamento || '')) : attrs.etapa_tratamento;
    // «Esperando humano» não tem coluna na conta com etapas próprias: é a qualificação com a etiqueta esperando-humano
    if (tem && papelC === 'Sofia qualifica' && !E.tem(conta, 'Esperando humano') && chat && Array.isArray(chat.labels) && chat.labels.indexOf('esperando-humano') >= 0) papelC = 'Esperando humano';
    if (tratamento) { pôr(MAPA.tratamento); if (/alta/.test(norm(papelT))) pôr(MAPA.alta); }
    else {
      var e = semAcento(papelC || 'Novo lead'), lista = null;
      Object.keys(MAPA.etapas).forEach(function(nome){ if (semAcento(nome) === e) lista = MAPA.etapas[nome]; });
      if (!lista) return null;
      pôr(lista);
    }
    if (MAPA.semAntecipado.indexOf(conta) >= 0) delete vis.pagamento_antecipado;
    return vis;
  }

  // ── o painel «Informação da conversa» no DOM: título → rótulos → linhas (filhos da lista) ──────────────────────────────────────
  // o título: só os elementos que podem ser título (cabeçalho, botão do acordeão), NÃO a página inteira (era uma varredura de até 8000 nós a cada passada)
  var TITULO = /^(informacao da conversa|informacoes da conversa|atributos da conversa|conversation information|conversation attributes)$/;
  function acharTitulo(){
    var cand = document.querySelectorAll ? document.querySelectorAll('h1,h2,h3,h4,h5,h6,button,[role="heading"]') : [];
    for (var i = 0; i < cand.length; i++) if (TITULO.test(semAcento(textoProprio(cand[i])))) return cand[i];
    return null;
  }
  // o texto do próprio elemento, sem o dos filhos (o rótulo de um atributo com descrição leva um ícone de ajuda dentro do mesmo span)
  function textoProprio(x){
    var t = String(x.textContent || ''), kids = x.children || [];
    for (var i = 0; i < kids.length; i++) { var k = String(kids[i].textContent || ''); if (k) t = t.replace(k, ''); }
    return t;
  }
  // há, dentro do nó, outro elemento do mesmo tipo do título (outro acordeão da barra lateral)? Para no primeiro que achar (varredura limitada)
  function temOutroDoMesmoTipo(no, titulo, tipo){
    var fila = [no], visto = 0;
    while (fila.length && visto < 3000) {
      var x = fila.pop(); visto++;
      if (x !== titulo && String(x.tagName || x.tag || '').toLowerCase() === tipo) return true;
      var kids = x.children || []; for (var i = 0; i < kids.length; i++) fila.push(kids[i]);
    }
    return false;
  }
  function folhasDe(no, limite){
    var out = [], fila = [no], n = 0;
    while (fila.length && n < limite) { var x = fila.pop(); n++; var kids = x.children || []; if (kids.length === 0 || (kids.length <= 2 && norm(textoProprio(x)))) out.push(x); if (kids.length) for (var i = kids.length - 1; i >= 0; i--) fila.push(kids[i]); }
    return out;
  }
  function ancestrais(no){ var l = []; for (var p = no; p; p = p.parentNode) l.push(p); return l; }
  function achar(defs){
    var titulo = acharTitulo(); if (!titulo) return null;
    var nomes = {}, repetidos = {};
    defs.forEach(function(d){ if (!d || !d.attribute_key) return; var n = norm(d.attribute_display_name || d.attribute_key); if (Object.prototype.hasOwnProperty.call(nomes, n)) repetidos[n] = 1; else nomes[n] = d.attribute_key; });
    Object.keys(repetidos).forEach(function(n){ delete nomes[n]; }); // dois atributos com o mesmo nome de exibição: ambíguo, ficam como o Chatwoot os entrega
    // o painel é SÓ o acordeão do título. Sobe a partir do título até o PRIMEIRO ancestral que tem rótulos de atributo (≥ 2) e NUNCA passa do acordeão: para antes de um ancestral que
    // contém OUTRO título do mesmo tipo (a barra lateral tem vários acordeões — «Atributos do contato» tem nomes iguais aos da conversa — e o script os tomaria pela conversa).
    // Com «Informação da conversa» RECOLHIDO o corpo não existe: o primeiro ancestral permitido não tem rótulos, e o script desiste
    var tipoDoTitulo = String(titulo.tagName || titulo.tag || '').toLowerCase(), painel = titulo, rotulos = [];
    function rotulosDe(no){ return folhasDe(no, 3000).filter(function(f){ return f !== titulo && Object.prototype.hasOwnProperty.call(nomes, norm(textoProprio(f))); }); }
    for (var nivel = 0; nivel < 8; nivel++) {
      rotulos = rotulosDe(painel);
      if (rotulos.length >= 2) break;
      var acima = painel.parentNode;
      if (!acima || temOutroDoMesmoTipo(acima, titulo, tipoDoTitulo)) break;
      painel = acima;
    }
    if (painel === titulo || rotulos.length < 2) return null;
    // a lista é o ancestral comum de TODOS os textos que casam; a linha é cada filho dela, e o rótulo da linha é o PRIMEIRO texto dela (o valor vem depois do rótulo: um valor
    // igual ao nome de outro campo nunca é tomado por rótulo)
    var comum = null, subindo = ancestrais(rotulos[0]);
    for (var ia = 0; ia < subindo.length && !comum; ia++) { // do mais baixo para cima, PARA no primeiro que contém todos (não varre até o <body>)
      var cand = subindo[ia];
      if (rotulos.every(function(f){ return cand.contains ? cand.contains(f) : ancestrais(f).indexOf(cand) >= 0; })) comum = cand;
    }
    if (!comum) return null;
    var linhas = {}, achou = 0, filhos = comum.children || [];
    for (var j = 0; j < filhos.length; j++) {
      var rot = primeiroTexto(filhos[j]); if (!rot) continue;
      var k = nomes[norm(textoProprio(rot))];
      if (k && !linhas[k]) { linhas[k] = filhos[j]; achou++; }
    }
    if (achou < 2) return null;
    return { lista: comum, linhas: linhas, n: filhos.length };
  }
  function primeiroTexto(no){
    if (norm(textoProprio(no))) return no;
    var kids = no.children || [];
    for (var i = 0; i < kids.length; i++) { var r = primeiroTexto(kids[i]); if (r) return r; }
    return null;
  }

  // a lista e as linhas já achadas continuam valendo enquanto estiverem no documento (o Vue refaz o painel → acha de novo); evita varrer a página a cada rajada
  // ── o «Mostrar todos os atributos» NATIVO do Chatwoot (4.19): sem ele aberto, só as 5 primeiras linhas existem na tela e o mapa por etapa não teria o que recolher.
  //    O script o abre UMA vez por carga da página (é o mesmo clique do usuário; o Chatwoot guarda a preferência dele) e, com ele ABERTO, esconde o botão nativo porque o nosso manda; recolhido, ele fica visível.
  function traduzido(chave){
    try { var app = document.getElementById('app'), g = app && app.__vue_app__ && app.__vue_app__.config.globalProperties; return g && typeof g.$t === 'function' ? norm(g.$t(chave)) : ''; } catch (e) { return ''; }
  }
  function botoesDe(no){
    var out = [], fila = [no], n = 0;
    while (fila.length && n < 400) { var x = fila.shift(); n++; if (String(x.tagName || x.tag || '').toLowerCase() === 'button') out.push(x); var kids = x.children || []; for (var i = 0; i < kids.length; i++) fila.push(kids[i]); }
    return out;
  }
  function botaoNativo(lista){
    var mais = traduzido('CUSTOM_ATTRIBUTES.SHOW_MORE'), menos = traduzido('CUSTOM_ATTRIBUTES.SHOW_LESS');
    if (!mais && !menos) return null;
    var irmaos = (lista.parentNode && lista.parentNode.children) || [];
    for (var i = 0; i < irmaos.length; i++) {
      if (irmaos[i] === lista || irmaos[i] === botao) continue;
      var bs = botoesDe(irmaos[i]);
      for (var j = 0; j < bs.length; j++) { var t = norm(bs[j].textContent); if (t && (t === mais || t === menos)) return { caixa: irmaos[i], botao: bs[j], recolhido: t === mais }; }
    }
    return null;
  }
  function abrirNativo(lista){
    var n = botaoNativo(lista); if (!n) return;
    if (n.recolhido) {
      // recolhido: o botão nativo é o ÚNICO caminho para as linhas 6+ — fica visível (mesmo se o clique falhar); o script tenta abrir UMA vez por carga
      if (n.caixa.getAttribute(ATTR)) n.caixa.removeAttribute(ATTR);
      if (!abriu) { abriu = true; if (typeof n.botao.click === 'function') n.botao.click(); else if (n.botao.onclick) n.botao.onclick(); }
    } else if (n.caixa.getAttribute(ATTR) !== 'oculto') n.caixa.setAttribute(ATTR, 'oculto'); // aberto: o nosso botão manda, o nativo some
  }

  function noDocumento(n){ for (var p = n, i = 0; p && i < 200; p = p.parentNode, i++) if (p === document.body || p === document.documentElement) return true; return false; }
  function cacheValido(c){ if (!c || !noDocumento(c.lista) || (c.lista.children || []).length !== c.n) return false; var ks = Object.keys(c.linhas); for (var i = 0; i < ks.length; i++) if (!noDocumento(c.linhas[ks[i]])) return false; return true; }

  // ── o botão «Mostrar todos os campos (N)»: único nó novo, ANTES da lista (nunca entre as linhas que o Vue controla) ───────────
  function tirarBotao(){ if (botao && botao.parentNode) botao.parentNode.removeChild(botao); botao = null; }
  function botaoDe(lista, ocultos, id){
    if (!ocultos && !todos.ligado) { tirarBotao(); return; }
    var texto = todos.ligado ? 'Mostrar só os campos da etapa' : 'Mostrar todos os campos (' + ocultos + ')';
    if (!botao) {
      botao = document.createElement('div'); botao.setAttribute(TOGGLE, '1');
      var b = document.createElement('button'); b.type = 'button';
      b.onclick = function(){ todos.ligado = !todos.ligado; agendarJa(); }; // quem decide a conversa é o passar() (o botão é reaproveitado entre conversas)
      botao.appendChild(b);
    }
    if (botao.children[0].textContent !== texto) botao.children[0].textContent = texto;
    if (lista.parentNode && (botao.parentNode !== lista.parentNode || botao.nextSibling !== lista)) lista.parentNode.insertBefore(botao, lista);
  }

  function limpar(){ cache = null; var os = document.querySelectorAll('[' + ATTR + ']'); for (var i = 0; i < os.length; i++) os[i].removeAttribute(ATTR); tirarBotao(); }

  function passar(){
    espera = null;
    var id = /\/app\/accounts\//.test(location.pathname) ? conversaDaUrl() : null;
    var chat = id ? conversa(id) : null, defs = chat ? definicoes() : null;
    if (!id || !chat || !defs) { limpar(); return; }
    if (todos.conversa !== id) { todos.conversa = id; todos.ligado = false; } // outra conversa: volta a recolher
    var achados = cache && cacheValido(cache) ? cache : achar(defs);
    cache = achados;
    if (!achados) { limpar(); return; }
    garantirEstilo();
    var attrs = chat.custom_attributes && typeof chat.custom_attributes === 'object' ? chat.custom_attributes : {};
    var vis = camposDaEtapa(attrs, contaDaUrl(), chat);
    if (!vis) { limpar(); return; } // etapa desconhecida: nada recolhido
    abrirNativo(achados.lista);
    Object.keys(achados.linhas).forEach(function(k){
      var linha = achados.linhas[k], esconder = !todos.ligado && !vis[k] && !preenchido(attrs[k]); // preenchido NUNCA some
      if (esconder) { if (linha.getAttribute(ATTR) !== 'oculto') linha.setAttribute(ATTR, 'oculto'); }
      else if (linha.getAttribute(ATTR)) linha.removeAttribute(ATTR);
    });
    // o contador do botão conta o que ficaria recolhido (mesmo com tudo aberto)
    var recolhiveis = 0; Object.keys(achados.linhas).forEach(function(k){ if (!vis[k] && !preenchido(attrs[k])) recolhiveis++; });
    botaoDe(achados.lista, recolhiveis, id);
  }
  function agendarJa(){ if (espera) clearTimeout(espera); espera = setTimeout(passar, 0); }
  // freio: no máximo uma passada a cada 400 ms, por mais que o Chatwoot mexa na tela (o Vue mexe muito)
  function agendar(){ if (!espera) espera = setTimeout(passar, 400); }
  // characterData: um campo preenchido pelo servidor com a conversa aberta só troca o TEXTO do valor — sem isso a linha ficaria oculta até a próxima mudança de nó
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('visibilitychange', agendar);
  agendar();
})();`;

/** O JavaScript do cartão enxuto, pronto para ir no `menu.js`; vazio quando `CHATWOOT_CARTAO_ENXUTO=0`. */
export function cartaoEnxutoJs(env: NodeJS.ProcessEnv = process.env, contasSemAntecipado: readonly number[] = []): string {
  if (!cartaoEnxutoLigado(env)) return '';
  return CARTAO_JS.split('__MAPA__').join(JSON.stringify(mapaDoCartao(env, contasSemAntecipado)).replace(/</g, '\\u003c'));
}
