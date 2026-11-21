/**
 * «Selo da Sofia» no CRM (Chatwoot) — pedido do João, 21/11/2026: «queria algo mais visual» do que a etiqueta roxa `sofia-atendendo`.
 *
 * O que aparece (só visual; este script nunca grava nada no Chatwoot):
 *  - na LISTA de conversas, o cartão que tem a etiqueta ganha faixa roxa à esquerda, fundo roxo bem leve e o selo «🤖 Sofia atendendo»;
 *  - na conversa ABERTA, uma barra roxa fina no topo: «🤖 A Sofia (IA) está atendendo esta conversa».
 *  Tudo some sozinho quando a etiqueta sai (a equipe assumiu, a Sofia passou, a conversa foi resolvida).
 *
 * Como detecta (lido do código do Chatwoot 4.19.1, ConversationCard.vue / CardLabels.vue / Label.vue):
 *  - LISTA: o cartão (`.conversation`, nos dois layouts, o condensado e o expandido) desenha as etiquetas da conversa como `.label` com o
 *    nome da etiqueta num <span>. O script procura esse texto, igual a `sofia-atendendo`, dentro de cada cartão. Zero requisição.
 *    O selo e a faixa são só CSS (um atributo `data-dd-sofia` no cartão + `::after`): o script não cria nenhum nó dentro do cartão que o
 *    Vue mantém, então a lista virtualizada do Chatwoot não tropeça.
 *  - CONVERSA ABERTA: as etiquetas dela ficam num painel que pode estar fechado, então o script lê as etiquetas da conversa selecionada
 *    no estado (store) do próprio Chatwoot, sem requisição. Se um dia o Chatwoot esconder esse estado, cai na API do próprio Chatwoot
 *    (`GET /api/v1/accounts/{conta}/conversations/{id}`, com a sessão do cookie, como o menu e o guia fazem), no máximo uma vez a cada 20 s e
 *    só com a aba à vista.
 *  - Reage a mudanças do DOM com um MutationObserver com freio (uma passada leve a cada 400 ms no máximo); não há setInterval.
 *
 * Chave: `CHATWOOT_SELO_SOFIA=0` tira o selo do `menu.js` (vale em até 5 min, o cache do navegador). Padrão: ligado.
 * Bloco INDEPENDENTE dentro do `menu.js` (`;try{ … }catch(e){}`): se falhar ao executar, o menu, a assistente e o guia seguem.
 */

/** O nome da etiqueta que a Sofia põe (igual a `ETIQUETA_SOFIA_ATENDENDO` em chatwoot-sofia-atendendo.ts; um teste confere). */
export const ETIQUETA_DO_SELO = 'sofia-atendendo';

export const seloDaSofiaLigado = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.CHATWOOT_SELO_SOFIA ?? '').trim() !== '0';

