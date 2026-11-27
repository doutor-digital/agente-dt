/**
 * «Barra lateral por papel» no CRM (Chatwoot 4.19.1) — proposta da Suzanne, passo 6 (26/11/2026).
 *
 * O que muda (só VISUAL; este script nunca grava nada no Chatwoot e nada aqui é permissão — a URL de qualquer tela continua abrindo):
 *  - Para TODOS (administrador e atendente): «☀️ Hoje» (a tela do plano do dia que o `menu.js` já cria) sobe para o TOPO da barra, com o submenu dele.
 *  - Para a ATENDENTE (papel `agent` do Chatwoot): a barra fica enxuta —
 *      Hoje · Conversas (Minhas / Sem dono / Todas + as 5 pastas, na ordem) · Ferramentas (Tarefas, Contatos, «Sofia (ensinar e testar)»).
 *      Somem: Relatórios, Campanhas, Configurações, Central de Ajuda, Empresas, Captain, equipes vazias, e as telas de gestão do menu
 *      (Funil, Oportunidades, Robôs, Disparos). Esconder é só `display:none` (atributo `data-dd-oculto`): o endereço da tela segue valendo.
 *  - Contador VERMELHO na pasta «🙋 A Sofia passou para mim»: conversas ABERTAS com a etiqueta `esperando-humano` ou `ia-pausada`.
 *    Conta pela API do próprio Chatwoot com a sessão de quem está logado (`POST conversations/filter`, lê `meta.all_count`) usando o filtro SALVO NA
 *    PRÓPRIA PASTA (lido do estado do Chatwoot, zero requisição) — assim o número é o que a lista dela mostra; sem esse estado vale a consulta da
 *    proposta (abertas com as duas etiquetas). UMA chamada a cada 60 s por aba aberta (e uma ao trocar de tela, no máximo a cada 15 s); aba escondida
 *    não chama; 15 s sem resposta desiste; sem resposta, o número some (nunca inventa); trocou de conta, zera.
 *    O número é um `::after` do link da pasta (atributo `data-dd-conta`): o script não cria nó dentro do que o Vue mantém.
 *
 * Chave: `CHATWOOT_BARRA_POR_PAPEL=1` liga. Desligada (padrão) o bloco NÃO ENTRA no `menu.js`: o arquivo sai BYTE A BYTE igual ao de antes (o teste compara o SHA-256 com o de main).
 * Bloco INDEPENDENTE dentro do `menu.js` (`;try{ … }catch(e){}`): se falhar ao executar, o menu, a assistente, o guia e o selo seguem.
 * Papel desconhecido (store sem resposta e perfil sem resposta): nada some (falha aberta).
 */

/** Etiquetas que o contador soma (iguais a ETIQUETA_HUMANO de chatwoot-sofia.ts e ETIQUETA_PAUSA de chatwoot-pausa.ts; um teste confere). */
export const ETIQUETAS_DO_CONTADOR = ['esperando-humano', 'ia-pausada'] as const;

/** As 5 pastas de cada atendente, na ordem da proposta (o 1º é o que leva o contador). Comparadas sem acento, sem emoji e sem caixa. */
export const PASTAS_DA_BARRA = ['A Sofia passou para mim', 'Quentes', 'Confirmar e remarcar', 'Resgatar', 'Conferir'] as const;

export const barraPorPapelLigada = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.CHATWOOT_BARRA_POR_PAPEL ?? '').trim() === '1';

