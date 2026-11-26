/**
 * Botão «Pausar Sofia» VISÍVEL na conversa do CRM (Chatwoot) — reclamação das unidades, 26/11/2026: pausar/reativar a IA numa conversa só existia
 * dentro do painel da assistente (botão azul redondo → «Pausar IA (eu assumo)»), que ninguém abre. Aqui vira uma barra fina no topo da conversa
 * aberta: «🤖 Sofia ativa · [Pausar Sofia]» / «⏸ Sofia pausada por X · [Reativar Sofia]».
 *
 * NÃO é uma pausa nova: usa a que já existe (`chatwoot-pausa.ts`, etiqueta `ia-pausada`) pelos MESMOS endpoints do painel
 * (`GET/POST /api/public/assistente/pausa`, com o login de quem clicou: a atribuição e a nota saem no nome dela). Clicar em «Pausar Sofia» faz o que o
 * painel faz: pausa e a conversa passa a ser de quem clicou (por isso pergunta antes). «Reativar» tira a etiqueta. A leitura do estado roda ao abrir a conversa e a cada 90 s com a aba à vista.
 *
 * Só aparece onde há Sofia: o servidor responde 422 para conversa de caixa sem IA (histórico, API de treinamento) e `sofia: false` para unidade com a
 * Sofia do CRM desligada (`chatwoot-ia`), e aí a barra não é criada. Conta sem nenhuma caixa de IA nunca vê nada. Só visual no navegador: nada é gravado sem o clique.
 *
 * Chave: `CHATWOOT_BOTAO_PAUSAR=1` põe o bloco no `menu.js` (vale em até 5 min, o cache do navegador). Padrão: DESLIGADO — uma tela nova não aparece
 * sozinha nas unidades que já usam o CRM.
 * Bloco INDEPENDENTE dentro do `menu.js` (`;try{ … }catch(e){}`): se falhar ao executar, o menu, a assistente, o guia e o selo seguem. O nó entra uma vez
 * (nunca é reposicionado: o selo da Sofia também usa o topo da conversa e as duas barras não brigam por lugar).
 */

export const botaoPausarLigado = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.CHATWOOT_BOTAO_PAUSAR ?? '').trim() === '1';