// String.raw: o que está aqui é o JavaScript que o navegador recebe. Sem crases nem «${» aqui dentro.
const SELO_JS = String.raw`(function(){
  if (window.top !== window || window.__seloSofiaDD) return; window.__seloSofiaDD = 1;
  var ETIQUETA = __ETIQUETA__, ROXO = '#7C3AED';
  var ATTR = 'data-dd-sofia', BARRA = 'data-dd-sofia-barra', ESTILO = 'data-dd-sofia-estilo';
  var TEXTO_SELO = '🤖 Sofia atendendo', TEXTO_BARRA = '🤖 A Sofia (IA) está atendendo esta conversa';
  var api = { buscando: false, ultima: 0, conversa: null, tem: false };
  var espera = null;

  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  function contaDaUrl(){ var m = location.pathname.match(/\/accounts\/(\d+)/); return m ? m[1] : null; }
  function conversaDaUrl(){ var m = location.pathname.match(/\/conversations\/(\d+)/); return m ? Number(m[1]) : null; }

  // ── o CSS (um só, no <head>): faixa + fundo leve no cartão, o selo é o ::after do cartão, a barra do topo ──────────────────────
  // a cor do selo e da barra é a mesma nos dois temas (roxo com letra branca, contraste 5,7:1); o fundo leve é translúcido: serve no claro e no escuro
  function css(){
    var leve = 'linear-gradient(rgba(124,58,237,.10),rgba(124,58,237,.10))';
    return '.conversation[' + ATTR + ']{box-shadow:inset 5px 0 0 ' + ROXO + ';background-image:' + leve + '}'
      + '.conversation[' + ATTR + '="c"]{padding-top:18px}'
      + '.conversation[' + ATTR + ']::after{content:"' + TEXTO_SELO + '";position:absolute;z-index:2;pointer-events:none;white-space:nowrap;'
      + 'font:600 12px/18px Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;color:#fff;background:' + ROXO + ';padding:0 9px;border-radius:0 0 8px 8px}'
      + '.conversation[' + ATTR + '="c"]::after{top:0;left:52px}'
      + '.conversation[' + ATTR + '="e"]::after{top:0;left:6px;font-size:11px;line-height:14px;padding:0 6px}'
      + '[' + BARRA + ']{flex:none;display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:4px 12px;min-height:24px;'
      + 'background:' + ROXO + ';color:#fff;font:600 12px/16px Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif}';
  }
  function garantirEstilo(){
    if (document.querySelector('style[' + ESTILO + ']')) return;
    var st = document.createElement('style'); st.setAttribute(ESTILO, '1'); st.textContent = css();
    (document.head || document.documentElement).appendChild(st);
  }

  // ── LISTA: o cartão tem a pílula «sofia-atendendo»? (o texto exato do nome da etiqueta, dentro de um .label) ──────────────────
  function cartaoTemEtiqueta(card){
    var ls = card.querySelectorAll('.label');
    for (var i = 0; i < ls.length; i++) { if (String(ls[i].textContent || '').replace(/\s+/g, ' ').trim() === ETIQUETA) return true; }
    return false;
  }
  function marcarCartoes(){
    var cards = document.querySelectorAll('.conversation');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], tem = cartaoTemEtiqueta(c);
      var modo = tem ? (c.querySelector('.conversation--user') ? 'c' : 'e') : null;
      if (modo) { if (c.getAttribute(ATTR) !== modo) c.setAttribute(ATTR, modo); }
      else if (c.hasAttribute(ATTR)) c.removeAttribute(ATTR);
    }
  }

  // ── CONVERSA ABERTA: etiquetas da conversa selecionada, do estado do próprio Chatwoot ou (reserva) da API dele ────────────────
  function etiquetasDoEstado(id){
    try {
      var app = document.getElementById('app'); var vue = app && app.__vue_app__;
      var store = vue && vue.config && vue.config.globalProperties && vue.config.globalProperties.$store;
      var chat = store && store.getters && store.getters.getSelectedChat;
      if (!chat || Number(chat.id) !== id || !Array.isArray(chat.labels)) return null;
      return chat.labels;
    } catch (e) { return null; }
  }
  function perguntarApi(id){
    var s = sessao(), conta = contaDaUrl();
    if (!s || !conta || api.buscando || document.visibilityState !== 'visible' || Date.now() - api.ultima < 20000) return;
    api.buscando = true; api.ultima = Date.now();
    fetch('/api/v1/accounts/' + conta + '/conversations/' + id, { headers: { 'access-token': s.token, client: s.client, uid: s.uid } })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){ var ls = j && Array.isArray(j.labels) ? j.labels : []; api.conversa = id; api.tem = ls.indexOf(ETIQUETA) >= 0; agendar(); })
      .catch(function(){})
      .then(function(){ api.buscando = false; });
  }
  function conversaTemEtiqueta(id){
    var ls = etiquetasDoEstado(id);
    if (ls) return ls.indexOf(ETIQUETA) >= 0;
    perguntarApi(id);
    return api.conversa === id ? api.tem : false;
  }
  function tirarBarra(){ var b = document.querySelector('[' + BARRA + ']'); if (b) b.remove(); }
  function barra(){
    var id = /\/app\/accounts\//.test(location.pathname) ? conversaDaUrl() : null;
    var wrap = id ? document.querySelector('.conversation-details-wrap') : null;
    if (!id || !wrap || !conversaTemEtiqueta(id)) { tirarBarra(); return; }
    var b = wrap.querySelector(':scope > [' + BARRA + ']');
    if (b) { if (wrap.firstElementChild !== b) wrap.insertBefore(b, wrap.firstChild); return; }
    tirarBarra();
    b = document.createElement('div'); b.setAttribute(BARRA, '1'); b.setAttribute('role', 'status'); b.title = 'A etiqueta «' + ETIQUETA + '» sai sozinha quando a equipe assume';
    b.textContent = TEXTO_BARRA;
    wrap.insertBefore(b, wrap.firstChild);
  }

  function passar(){
    espera = null;
    if (!/\/app\/accounts\//.test(location.pathname)) { tirarBarra(); return; }
    garantirEstilo(); marcarCartoes(); barra();
  }
  // freio: no máximo uma passada a cada 400 ms, por mais que o Chatwoot mexa na tela (o Vue mexe muito)
  function agendar(){ if (!espera) espera = setTimeout(passar, 400); }
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  agendar();
})();`;

/** O JavaScript do selo, pronto para ir no `menu.js`; vazio quando `CHATWOOT_SELO_SOFIA=0`. */
export function seloSofiaJs(env: NodeJS.ProcessEnv = process.env): string {
  if (!seloDaSofiaLigado(env)) return '';
  return SELO_JS.split('__ETIQUETA__').join(JSON.stringify(ETIQUETA_DO_SELO));
}
