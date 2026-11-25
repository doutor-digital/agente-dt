/**
 * «Rótulo do robô» nas conversas do CRM (Chatwoot) — pedido do João, 25/11/2026: as mensagens automáticas precisam ter um rótulo VISÍVEL em cima do balão
 * (hoje só aparece no hover «Enviado por: 🤖 Robô automático»).
 *
 *  Todo balão de SAÍDA mostra em cima QUEM mandou, no mesmo estilo e no mesmo lugar (o João bate o olho: gente, IA ou robô):
 *  - «🤖 Robô · modelo automático»: a mensagem saiu pelo usuário CONECTOR da conta (o que manda os modelos e lembretes da régua; renomeado «🤖 Robô automático»)
 *    ou traz `additional_attributes.template_params` (modelo aprovado do WhatsApp) sem uma PESSOA por trás;
 *  - «✨ Sofia (IA)»: a mensagem saiu pelo AgentBot (o robô «Sofia»);
 *  - «👤 <nome>»: uma PESSOA respondeu (a SDR, a gerente, a secretária): o nome que vem no remetente (`sender.available_name` / `sender.name`). Só o NOME: o Chatwoot não diz de
 *    forma confiável se a pessoa é SDR ou gerente (o papel dele é só «administrador»/«agente»), e papel não se inventa. O eco do celular da unidade (usuário «📱 Celular da
 *    unidade») aparece com esse nome («📱 Celular da unidade»), sem o 👤.
 *  Nota privada, mensagem do paciente e atividade NUNCA levam rótulo.
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
  var CONECTORES = __CONECTORES__, ATTR = 'data-dd-rotulo', NOME = 'data-dd-nome', ESTILO = 'data-dd-rotulo-estilo';
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
      // gente: o NOME vem do atributo (a CSS lê attr(); nada é interpretado como HTML), cortado com reticências se for longo
      + '[' + ATTR + '="gente"]::before{content:attr(' + NOME + ');background:#e6f3ec;color:#1f5f43;border:1px solid #b9dcc9;max-width:62%;overflow:hidden;text-overflow:ellipsis}'
      + '.dark [' + ATTR + '="robo"]::before{background:#2a2d3a;color:#c3c9e4;border-color:#43484e}'
      + '.dark [' + ATTR + '="sofia"]::before{background:#2c1c5c;color:#d4c0ff;border-color:#4b3490}'
      + '.dark [' + ATTR + '="gente"]::before{background:#12372a;color:#9be0bf;border-color:#2a6a4e}'
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
  // o NOME de quem mandou, como o Chatwoot entrega (available_name = o de exibição; name = o cadastro); limpo e curto
  function nomeDe(s){
    var n = String((s && (s.available_name || s.name)) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return n;
  }
  // devolve { t: 'robo' | 'sofia' | 'gente', nome } ou null (paciente, atividade, nota privada, remetente desconhecido)
  function tipoDaMensagem(m){
    if (!m || m.private === true) return null; // nota privada nunca
    var t = Number(m.message_type); if (t !== 1 && t !== 3) return null; // só o que SAIU (1 = enviada, 3 = modelo); paciente (0) e atividade (2) nunca
    var s = m.sender || {}, quem = String(s.type || m.sender_type || '').toLowerCase().replace(/[^a-z]/g, '');
    if (quem === 'agentbot') return { t: 'sofia' };
    if (quem === 'contact') return null;
    // o usuário CONECTOR: o id conhecido, ou o nome padrão das contas («🤖 Robô automático»; o nome do USUÁRIO, não o texto da mensagem)
    var conector = CONECTORES.indexOf(Number(s.id)) >= 0 || String(s.name || '').indexOf('🤖') === 0;
    if (conector && (quem === 'user' || quem === '')) return { t: 'robo' };
    if (quem === 'user') { var n = nomeDe(s); return n ? { t: 'gente', nome: /^[A-Za-zÀ-ÿ0-9]/.test(n) ? '👤 ' + n : n } : null; } // uma PESSOA (nem quando manda um modelo pelo botão); o eco do celular já traz o 📱 no nome
    var tp = atributos(m).template_params; // modelo aprovado do WhatsApp sem ninguém por trás (régua, tarefa, disparo)
    if (tp && typeof tp === 'object') return { t: 'robo' };
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
      var r = tipoDaMensagem(msgs[i]); if (!r) continue;
      var el = contentorDaMensagem(msgs[i].id); if (!el) continue;
      devido[msgs[i].id] = r.t + '|' + (r.nome || '');
      if (el.getAttribute(ATTR) !== r.t) el.setAttribute(ATTR, r.t);
      if (r.nome) { if (el.getAttribute(NOME) !== r.nome) el.setAttribute(NOME, r.nome); } else if (el.hasAttribute && el.hasAttribute(NOME)) el.removeAttribute(NOME);
    }
    // o contêiner que o Vue reaproveitou para outra mensagem (ou que deixou de ser marcável) perde o rótulo
    for (var j = 0; j < marcados.length; j++) {
      var m = String(marcados[j].getAttribute('data-message-id') || marcados[j].id || '').replace(/^message/, '');
      if (!devido[m]) { marcados[j].removeAttribute(ATTR); if (marcados[j].hasAttribute && marcados[j].hasAttribute(NOME)) marcados[j].removeAttribute(NOME); }
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