// String.raw: o que está aqui é o JavaScript que o navegador recebe. Sem crases nem «${» aqui dentro.
const PAUSAR_JS = String.raw`(function(){
  if (window.top !== window || window.__botaoPausarDD) return; window.__botaoPausarDD = 1;
  var AGENTE = __AGENTE__, BARRA = 'data-dd-pausar', ESTILO = 'data-dd-pausar-estilo';
  var est = { chave: null, pronto: false, aplicavel: false, pausada: false, por: null, buscando: false, ultima: 0, ocupado: false, erro: '', retry: 0 };
  var espera = null;

  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  function contaDaUrl(){ var m = location.pathname.match(/\/accounts\/(\d+)/); return m ? m[1] : null; }
  function conversaDaUrl(){ var m = location.pathname.match(/\/conversations\/(\d+)/); return m ? Number(m[1]) : null; }
  function cabecalhos(s, comCorpo){
    var h = { 'X-CW-Token': s.token, 'X-CW-Client': s.client, 'X-CW-Uid': s.uid };
    if (comCorpo) h['Content-Type'] = 'application/json';
    return h;
  }

  function css(){
    return '[' + BARRA + ']{display:flex;align-items:center;gap:10px;padding:5px 14px;font:600 12px/18px Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;background:#f1f4f8;color:#1f2d3d;border-bottom:1px solid #e4e7ec}'
      + '[' + BARRA + '] span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '[' + BARRA + '] button{flex-shrink:0;border:1px solid #cfd7e3;background:#fff;color:#1f2d3d;border-radius:8px;padding:3px 10px;font:inherit;cursor:pointer}'
      + '[' + BARRA + '] button:hover{background:#eef4ff;border-color:#1f93ff}'
      + '[' + BARRA + '] button:disabled{opacity:.55;cursor:default}'
      + '[' + BARRA + '="pausada"]{background:#fff4e5;color:#7a3e00;border-bottom-color:#f5d9a8}'
      + '[' + BARRA + '="pausada"] button{background:#1f93ff;border-color:#1f93ff;color:#fff}'
      + '.dark [' + BARRA + ']{background:#232a36;color:#d7dde8;border-bottom-color:#3a4252}'
      + '.dark [' + BARRA + '] button{background:#2d3646;color:#d7dde8;border-color:#475166}'
      + '.dark [' + BARRA + '="pausada"]{background:#3a2a10;color:#f5cf94;border-bottom-color:#6b4a14}'
      + '.dark [' + BARRA + '="pausada"] button{background:#1f93ff;border-color:#1f93ff;color:#fff}';
  }
  function garantirEstilo(){
    if (document.querySelector('style[' + ESTILO + ']')) return;
    var st = document.createElement('style'); st.setAttribute(ESTILO, '1'); st.textContent = css();
    (document.head || document.documentElement).appendChild(st);
  }

  // o estado da pausa desta conversa, do servidor (o mesmo do painel da assistente). 422/404: conversa sem Sofia, não volta a perguntar; erro de rede: tenta de novo em 1 min
  function ler(id, conta, s){
    est.buscando = true; est.ultima = Date.now();
    fetch(AGENTE + '/api/public/assistente/pausa?conversa=' + id + '&conta=' + conta, { headers: cabecalhos(s, false) })
      .then(function(r){
        if (est.chave !== conta + '/' + id) return;
        if (r.status === 422 || r.status === 404 || r.status === 403 || r.status === 401 || r.status === 400) { est.pronto = true; est.aplicavel = false; return; } // sem Sofia, sem acesso, sessão vencida ou conta inválida: não insiste (volta ao trocar de conversa)
        if (!r.ok) throw new Error('pausa ' + r.status);
        return r.json().then(function(j){ if (est.chave !== conta + '/' + id) return; est.pronto = true; est.aplicavel = !!j && typeof j.pausada === 'boolean' && j.sofia !== false; est.pausada = !!(j && j.pausada); est.por = j && j.por ? String(j.por) : null; });
      })
      .catch(function(){ est.retry = Date.now() + 60000; })
      .then(function(){ est.buscando = false; agendar(); });
  }
  function clicar(id, conta){
    var s = sessao(); if (!s || est.ocupado) return;
    // pausar passa a conversa para quem clicou (é a pausa do painel: «eu assumo»): pergunta antes, para não tirar o atendimento de outra pessoa sem querer
    if (!est.pausada && !window.confirm('Pausar a Sofia nesta conversa? Ela para de responder e a conversa passa a ser sua.')) return;
    est.ocupado = true; est.erro = ''; agendar();
    fetch(AGENTE + '/api/public/assistente/pausa?conta=' + conta, { method: 'POST', headers: cabecalhos(s, true), body: JSON.stringify({ conversa: id, acao: est.pausada ? 'reativar' : 'pausar' }) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error(j && j.error ? j.error : 'não consegui agora'); return j; }); })
      .then(function(j){ if (est.chave === conta + '/' + id) { est.pausada = !!j.pausada; est.por = j.por ? String(j.por) : null; if (j.sofia === false) est.aplicavel = false; } })
      .catch(function(e){ est.erro = String((e && e.message) || 'não consegui agora').slice(0, 80); setTimeout(function(){ est.erro = ''; agendar(); }, 6000); })
      .then(function(){ est.ocupado = false; est.ultima = Date.now(); agendar(); });
  }

  function tirar(){ var b = document.querySelector('[' + BARRA + ']'); if (b) b.remove(); }
  function desenhar(id, conta){
    var wrap = document.querySelector('.conversation-details-wrap');
    if (!wrap) { tirar(); return; }
    var b = wrap.querySelector(':scope > [' + BARRA + ']');
    if (!b) {
      tirar();
      b = document.createElement('div'); b.setAttribute('role', 'status');
      var t = document.createElement('span'); var bt = document.createElement('button'); bt.type = 'button';
      b.appendChild(t); b.appendChild(bt);
      wrap.insertBefore(b, wrap.firstChild); // uma vez só: nunca é reposicionado (o selo da Sofia também usa o topo)
    }
    var t2 = b.firstChild, bt2 = b.lastChild;
    b.setAttribute(BARRA, est.pausada ? 'pausada' : 'ativa');
    var texto = est.pausada ? '⏸ Sofia pausada' + (est.por ? ' por ' + est.por : '') + ' — ela não responde aqui' : '🤖 Sofia ativa nesta conversa';
    if (est.erro) texto = '⚠ ' + est.erro;
    if (t2.textContent !== texto) t2.textContent = texto;
    var rotulo = est.ocupado ? 'Aguarde…' : est.pausada ? 'Reativar Sofia' : 'Pausar Sofia';
    if (bt2.textContent !== rotulo) bt2.textContent = rotulo;
    bt2.disabled = est.ocupado;
    bt2.title = est.pausada ? 'A Sofia volta a responder nesta conversa' : 'A Sofia para de responder nesta conversa e ela passa a ser sua';
    bt2.onclick = function(){ clicar(id, conta); };
  }

  function passar(){
    espera = null;
    var id = /\/app\/accounts\//.test(location.pathname) ? conversaDaUrl() : null, conta = contaDaUrl(), s = sessao();
    if (!id || !conta || !s) { tirar(); return; }
    var chave = conta + '/' + id;
    if (est.chave !== chave) { est.chave = chave; est.pronto = false; est.aplicavel = false; est.pausada = false; est.por = null; est.erro = ''; est.retry = 0; tirar(); } // outra conversa: o estado da anterior não vale
    if (!est.buscando && !est.ocupado && document.visibilityState === 'visible') {
      if (!est.pronto && Date.now() >= est.retry) ler(id, conta, s);
      else if (est.pronto && est.aplicavel && Date.now() - est.ultima > 90000) ler(id, conta, s);
    }
    if (est.pronto && est.aplicavel) { garantirEstilo(); desenhar(id, conta); } else tirar();
  }
  // freio: no máximo uma passada a cada 400 ms, por mais que o Chatwoot mexa na tela (o Vue mexe muito)
  function agendar(){ if (!espera) espera = setTimeout(passar, 400); }
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', agendar);
  setInterval(agendar, 30000); // a cada 90 s (só com a aba à vista) reconfere a pausa de tempos em tempos (a equipe pode ter respondido pelo celular)
  agendar();
})();`;

/** O JavaScript do botão, pronto para ir no `menu.js`; vazio quando `CHATWOOT_BOTAO_PAUSAR` não é `1`. `agente` = a origem do servidor, já em JSON. */
export function botaoPausarJs(agente: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!botaoPausarLigado(env)) return '';
  return PAUSAR_JS.split('__AGENTE__').join(agente);
}