// String.raw: o que está aqui é o JavaScript que o navegador recebe. Sem crases nem «${» aqui dentro.
const BARRA_JS = String.raw`(function(){
  if (window.top !== window || window.__barraPapelDD) return; window.__barraPapelDD = 1;
  var PASTAS = __PASTAS__, ETIQUETAS = __ETIQUETAS__;
  var OCULTO = 'data-dd-oculto', CONTA = 'data-dd-conta', ESTILO = 'data-dd-barra-estilo', PASTA_COL = 'data-dd-pastas';
  // grupos do topo escondidos da atendente, pelo ícone do cabeçalho (não muda com o idioma): Captain, Empresas, Relatórios, Campanhas, Central de Ajuda, Configurações
  var ICONES_FORA = ['i-woot-captain', 'i-lucide-building-2', 'i-lucide-chart-spline', 'i-lucide-megaphone', 'i-lucide-library-big', 'i-lucide-bolt'];
  // telas de gestão do menu.js que não estão na barra da atendente
  var TELAS_FORA = ['data-oport-menu', 'data-funil-menu', 'data-robos-menu', 'data-disparos-menu'];
  var HOJE_FILA = ['data-hoje-menu', 'data-oport-menu', 'data-mkt-menu', 'data-gestor-menu'];
  var ABAS = [
    { id: 'me', nome: 'Minhas', re: /^(minhas|mine)/ },
    { id: 'sem', nome: 'Sem dono', re: /^(nao atribu|unassigned)/ },
    { id: 'todas', nome: 'Todas', re: /^(todos?|all)( |$)/ }
  ];
  var espera = null, perfil = { conta: null, papel: null, pedindo: false, falhou: 0 };
  var cont = { n: null, ultima: 0, preso: false, caminho: '', conta: null };

  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  function contaDaUrl(){ var m = location.pathname.match(/\/accounts\/(\d+)/); return m ? m[1] : null; }
  // sem acento, sem emoji, sem caixa: «🙋 A Sofia passou para mim» → «a sofia passou para mim»
  function chave(t){ return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }

  // ── o papel: do estado do próprio Chatwoot (zero requisição) ou, se ele não responder, do perfil (uma vez por conta) ─────────────
  function papelDoEstado(){
    try {
      var app = document.getElementById('app'); var vue = app && app.__vue_app__;
      var store = vue && vue.config && vue.config.globalProperties && vue.config.globalProperties.$store;
      var r = store && store.getters && store.getters.getCurrentRole;
      return typeof r === 'string' && r ? r : null;
    } catch (e) { return null; }
  }
  function papelAtual(){
    var conta = contaDaUrl(); if (!conta) return null;
    var r = papelDoEstado(); if (r) return r;
    if (perfil.conta !== conta) { perfil.conta = conta; perfil.papel = null; perfil.pedindo = false; perfil.falhou = 0; }
    if (perfil.papel) return perfil.papel;
    // o perfil falhou: espera 60 s antes de tentar de novo (nada de martelar o Chatwoot a cada passada)
    var s = sessao(); if (!s || perfil.pedindo || Date.now() - perfil.falhou < 60000) return null;
    perfil.pedindo = true;
    fetch('/api/v1/profile', { headers: { 'access-token': s.token, client: s.client, uid: s.uid } })
      .then(function(x){ return x.ok ? x.json() : null; })
      .then(function(p){
        var a = p && Array.isArray(p.accounts) ? p.accounts.filter(function(y){ return String(y.id) === conta; })[0] : null;
        if (a && a.role && perfil.conta === conta) perfil.papel = a.role;
      })
      .catch(function(){})
      .then(function(){ perfil.pedindo = false; if (perfil.papel) agendar(); else perfil.falhou = Date.now(); });
    return null;
  }

  // ── o CSS (um só, no <head>): esconder, contador vermelho, pastas em coluna (para a ordem valer) ────────────────────────────────
  function css(){
    return '[' + OCULTO + ']{display:none!important}'
      + '[' + PASTA_COL + ']{display:flex;flex-direction:column}'
      + 'a[' + CONTA + ']::after{content:attr(' + CONTA + ');flex-shrink:0;margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:10px;'
      + 'background:#DC2626;color:#fff;font:700 12px/20px Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;text-align:center;box-sizing:border-box}'
      + '[data-dd-ferramentas]{list-style:none;padding:10px 8px 2px;font:600 11px/16px Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;'
      + 'text-transform:uppercase;letter-spacing:.04em;opacity:.6;pointer-events:none;user-select:none}';
  }
  function garantirEstilo(){
    if (document.querySelector('style[' + ESTILO + ']')) return;
    var st = document.createElement('style'); st.setAttribute(ESTILO, '1'); st.textContent = css();
    (document.head || document.documentElement).appendChild(st);
  }
  function esconder(el, sim){
    if (!el) return;
    if (sim) { if (el.getAttribute(OCULTO) !== '1') el.setAttribute(OCULTO, '1'); }
    else if (el.hasAttribute(OCULTO)) el.removeAttribute(OCULTO);
  }
  function ordem(el, n){ if (el && el.style.order !== String(n)) el.style.order = String(n); }
  function trocarTexto(no, texto){
    var w = document.createTreeWalker(no, NodeFilter.SHOW_TEXT), t;
    while ((t = w.nextNode())) { if (t.nodeValue.trim()) { if (t.nodeValue.trim() !== texto) t.nodeValue = texto; return; } }
  }

  // ── a barra ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function grupoPorIcone(ul, icone){
    var lis = ul.children;
    for (var i = 0; i < lis.length; i++) { if (lis[i].querySelector('.' + icone)) return lis[i]; }
    return null;
  }
  function item(marca){ return document.querySelector('aside nav [' + marca + ']'); }

  // Hoje no topo, com o submenu dele logo depois (todos os papéis)
  function hojeNoTopo(){
    HOJE_FILA.forEach(function(m, i){ ordem(item(m), -50 + i); });
    var hoje = item('data-hoje-menu'); if (hoje) trocarTexto(hoje, '☀️ Hoje');
  }

  // o link de uma FOLHA do grupo, a original do Chatwoot: nem o cabeçalho (o de «Conversas» também aponta para /dashboard, o endereço do 1º filho) nem as nossas abas copiadas dela
  function folha(g, sufixo){
    var ls = g.querySelectorAll('a[href$="' + sufixo + '"]');
    for (var i = 0; i < ls.length; i++) { var li = ls[i].closest('li'); if (li && li !== g && !li.hasAttribute('data-dd-aba')) return ls[i]; }
    return null;
  }
  function aba(li, a){
    var c = li.cloneNode(true);
    c.removeAttribute(OCULTO); c.setAttribute('data-dd-aba', a.id);
    var link = c.tagName === 'A' ? c : c.querySelector('a');
    if (link) {
      ['text-n-slate-12', 'bg-n-alpha-2', 'font-medium', 'active', 'router-link-active', 'router-link-exact-active'].forEach(function(k){ link.classList.remove(k); });
      link.removeAttribute('aria-current');
      var rot = link.querySelector('.truncate');
      if (rot) { rot.textContent = a.nome; while (rot.nextElementSibling) rot.nextElementSibling.remove(); } else trocarTexto(link, a.nome);
      link.setAttribute('title', a.nome);
    }
    c.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); abrirAba(a); }, true);
    return c;
  }
  // as abas «Minhas / Não atribuídas / Todos» são do próprio Chatwoot (ficam no alto da lista, sem endereço): vai para a lista e clica nela
  function abrirAba(a){
    var raiz = document.querySelector('aside nav > ul'), g = raiz && grupoPorIcone(raiz, 'i-lucide-message-circle'), todas = g && folha(g, '/dashboard');
    if (todas && !/\/dashboard\/?$/.test(location.pathname)) todas.click();
    var tentativas = 0;
    (function tentar(){
      var ls = document.querySelectorAll('li > a'), alvo = null;
      for (var i = 0; i < ls.length; i++) { if (!ls[i].closest('aside') && a.re.test(chave(ls[i].textContent))) { alvo = ls[i]; break; } }
      if (alvo) { alvo.click(); return; }
      if (++tentativas < 15) setTimeout(tentar, 200);
    })();
  }

  function pastaDaBarra(a){ var k = chave(a.getAttribute('title') || a.textContent); return PASTAS.indexOf(k); }
  function enxugarConversas(g){
    // Mencionadas, Participando, Não atendidas: fora (Minhas / Sem dono / Todas entram no lugar de «Todas as conversas»)
    ['/mentions/conversations', '/participating/conversations', '/unattended/conversations'].forEach(function(f){
      var a = folha(g, f); esconder(a && a.closest('li'), true);
    });
    var todas = folha(g, '/dashboard'), li = todas && todas.closest('li');
    if (li && li.parentNode) {
      esconder(li, true);
      if (!li.parentNode.querySelector('[data-dd-aba]')) ABAS.forEach(function(a){ li.parentNode.insertBefore(aba(li, a), li); });
    }
    // equipes e etiquetas vazias (ela só vê as dela): o subgrupo sem nenhum link some
    Array.prototype.forEach.call(g.querySelectorAll('.i-lucide-users, .i-lucide-tag'), function(ic){
      var sub = ic.closest('li'); if (!sub || sub === g) return;
      esconder(sub, !sub.querySelector('a[href]'));
    });
    // as 5 pastas, na ordem da proposta (CSS order; a coluna precisa ser flex)
    var pastas = g.querySelectorAll('a[href*="/custom_view/"]');
    Array.prototype.forEach.call(pastas, function(a){
      var li = a.closest('li'), i = pastaDaBarra(a);
      if (!li) return;
      if (li.parentNode && !li.parentNode.hasAttribute(PASTA_COL)) li.parentNode.setAttribute(PASTA_COL, '1');
      ordem(li, i >= 0 ? i : PASTAS.length);
    });
  }

  function barraDaAtendente(ul){
    ICONES_FORA.forEach(function(ic){ esconder(grupoPorIcone(ul, ic), true); });
    TELAS_FORA.forEach(function(m){ esconder(item(m), true); });
    esconder(document.querySelector('aside nav [data-hoje-seta]'), true);
    var g = grupoPorIcone(ul, 'i-lucide-message-circle');
    if (g) { ordem(g, -40); enxugarConversas(g); }
    // Ferramentas: Tarefas, Contatos, Sofia (ensinar e testar)
    var tarefas = item('data-tarefas-menu'), sofia = item('data-ia-menu'), contatos = grupoPorIcone(ul, 'i-lucide-contact');
    if (sofia) trocarTexto(sofia, 'Sofia (ensinar e testar)');
    var rot = ul.querySelector('[data-dd-ferramentas]');
    if (!rot) { rot = document.createElement('li'); rot.setAttribute('data-dd-ferramentas', '1'); rot.setAttribute('role', 'presentation'); rot.textContent = 'Ferramentas'; ul.appendChild(rot); }
    ordem(rot, -30); ordem(tarefas, -29); ordem(contatos, -28); ordem(sofia, -27);
  }

  // volta ao que era (a pessoa trocou de conta/papel na mesma aba, ou o papel não é o da atendente)
  function desfazer(ul){
    Array.prototype.forEach.call(document.querySelectorAll('aside nav [' + OCULTO + ']'), function(el){ el.removeAttribute(OCULTO); });
    Array.prototype.forEach.call(document.querySelectorAll('aside nav [data-dd-aba], aside nav [data-dd-ferramentas]'), function(el){ el.remove(); });
    Array.prototype.forEach.call(document.querySelectorAll('aside nav [' + PASTA_COL + ']'), function(el){ el.removeAttribute(PASTA_COL); });
    Array.prototype.forEach.call(ul.querySelectorAll('li'), function(el){ if (el.style.order && /^-?\d+$/.test(el.style.order) && !HOJE_FILA.some(function(m){ return el.hasAttribute(m); })) el.style.order = ''; });
  }

  // ── o contador vermelho ──────────────────────────────────────────────────────────────────────────────────────────────────────
  function linkDaPasta(){
    var ls = document.querySelectorAll('aside nav a[href*="/custom_view/"]');
    for (var i = 0; i < ls.length; i++) { if (pastaDaBarra(ls[i]) === 0) return ls[i]; }
    return null;
  }
  function marcarContador(){
    var a = linkDaPasta(), todos = document.querySelectorAll('aside nav a[' + CONTA + ']');
    Array.prototype.forEach.call(todos, function(x){ if (x !== a || !(cont.n > 0)) x.removeAttribute(CONTA); });
    if (a && cont.n > 0) { var t = cont.n > 99 ? '99+' : String(cont.n); if (a.getAttribute(CONTA) !== t) a.setAttribute(CONTA, t); }
  }
  // a consulta da PRÓPRIA pasta, lida do estado do Chatwoot (zero requisição): o número é exatamente o que a lista dela mostra, e acompanha a pasta se
  // a Suzanne mudar o filtro. Sem o estado (ou sem filtro nela), vale a consulta da proposta: abertas com esperando-humano ou ia-pausada.
  function consultaDaPasta(){
    try {
      var m = (linkDaPasta().getAttribute('href') || '').match(/\/custom_view\/(\d+)/); if (!m) return null;
      var app = document.getElementById('app'); var vue = app && app.__vue_app__;
      var store = vue && vue.config && vue.config.globalProperties && vue.config.globalProperties.$store;
      var vs = store && store.getters && store.getters['customViews/getConversationCustomViews'];
      if (!Array.isArray(vs)) return null;
      for (var i = 0; i < vs.length; i++) {
        if (String(vs[i].id) === m[1]) { var q = vs[i].query; return q && Array.isArray(q.payload) && q.payload.length ? { payload: q.payload } : null; }
      }
    } catch (e) {}
    return null;
  }
  function consulta(){
    return consultaDaPasta() || { payload: [
      { attribute_key: 'status', filter_operator: 'equal_to', values: ['open'], query_operator: 'AND' },
      { attribute_key: 'labels', filter_operator: 'equal_to', values: ETIQUETAS, query_operator: null }
    ] };
  }
  // no máximo uma chamada a cada 60 s (a rotina) ou 15 s (trocou de tela); aba escondida não chama; falhou = número some
  function contar(porTroca){
    var conta = contaDaUrl(), s = sessao();
    if (!conta || !s || cont.preso || !linkDaPasta() || document.visibilityState !== 'visible') return;
    var minimo = porTroca ? 15000 : 30000;
    if (Date.now() - cont.ultima < minimo) return;
    cont.preso = true; cont.ultima = Date.now();
    // sem resposta em 15 s: desiste (uma chamada pendurada não pode travar o contador da aba para sempre)
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, limite = ctl ? setTimeout(function(){ ctl.abort(); }, 15000) : null;
    fetch('/api/v1/accounts/' + conta + '/conversations/filter', {
      method: 'POST',
      headers: { 'access-token': s.token, client: s.client, uid: s.uid, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(consulta()),
      signal: ctl ? ctl.signal : undefined
    })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){ if (cont.conta !== conta) return; var n = j && j.meta ? Number(j.meta.all_count) : NaN; cont.n = isFinite(n) && n >= 0 ? n : null; })
      .catch(function(){ if (cont.conta === conta) cont.n = null; })
      .then(function(){ if (limite) clearTimeout(limite); cont.preso = false; marcarContador(); });
  }

  function passar(){
    espera = null;
    if (!/\/app\/accounts\//.test(location.pathname)) return;
    var ul = document.querySelector('aside nav > ul'); if (!ul) return;
    var papel = papelAtual(); if (!papel) return; // sem papel: nada some
    garantirEstilo();
    hojeNoTopo();
    if (papel === 'agent') barraDaAtendente(ul); else desfazer(ul);
    // trocou de clínica (outra conta) na mesma aba: o número da anterior não vale, some até a conta nova responder
    var conta = contaDaUrl();
    if (cont.conta !== conta) { cont.conta = conta; cont.n = null; cont.ultima = 0; cont.caminho = ''; }
    if (cont.caminho !== location.pathname) { cont.caminho = location.pathname; contar(true); }
    marcarContador();
  }
  // freio: no máximo uma passada a cada 400 ms, por mais que o Chatwoot mexa na tela (o Vue mexe muito)
  function agendar(){ if (!espera) espera = setTimeout(passar, 400); }
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', function(){ agendar(); contar(false); });
  setInterval(function(){ contar(false); }, 60000);
  agendar();
})();`;

/** O JavaScript da barra por papel, pronto para ir no `menu.js`; VAZIO sem `CHATWOOT_BARRA_POR_PAPEL=1` (o menu.js então não muda um byte). */
export function barraPorPapelJs(env: NodeJS.ProcessEnv = process.env): string {
  if (!barraPorPapelLigada(env)) return '';
  return BARRA_JS.split('__PASTAS__').join(JSON.stringify(PASTAS_DA_BARRA.map(chavePasta))).split('__ETIQUETAS__').join(JSON.stringify(ETIQUETAS_DO_CONTADOR));
}

/** O mesmo `chave()` do navegador, para a lista de pastas ir já normalizada (sem acento, sem emoji, minúscula). */
export function chavePasta(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
