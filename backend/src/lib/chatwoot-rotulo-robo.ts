/**
 * «Rótulo do robô» nas conversas do CRM (Chatwoot) — pedido do João, 25/11/2026: as mensagens automáticas precisam ter um rótulo VISÍVEL em cima do balão
 * (hoje só aparece no hover «Enviado por: 🤖 Robô automático»).
 *
 *  - «🤖 Robô · modelo automático»: a mensagem saiu pelo usuário CONECTOR da conta (o que manda os modelos e lembretes da régua; renomeado «🤖 Robô automático»)
 *    ou traz `additional_attributes.template_params` (modelo aprovado do WhatsApp) sem uma PESSOA da equipe por trás (quem manda modelo pelo botão não é robô);
 *  - «✨ Sofia (IA)»: a mensagem saiu pelo AgentBot (o robô «Sofia»).
 *  Mensagem de PESSOA da equipe, o eco do celular da unidade (usuário «📱 Celular da unidade»), nota privada e mensagem do paciente NUNCA são marcadas.
 *
 * Como detecta: pelo ESTADO (store) do próprio Chatwoot — as mensagens da conversa aberta (`getSelectedChat.messages`: tipo, privada, quem enviou, `template_params`) —
 * nunca pelo texto da mensagem. Só visual: o script não grava nada e NÃO cria nó dentro do que o Vue controla (como o selo da Sofia): põe um atributo
 * `data-dd-rotulo` no contêiner do balão (`#message<id>`) e o rótulo é o `::before` dele (CSS). Sai sozinho quando a mensagem deixa de ser marcável.
 *
 * Quem é o conector: ids de USUÁRIO (únicos na instalação inteira, valem para qualquer conta). Padrão `2` (conta 1) e `14` (conta 3, Timbó); outras clínicas somam o id
 * em `CHATWOOT_CONECTORES_IDS` (lista separada por vírgula, que SOMA ao padrão) ou dão ao usuário o nome padrão «🤖 Robô automático» (o nome do usuário começa com 🤖).
 *
 * Chave: `CHATWOOT_ROTULO_ROBO=0` tira o rótulo do `menu.js` (vale em até 5 min, o cache do navegador). Padrão: ligado.
 * Bloco INDEPENDENTE dentro do `menu.js` (`;try{ … }catch(e){}`): se falhar ao executar, o menu, a assistente, o guia e o selo seguem.
 */

/** Os usuários «Conector» conhecidos (conta 1 = 2; conta 3, Timbó = 14). */
export const CONECTORES_PADRAO: readonly number[] = [2, 14];

export const rotuloDoRoboLigado = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.CHATWOOT_ROTULO_ROBO ?? '').trim() !== '0';

/** Os ids de usuário do conector: o padrão + `CHATWOOT_CONECTORES_IDS`. Só inteiro > 0; lixo na variável é ignorado. */
export function conectoresDoRotulo(env: NodeJS.ProcessEnv = process.env): number[] {
  const extras = String(env.CHATWOOT_CONECTORES_IDS ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set([...CONECTORES_PADRAO, ...extras])].sort((a, b) => a - b);
}

// String.raw: o que está aqui é o JavaScript que o navegador recebe. Sem crases nem «${» aqui dentro.
const ROTULO_JS = String.raw`(function(){
  if (window.top !== window || window.__rotuloRoboDD) return; window.__rotuloRoboDD = 1;
  var CONECTORES = __CONECTORES__, ATTR = 'data-dd-rotulo', ESTILO = 'data-dd-rotulo-estilo';
  var TEXTO = { robo: '🤖 Robô · modelo automático', sofia: '✨ Sofia (IA)' };
  var espera = null;

  function conversaDaUrl(){ var m = location.pathname.match(/\/conversations\/(\d+)/); return m ? Number(m[1]) : null; }

  // ── o CSS (um só, no <head>): o rótulo é o ::before do contêiner do balão; mensagem enviada fica à direita ──────────────────────
  function css(){
    var base = 'font:600 11px/16px Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;white-space:nowrap;padding:0 8px;border-radius:8px;pointer-events:none';
    return '[' + ATTR + ']{position:relative;margin-top:22px!important}'
      + '[' + ATTR + ']::before{position:absolute;z-index:1;top:-19px;right:10px;' + base + '}'
      + '[' + ATTR + '="robo"]::before{content:"' + TEXTO.robo + '";background:#eceef5;color:#454c6b;border:1px solid #cdd2e3}'
      + '[' + ATTR + '="sofia"]::before{content:"' + TEXTO.sofia + '";background:#efe8fd;color:#5b21b6;border:1px solid #d9c7fb}'
      + '.dark [' + ATTR + '="robo"]::before{background:#2a2d3a;color:#c3c9e4;border-color:#43484e}'
      + '.dark [' + ATTR + '="sofia"]::before{background:#2c1c5c;color:#d4c0ff;border-color:#4b3490}'
      + '@media (max-width:560px){[' + ATTR + ']::before{right:6px;font-size:10.5px;padding:0 6px}}';
  }
  function garantirEstilo(){
    if (document.querySelector('style[' + ESTILO + ']')) return;
    var st = document.createElement('style'); st.setAttribute(ESTILO, '1'); st.textContent = css();
    (document.head || document.documentElement).appendChild(st);
  }

  // ── as mensagens da conversa ABERTA, do estado do próprio Chatwoot (sem requisição) ────────────────────────────────────────────
  function mensagensDoEstado(id){
    try {
      var app = document.getElementById('app'); var vue = app && app.__vue_app__;
      var store = vue && vue.config && vue.config.globalProperties && vue.config.globalProperties.$store;
      var chat = store && store.getters && store.getters.getSelectedChat;
      if (!chat || Number(chat.id) !== id || !Array.isArray(chat.messages)) return null;
      return chat.messages;
    } catch (e) { return null; }
  }
  function atributos(m){ var a = m && m.additional_attributes; return a && typeof a === 'object' ? a : {}; }
  function tipoDaMensagem(m){
    if (!m || m.private === true) return null; // nota privada nunca
    var t = Number(m.message_type); if (t !== 1 && t !== 3) return null; // só o que SAIU (1 = enviada, 3 = modelo); paciente (0) e atividade (2) nunca
    var s = m.sender || {}, quem = String(s.type || m.sender_type || '').toLowerCase().replace(/[^a-z]/g, '');
    if (quem === 'agentbot') return 'sofia';
    // o usuário CONECTOR: o id conhecido, ou o nome padrão das contas («🤖 Robô automático»; o nome do USUÁRIO, não o texto da mensagem)
    var conector = CONECTORES.indexOf(Number(s.id)) >= 0 || String(s.name || '').indexOf('🤖') === 0;
    if (quem === 'user' && !conector) return null; // pessoa da equipe (e o eco do celular): nunca, nem quando manda um modelo pelo botão
    if (conector && (quem === 'user' || quem === '')) return 'robo';
    var tp = atributos(m).template_params; // modelo aprovado do WhatsApp sem pessoa por trás (régua, tarefa, disparo)
    if (tp && typeof tp === 'object' && quem !== 'contact') return 'robo';
    return null;
  }
  function contentorDaMensagem(id){
    return document.querySelector('[data-message-id="' + id + '"]') || document.getElementById('message' + id);
  }

  function passar(){
    espera = null;
    var id = /\/app\/accounts\//.test(location.pathname) ? conversaDaUrl() : null;
    var marcados = document.querySelectorAll('[' + ATTR + ']');
    var msgs = id ? mensagensDoEstado(id) : null;
    if (!msgs) { for (var k = 0; k < marcados.length; k++) marcados[k].removeAttribute(ATTR); return; }
    garantirEstilo();
    var devido = {};
    for (var i = 0; i < msgs.length; i++) {
      var t = tipoDaMensagem(msgs[i]); if (!t) continue;
      var el = contentorDaMensagem(msgs[i].id); if (!el) continue;
      devido[msgs[i].id] = t;
      if (el.getAttribute(ATTR) !== t) el.setAttribute(ATTR, t);
    }
    // o contêiner que o Vue reaproveitou para outra mensagem (ou que deixou de ser marcável) perde o rótulo
    for (var j = 0; j < marcados.length; j++) {
      var m = String(marcados[j].getAttribute('data-message-id') || marcados[j].id || '').replace(/^message/, '');
      if (devido[m] !== marcados[j].getAttribute(ATTR)) marcados[j].removeAttribute(ATTR);
    }
  }
  // freio: no máximo uma passada a cada 400 ms, por mais que o Chatwoot mexa na tela (o Vue mexe muito)
  function agendar(){ if (!espera) espera = setTimeout(passar, 400); }
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', agendar);
  agendar();
})();`;

/** O JavaScript do rótulo, pronto para ir no `menu.js`; vazio quando `CHATWOOT_ROTULO_ROBO=0`. */
export function rotuloRoboJs(env: NodeJS.ProcessEnv = process.env): string {
  if (!rotuloDoRoboLigado(env)) return '';
  return ROTULO_JS.split('__CONECTORES__').join(JSON.stringify(conectoresDoRotulo(env)));
}
