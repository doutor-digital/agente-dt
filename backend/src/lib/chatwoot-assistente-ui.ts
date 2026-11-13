/**
 * A parte que a atendente VÊ da assistente (ver `chatwoot-assistente.ts`): o botão flutuante que entra no Chatwoot junto com o menu
 * (`GET /funil/menu.js`) e a página do painel (`GET /assistente`), que roda num iframe do nosso servidor.
 *
 * Por que iframe e não o painel direto na página do Chatwoot: o painel fala com a nossa API, e o Chatwoot e o nosso servidor
 * são origens diferentes (sem CORS aberto). No iframe a chamada é do mesmo servidor, e o login da pessoa chega do mesmo jeito
 * que no funil: o botão (na página do Chatwoot) lê o cookie da sessão e entrega por `postMessage`, com checagem de origem dos
 * dois lados. O iframe nunca fala com o Chatwoot; só pede ao botão duas coisas: a sessão e "colocar este texto no campo".
 *
 * Os dois textos usam `String.raw`: o que está aqui é o JavaScript que o navegador recebe, sem crase nem interpolação.
 */

const BOTAO_JS = String.raw`(function(){
  if (window.top !== window || window.__assistenteDD) return; window.__assistenteDD = 1;
  var AGENTE = __AGENTE__, LEMBRAR = 'assistente:aberto';
  var botao = null, painel = null, fr = null, conversa = null, ligada = null, consultando = false, proxima = 0;
  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  function emConta(){ return /\/app\/accounts\//.test(location.pathname); }
  function conversaDaUrl(){ var m = location.pathname.match(/\/conversations\/(\d+)/); return m ? Number(m[1]) : null; }

  // O campo de resposta do Chatwoot: o editor (ProseMirror) ou, no modo simples, uma caixa de texto.
  function campo(){
    return document.querySelector('.reply-box .ProseMirror[contenteditable="true"]')
      || document.querySelector('.reply-box textarea')
      || document.querySelector('.ProseMirror-woot-style .ProseMirror[contenteditable="true"]');
  }
  function emNotaPrivada(){ return !!document.querySelector('.reply-box.is-private, .reply-box--private'); }
  function textoDoCampo(el){ return String(el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '')).trim(); }

  // Coloca o texto no campo SEM enviar. Devolve { ok, motivo }. 'ocupado' = já tem texto escrito (a pessoa confirma antes de trocar).
  function inserir(texto, substituir){
    var el = campo();
    if (!el) return { ok: false, motivo: 'sem-campo' };
    if (emNotaPrivada()) return { ok: false, motivo: 'nota-privada' };
    if (textoDoCampo(el) && !substituir) return { ok: false, motivo: 'ocupado' };
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      var set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, texto);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return textoDoCampo(el) ? { ok: true } : { ok: false, motivo: 'sem-campo' };
    }
    // O editor só "percebe" o texto se ele chegar como digitação: seleciona tudo e insere pelos comandos do navegador,
    // que disparam beforeinput/input como se a pessoa tivesse digitado. Não aperta Enter nem clica em enviar.
    try {
      var sel = window.getSelection(), r = document.createRange();
      r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('delete');
      var blocos = String(texto).split(/\n{2,}/);
      for (var i = 0; i < blocos.length; i++) {
        if (i > 0) document.execCommand('insertParagraph');
        var linhas = blocos[i].split('\n');
        for (var k = 0; k < linhas.length; k++) {
          if (k > 0) document.execCommand('insertLineBreak');
          if (linhas[k]) document.execCommand('insertText', false, linhas[k]);
        }
      }
    } catch (e) { return { ok: false, motivo: 'sem-campo' }; }
    var pedaco = String(texto).replace(/\s+/g, ' ').trim().slice(0, 12);
    return textoDoCampo(el).replace(/\s+/g, ' ').indexOf(pedaco) >= 0 ? { ok: true } : { ok: false, motivo: 'sem-campo' };
  }

  // Fica ACIMA da área de resposta (nunca cobre o botão de enviar) e no canto direito.
  function posicao(){
    var base = 24, el = campo();
    if (el) {
      var caixa = el.closest('.reply-box') || el, r = caixa.getBoundingClientRect();
      if (r.height > 0 && r.top > 0 && r.top < window.innerHeight) base = Math.max(24, Math.round(window.innerHeight - r.top + 12));
    }
    if (botao) botao.style.bottom = base + 'px';
    if (painel) {
      painel.style.bottom = (base + 60) + 'px';
      painel.style.height = Math.max(240, Math.min(560, window.innerHeight - base - 60 - 16)) + 'px';
    }
  }
  function lembrar(v){ try { if (v) sessionStorage.setItem(LEMBRAR, '1'); else sessionStorage.removeItem(LEMBRAR); } catch (e) {} }
  function estavaAberto(){ try { return sessionStorage.getItem(LEMBRAR) === '1'; } catch (e) { return false; } }

  function falar(msg){ if (fr && fr.contentWindow) { try { fr.contentWindow.postMessage(msg, AGENTE); } catch (e) {} } }
  function abrir(){
    if (!painel) {
      painel = document.createElement('div');
      painel.setAttribute('data-assistente-painel', '1');
      painel.style.cssText = 'position:fixed;right:16px;width:380px;max-width:calc(100vw - 32px);z-index:2147482000;background:#fff;border:1px solid #e3e8ef;border-radius:14px;box-shadow:0 8px 32px rgba(16,24,40,.22);overflow:hidden;display:none';
      fr = document.createElement('iframe');
      fr.src = AGENTE + '/assistente'; fr.title = 'Assistente'; fr.setAttribute('allow', 'clipboard-write');
      fr.style.cssText = 'border:0;width:100%;height:100%;display:block';
      painel.appendChild(fr); document.body.appendChild(painel);
    }
    painel.style.display = 'block'; botao.setAttribute('aria-expanded', 'true'); lembrar(true); posicao();
    falar({ event: 'assistente-conversa', conversa: conversa });
  }
  function minimizar(){ if (painel) painel.style.display = 'none'; if (botao) botao.setAttribute('aria-expanded', 'false'); lembrar(false); }
  function alternar(){ if (painel && painel.style.display === 'block') minimizar(); else abrir(); }

  function criarBotao(){
    botao = document.createElement('button'); botao.type = 'button';
    botao.setAttribute('data-assistente-botao', '1'); botao.setAttribute('aria-label', 'Assistente'); botao.title = 'Assistente: o que eu respondo? / tirar dúvida';
    botao.style.cssText = 'position:fixed;right:16px;bottom:24px;z-index:2147482001;width:48px;height:48px;border-radius:50%;border:0;background:#1f93ff;color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(31,147,255,.45);display:flex;align-items:center;justify-content:center;padding:0';
    botao.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7l.9 2.1L15 10l-2.1.9L12 13l-.9-2.1L9 10l2.1-.9z"/></svg>';
    botao.onclick = alternar;
    document.body.appendChild(botao);
    posicao();
    if (estavaAberto()) abrir();
  }

  // Só aparece se a assistente estiver ligada para a unidade desta pessoa (o servidor responde por ela). Só uma resposta DEFINITIVA
  // vale como "desligada" (5 min até perguntar de novo); erro de rede, 429 ou 502 tenta de novo em 1 min. Com o botão na tela,
  // continua perguntando a cada 5 min: desligada no servidor, ou outra pessoa na mesma aba, tira o botão.
  var uidVisto = null;
  function tirar(){
    if (botao) botao.remove(); if (painel) painel.remove();
    botao = painel = fr = null;
  }
  function conferir(){
    var s = sessao();
    if (!s || !emConta()) return;
    if (uidVisto !== null && uidVisto !== s.uid) { tirar(); proxima = 0; }
    uidVisto = s.uid;
    if (consultando || Date.now() < proxima) return;
    consultando = true;
    fetch(AGENTE + '/api/public/assistente/estado', { headers: { 'X-CW-Token': s.token, 'X-CW-Client': s.client, 'X-CW-Uid': s.uid } })
      .then(function(r){ if (!r.ok) throw new Error('estado ' + r.status); return r.json(); })
      .then(function(j){
        ligada = !!(j && j.ligada); proxima = Date.now() + 5 * 60000;
        if (ligada && !botao) criarBotao(); else if (!ligada && botao) tirar();
      })
      .catch(function(){ proxima = Date.now() + 60000; })
      .then(function(){ consultando = false; });
  }

  // ── 👍/👎 no balão das respostas da Sofia (13/11) ─────────────────────────────────────────────────────────────
  // O servidor diz quais mensagens da conversa aberta são respostas da Sofia (ele guarda o id de cada uma quando ela responde) e o
  // que cada uma já recebeu. O botão entra no fim do balão (aparece ao passar o mouse; fica aceso depois de avaliado). 👎 pede
  // "o que estava errado" num quadrinho e vai para a tela Agente › Para revisar. Nada disso chega ao paciente.
  // Pergunta ao servidor a cada 30 s, ou antes (5 s no mínimo) quando chega mensagem nova na tela — e só com a aba visível.
  var AV = { conversa: null, mapa: {}, proxima: 0, buscando: false, estilo: false, pop: null, qtd: -1, ultima: 0 };
  var SVG_BOA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
  var SVG_RUIM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>';
  function estiloAval(){
    if (AV.estilo) return; AV.estilo = true;
    var st = document.createElement('style'); st.setAttribute('data-dd-aval-estilo', '1');
    st.textContent = '[data-dd-aval]{display:flex;align-items:center;justify-content:flex-end;gap:2px;margin:6px -6px -4px 0;opacity:0;transition:opacity .15s}'
      + '.message-bubble-container:hover [data-dd-aval],[data-dd-aval].tem{opacity:1}'
      + '@media (hover:none){[data-dd-aval]{opacity:.85}}'
      + '[data-dd-aval] span{font-size:10.5px;opacity:.6;margin-right:4px;white-space:nowrap}'
      + '[data-dd-aval] button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:22px;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.55;cursor:pointer;padding:0}'
      + '[data-dd-aval] button:hover{opacity:1;background:rgba(127,127,127,.16)}'
      + '[data-dd-aval] button svg{width:14px;height:14px}'
      + '[data-dd-aval] button.on{opacity:1}[data-dd-aval] button.on.boa{color:#12855a}[data-dd-aval] button.on.ruim{color:#e5484d}'
      + '[data-dd-aval] button.outra{opacity:.9;color:#e5484d}'
      + '[data-dd-aval-pop]{position:fixed;z-index:2147482500;width:300px;max-width:calc(100vw - 24px);background:#fff;color:#1f2d3d;border:1px solid #e3e8ef;border-radius:12px;box-shadow:0 12px 32px rgba(16,24,40,.24);padding:12px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
      + '[data-dd-aval-pop] b{display:block;font-size:13.5px;margin-bottom:6px}'
      + '[data-dd-aval-pop] textarea{width:100%;box-sizing:border-box;min-height:74px;resize:vertical;border:1px solid #cfd7e3;border-radius:8px;padding:8px;font:inherit;color:inherit;background:#fff}'
      + '[data-dd-aval-pop] textarea:focus{outline:none;border-color:#1f93ff;box-shadow:0 0 0 3px rgba(31,147,255,.15)}'
      + '[data-dd-aval-pop] .linha{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}'
      + '[data-dd-aval-pop] button{border:1px solid #cfd7e3;background:#fff;color:#1f2d3d;border-radius:8px;padding:6px 11px;font:600 12.5px/1.2 inherit;cursor:pointer}'
      + '[data-dd-aval-pop] button.pri{background:#1f93ff;border-color:#1f93ff;color:#fff}[data-dd-aval-pop] button:disabled{opacity:.55;cursor:default}'
      + '[data-dd-aval-pop] small{display:block;margin-top:8px;color:#6b7a90;font-size:11.5px}'
      + '[data-dd-aval-pop] .erro{color:#c53030;font-size:12px;margin-top:6px}';
    document.head.appendChild(st);
  }
  function lerAvaliacoes(c){
    var s = sessao(); if (!s || AV.buscando) return;
    AV.buscando = true;
    fetch(AGENTE + '/api/public/assistente/respostas?conversa=' + c, { headers: { 'X-CW-Token': s.token, 'X-CW-Client': s.client, 'X-CW-Uid': s.uid } })
      .then(function(r){ if (!r.ok) throw new Error('respostas ' + r.status); return r.json(); })
      .then(function(j){
        if (AV.conversa !== c) return;
        var m = {}; (j.respostas || []).forEach(function(x){ m[String(x.id)] = x; }); AV.mapa = m;
        Array.prototype.forEach.call(document.querySelectorAll('[data-dd-aval]'), function(b){ var x = m[b.getAttribute('data-dd-aval')]; if (x) pintarAval(b, x); });
      })
      .catch(function(){})
      .then(function(){
        AV.buscando = false;
        // trocou de conversa durante a busca: a nova conversa pergunta já (o prazo era da conversa antiga)
        AV.proxima = AV.conversa === c ? Date.now() + 30000 : 0;
      });
  }
  function pintarAval(barra, x){
    var boa = barra.querySelector('button.boa'), ruim = barra.querySelector('button.ruim');
    boa.classList.toggle('on', x.minha === 'boa'); ruim.classList.toggle('on', x.minha === 'ruim');
    ruim.classList.toggle('outra', !x.minha && !!x.ruimPor);
    barra.classList.toggle('tem', !!x.minha || !!x.ruimPor);
    ruim.title = x.ruimPor && !x.minha ? ('Marcada como ruim por ' + x.ruimPor + '. Clique para dar a sua opinião.') : 'Resposta ruim: conte o que estava errado';
  }
  function enviarAval(id, nota, texto){
    var s = sessao(); if (!s) return Promise.reject(new Error('Entre de novo no Chatwoot.'));
    return fetch(AGENTE + '/api/public/assistente/avaliar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CW-Token': s.token, 'X-CW-Client': s.client, 'X-CW-Uid': s.uid }, body: JSON.stringify({ conversa: AV.conversa, mensagem: Number(id), nota: nota, texto: texto || '' }) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error(j.error || 'não consegui registrar agora'); return j; }); })
      .then(function(){ var x = AV.mapa[id] || { id: Number(id), minha: null, ruimPor: null }; x.minha = nota; AV.mapa[id] = x; var b = document.querySelector('[data-dd-aval="' + id + '"]'); if (b) pintarAval(b, x); });
  }
  function fecharPop(){ if (AV.pop) { AV.pop.remove(); AV.pop = null; } }
  function abrirPop(id, botao){
    fecharPop();
    var p = document.createElement('div'); p.setAttribute('data-dd-aval-pop', '1'); p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Avaliar a resposta da Sofia');
    var t = document.createElement('b'); t.textContent = 'O que a Sofia errou?';
    var ta = document.createElement('textarea'); ta.maxLength = 600; ta.placeholder = 'Ex.: devia ter dito o valor antes de perguntar da dor';
    var er = document.createElement('div'); er.className = 'erro'; er.hidden = true;
    var linha = document.createElement('div'); linha.className = 'linha';
    var cancelar = document.createElement('button'); cancelar.type = 'button'; cancelar.textContent = 'Cancelar'; cancelar.onclick = fecharPop;
    var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'pri'; ok.textContent = 'Enviar 👎';
    var dica = document.createElement('small'); dica.textContent = 'Vai para Agente › Para revisar. O paciente não vê.';
    ok.onclick = function(){
      var txt = ta.value.trim(); if (txt.length < 5) { er.textContent = 'Escreva em poucas palavras o que estava errado.'; er.hidden = false; ta.focus(); return; }
      ok.disabled = true; er.hidden = true;
      enviarAval(id, 'ruim', txt).then(function(){ p.textContent = ''; var f = document.createElement('b'); f.textContent = 'Anotado ✓'; var d = document.createElement('small'); d.textContent = 'Aparece em Agente › Para revisar.'; p.appendChild(f); p.appendChild(d); setTimeout(fecharPop, 1600); })
        .catch(function(e){ er.textContent = e.message; er.hidden = false; ok.disabled = false; });
    };
    ta.addEventListener('keydown', function(ev){ if (ev.key === 'Escape') fecharPop(); if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') ok.click(); });
    linha.appendChild(cancelar); linha.appendChild(ok);
    p.appendChild(t); p.appendChild(ta); p.appendChild(er); p.appendChild(linha); p.appendChild(dica);
    document.body.appendChild(p);
    var r = botao.getBoundingClientRect(), alto = p.offsetHeight || 190;
    p.style.left = Math.max(12, Math.min(r.right - 300, window.innerWidth - 312)) + 'px';
    p.style.top = (r.bottom + 6 + alto > window.innerHeight ? Math.max(12, r.top - alto - 6) : r.bottom + 6) + 'px';
    AV.pop = p; ta.focus();
  }
  document.addEventListener('mousedown', function(ev){ if (AV.pop && !AV.pop.contains(ev.target) && !(ev.target.closest && ev.target.closest('[data-dd-aval]'))) fecharPop(); }, true);
  function barraDeAval(id){
    var barra = document.createElement('div'); barra.setAttribute('data-dd-aval', id);
    var rot = document.createElement('span'); rot.textContent = 'Sofia';
    var boa = document.createElement('button'); boa.type = 'button'; boa.className = 'boa'; boa.title = 'Resposta boa'; boa.setAttribute('aria-label', 'Resposta da Sofia boa'); boa.innerHTML = SVG_BOA;
    var ruim = document.createElement('button'); ruim.type = 'button'; ruim.className = 'ruim'; ruim.title = 'Resposta ruim: conte o que estava errado'; ruim.setAttribute('aria-label', 'Resposta da Sofia ruim'); ruim.innerHTML = SVG_RUIM;
    boa.onclick = function(ev){ ev.stopPropagation(); fecharPop(); boa.disabled = true; enviarAval(id, 'boa', '').catch(function(){}).then(function(){ boa.disabled = false; }); };
    ruim.onclick = function(ev){ ev.stopPropagation(); abrirPop(id, ruim); };
    barra.appendChild(rot); barra.appendChild(boa); barra.appendChild(ruim);
    return barra;
  }
  function marcarBaloes(){
    var c = conversaDaUrl();
    if (!ligada || !c) { if (AV.conversa) { AV.conversa = null; AV.mapa = {}; fecharPop(); } return; }
    if (c !== AV.conversa) { AV.conversa = c; AV.mapa = {}; AV.proxima = 0; AV.qtd = -1; fecharPop(); }
    var qtd = document.querySelectorAll('.message-bubble-container[data-message-id]').length;
    var chegouMensagem = AV.qtd !== -1 && qtd !== AV.qtd && Date.now() - AV.ultima > 5000;
    AV.qtd = qtd;
    if ((Date.now() >= AV.proxima || chegouMensagem) && document.visibilityState === 'visible') { AV.ultima = Date.now(); lerAvaliacoes(c); }
    estiloAval();
    Array.prototype.forEach.call(document.querySelectorAll('.message-bubble-container[data-message-id]'), function(cont){
      var id = cont.getAttribute('data-message-id'), x = AV.mapa[id]; if (!x) return;
      var area = cont.querySelector('[class*="grid-area:bubble"]'), balao = area && area.lastElementChild;
      if (!balao || balao.querySelector('[data-dd-aval]')) return;
      var barra = barraDeAval(id); balao.appendChild(barra); pintarAval(barra, x);
    });
  }

  window.addEventListener('message', function(ev){
    if (ev.origin !== AGENTE || !fr || ev.source !== fr.contentWindow) return;
    var d = ev.data; if (!d || typeof d.event !== 'string') return;
    if (d.event === 'assistente:pede-sessao') falar({ event: 'assistente-sessao', sessao: sessao(), conversa: conversa });
    else if (d.event === 'assistente:minimizar') minimizar();
    else if (d.event === 'assistente:abrir-testar-ia') {
      // abre a tela "Agente" pelo próprio item do menu (o rascunho da lição já foi deixado no armazenamento do agente)
      var it = document.querySelector('[data-ia-menu] a') || document.querySelector('[data-ia-menu]'); if (it) it.click();
    }
    else if (d.event === 'assistente:inserir' && typeof d.texto === 'string' && d.texto.length <= 4000) {
      var r = inserir(d.texto, d.substituir === true);
      falar({ event: 'assistente-inserido', ok: r.ok, motivo: r.motivo || null });
    }
  });
  window.addEventListener('resize', posicao);
  setInterval(function(){
    if (!emConta()) { if (botao) botao.style.display = 'none'; if (painel) painel.style.display = 'none'; return; }
    conferir();
    if (botao) { botao.style.display = 'flex'; if (painel) painel.style.display = estavaAberto() ? 'block' : 'none'; }
    var c = conversaDaUrl();
    if (c !== conversa) { conversa = c; falar({ event: 'assistente-conversa', conversa: c }); }
    posicao();
    try { marcarBaloes(); } catch (e) {}
  }, 1000);
})();`;

/** O JavaScript do botão. Tem `__AGENTE__` no lugar do endereço do servidor (quem monta troca por um texto JSON). */
export function assistenteJs(): string {
  return BOTAO_JS;
}

/** A página do painel (iframe). `__ORIGEM_CW__` = a origem do Chatwoot (JSON). */
export function paginaDaAssistente(origemChatwoot: string): string {
  return PAGINA.split('__ORIGEM_CW__').join(JSON.stringify(origemChatwoot));
}

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Assistente · Doutor Digital</title>
<style>
:root{--azul:#1f93ff;--linha:#e4e7ec;--txt:#1f2d3d;--fraco:#64748b;--suave:#f1f4f8}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--txt);background:#fff}
button,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--azul);outline-offset:1px}
.topo{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--linha)}
.topo b{font-size:14px}.topo small{color:var(--fraco);flex:1}
.x{border:0;background:transparent;font-size:18px;cursor:pointer;color:var(--fraco);padding:2px 6px}
.bt{min-height:34px;padding:6px 12px;white-space:nowrap;flex-shrink:0;line-height:1.2;border-radius:8px;border:1px solid var(--linha);background:#fff;cursor:pointer;font-weight:600;font-size:13px}
.bt.azul{background:var(--azul);border-color:var(--azul);color:#fff}
.bt:disabled{opacity:.5;cursor:default}
.acao{padding:10px 12px;border-bottom:1px solid var(--linha);display:flex;gap:8px;align-items:center}
.pausa{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--linha);font-size:12.5px}
.pausa[hidden]{display:none}
.aval{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--linha);font-size:12.5px;color:var(--fraco)}
.aval[hidden]{display:none}.aval span{flex:1}.aval .bt{min-height:26px;padding:2px 9px;font-size:13px}
.ruim{padding:8px 12px;border-bottom:1px solid var(--linha);background:#fff}.ruim[hidden]{display:none}
.ruim textarea{width:100%;height:64px;margin:6px 0}.ruim .bts{display:flex;gap:6px;flex-wrap:wrap}
.pausa .ponto{width:8px;height:8px;border-radius:50%;background:#12855a;flex-shrink:0}
.pausa.on .ponto{background:#b54708}
.pausa span{flex:1;min-width:0;color:var(--txt)}
.pausa .bt{min-height:28px;padding:3px 10px;font-size:12.5px}
.acao small{color:var(--fraco);flex:1;min-width:0;line-height:1.3}
.lista{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--suave)}
.m{max-width:92%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.m.eu{align-self:flex-end;background:var(--azul);color:#fff;border-bottom-right-radius:3px}
.m.ia{align-self:flex-start;background:#fff;border:1px solid var(--linha);border-bottom-left-radius:3px}
.m.sis{align-self:center;color:var(--fraco);font-size:12.5px;text-align:center;background:transparent}
.m small{display:block;margin-top:6px;color:var(--fraco);font-size:11.5px}
.sug{align-self:stretch;background:#fff;border:1px solid var(--azul);border-radius:12px;padding:10px 12px}
.sug .t{white-space:pre-wrap;overflow-wrap:anywhere}
.sug .bts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.sug .nota,.sug .aviso{margin-top:8px;padding:6px 8px;border-radius:8px;font-size:12.5px}
.sug .nota{background:#eef6ff}.sug .aviso{background:#fff4e5;color:#8a4b00}
.sug .estado{margin-top:6px;font-size:12.5px;color:var(--fraco)}
form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--linha);background:#fff}
textarea{flex:1;resize:none;height:40px;max-height:96px;padding:8px 10px;border:1px solid var(--linha);border-radius:8px}
</style></head><body>
<div class="topo"><b>Assistente</b><small id="un"></small><button class="x" id="min" type="button" title="Minimizar" aria-label="Minimizar">–</button></div>
<div class="aval" id="aval" hidden><span>A última resposta da Sofia foi:</span><button class="bt" id="avBoa" type="button" title="Boa resposta">👍 Boa</button><button class="bt" id="avRuim" type="button" title="Resposta ruim">👎 Ruim</button></div>
<div class="ruim" id="ruim" hidden><b>O que estava errado?</b><textarea id="ruimTxt" maxlength="600" placeholder="Ex.: ela não respondeu se aceita plano; devia dizer que é particular e oferecer horários."></textarea><div class="bts"><button class="bt azul" id="ruimEnv" type="button">Enviar avaliação</button><button class="bt" id="ruimLicao" type="button">Transformar em lição</button><button class="bt" id="ruimCancela" type="button">Cancelar</button></div><small id="ruimEst"></small></div>
<div class="pausa" id="pausa" hidden><i class="ponto" aria-hidden="true"></i><span id="pausaTxt">IA ativa nesta conversa</span><button class="bt" id="pausaBt" type="button">Pausar IA (eu assumo)</button></div>
<div class="acao"><button class="bt azul" id="sug" type="button" disabled>O que eu respondo?</button><small id="dica">Abra uma conversa para eu sugerir uma resposta.</small></div>
<div class="lista" id="lista" aria-live="polite"><div class="m sis">Eu não envio nada ao paciente: sugiro respostas e tiro dúvidas. Pausar ou reativar a IA é no botão acima. Pergunte, por exemplo: como marco perdido? qual o valor? tem horário amanhã de manhã?</div></div>
<form id="f"><textarea id="q" placeholder="Tire uma dúvida…" maxlength="1000" aria-label="Sua dúvida"></textarea><button class="bt azul" id="env" type="submit">Enviar</button></form>
<script>
(function(){
  var ORIGEM_CW = __ORIGEM_CW__, S = null, conversa = null, ocupado = false, historico = [], pedindo = 0, pendente = null;
  var $ = function(id){ return document.getElementById(id); };
  var lista = $('lista'), sug = $('sug'), dica = $('dica'), q = $('q'), env = $('env');
  function pai(msg){ try { window.parent.postMessage(msg, ORIGEM_CW); } catch (e) {} }
  function pedirSessao(){ pai({ event: 'assistente:pede-sessao' }); }
  function rolar(){ lista.scrollTop = lista.scrollHeight; }
  function bolha(cls, texto, extra){
    var d = document.createElement('div'); d.className = 'm ' + cls; d.textContent = texto;
    if (extra) { var s = document.createElement('small'); s.textContent = extra; d.appendChild(s); }
    lista.appendChild(d); rolar(); return d;
  }
  function atualizar(){
    sug.disabled = ocupado || !S || !conversa; env.disabled = ocupado || !S;
    dica.textContent = !S ? 'Entrando…' : conversa ? 'Leio a conversa aberta e escrevo uma proposta para você revisar.' : 'Abra uma conversa para eu sugerir uma resposta.';
  }
  function cab(){ return { 'Content-Type': 'application/json', 'X-CW-Token': S.token, 'X-CW-Client': S.client, 'X-CW-Uid': S.uid }; }
  function chamar(caminho, corpo){
    return fetch(caminho, { method: 'POST', headers: cab(), body: JSON.stringify(corpo) }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        if (r.status === 401) { S = null; atualizar(); pedirSessao(); }
        return { ok: r.ok, status: r.status, j: j };
      });
    });
  }
  function copiar(texto, estado){
    function ok(){ estado.textContent = 'Copiado.'; }
    function velho(){
      var t = document.createElement('textarea'); t.value = texto; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
      var certo = false; try { certo = document.execCommand('copy'); } catch (e) {} t.remove(); estado.textContent = certo ? 'Copiado.' : 'Não consegui copiar: selecione o texto e use Ctrl+C.';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(ok, velho); else velho();
  }
  function cartaoSugestao(j){
    var c = document.createElement('div'); c.className = 'sug';
    var t = document.createElement('div'); t.className = 't'; t.textContent = j.sugestao; c.appendChild(t);
    (j.avisos || []).forEach(function(a){ var d = document.createElement('div'); d.className = 'aviso'; d.textContent = a; c.appendChild(d); });
    if (j.nota) { var n = document.createElement('div'); n.className = 'nota'; n.textContent = 'Para você: ' + j.nota; c.appendChild(n); }
    var bts = document.createElement('div'); bts.className = 'bts';
    var estado = document.createElement('div'); estado.className = 'estado';
    var por = document.createElement('button'); por.type = 'button'; por.className = 'bt azul'; por.textContent = 'Colocar no campo de resposta';
    por.onclick = function(){ estado.textContent = ''; pendente = { texto: j.sugestao, estado: estado, bts: bts }; pai({ event: 'assistente:inserir', texto: j.sugestao }); };
    var cp = document.createElement('button'); cp.type = 'button'; cp.className = 'bt'; cp.textContent = 'Copiar'; cp.onclick = function(){ copiar(j.sugestao, estado); };
    var outra = document.createElement('button'); outra.type = 'button'; outra.className = 'bt'; outra.textContent = 'Outra sugestão'; outra.onclick = sugerir;
    bts.appendChild(por); bts.appendChild(cp); bts.appendChild(outra); c.appendChild(bts); c.appendChild(estado);
    if (j.fontes && j.fontes.length) { var f = document.createElement('div'); f.className = 'estado'; f.textContent = 'Fontes: ' + j.fontes.join(' · '); c.appendChild(f); }
    lista.appendChild(c); rolar();
  }
  // ── pausa da IA nesta conversa ──
  var pausaEl = $('pausa'), pausaTxt = $('pausaTxt'), pausaBt = $('pausaBt'), pausada = false, lendoPausa = 0;
  function hora(iso){ try { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function mostrarPausa(j){
    if (!j || typeof j.pausada !== 'boolean') { pausaEl.hidden = true; return; }
    pausada = j.pausada; pausaEl.hidden = false; pausaEl.className = 'pausa' + (pausada ? ' on' : '');
    pausaTxt.textContent = pausada ? 'IA pausada' + (j.por ? ' por ' + j.por : '') + (j.em ? ' · ' + hora(j.em) : '') : 'IA ativa nesta conversa';
    pausaBt.textContent = pausada ? 'Reativar IA' : 'Pausar IA (eu assumo)';
    pausaBt.className = pausada ? 'bt azul' : 'bt';
  }
  function lerPausa(){
    if (!S || !conversa) { pausaEl.hidden = true; return; }
    var meu = ++lendoPausa, c = conversa;
    fetch('/api/public/assistente/pausa?conversa=' + encodeURIComponent(c), { headers: cab() }).then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ if (meu === lendoPausa && c === conversa) mostrarPausa(j); }).catch(function(){ if (meu === lendoPausa) pausaEl.hidden = true; });
  }
  // ── avaliar a última resposta da Sofia (👍/👎); 👎 vira nota para a equipe e pode virar lição (com prévia, na tela Agente) ──
  var aval = $('aval'), ruim = $('ruim');
  function mostrarAval(){ aval.hidden = !(S && conversa); if (aval.hidden) ruim.hidden = true; }
  function avaliar(nota, texto){
    return chamar('/api/public/assistente/avaliar', { conversa: conversa, nota: nota, texto: texto || '' });
  }
  $('avBoa').onclick = function(){
    var b = this; b.disabled = true;
    avaliar('boa').then(function(r){ b.textContent = r.ok ? '👍 Obrigada!' : '👍 Boa'; setTimeout(function(){ b.textContent = '👍 Boa'; b.disabled = false; }, 2500); });
  };
  $('avRuim').onclick = function(){ ruim.hidden = false; $('ruimEst').textContent = ''; $('ruimTxt').focus(); };
  $('ruimCancela').onclick = function(){ ruim.hidden = true; };
  $('ruimEnv').onclick = function(){
    var t = $('ruimTxt').value.trim(); if (t.length < 5) { $('ruimEst').textContent = 'Escreva o que estava errado.'; return; }
    var b = this; b.disabled = true;
    avaliar('ruim', t).then(function(r){ $('ruimEst').textContent = r.ok ? 'Avaliação registrada na conversa (nota para a equipe). Para a Sofia mudar de verdade, use “Transformar em lição”.' : (r.j.error || 'Não consegui registrar agora.'); }).then(function(){ b.disabled = false; });
  };
  $('ruimLicao').onclick = function(){
    var t = $('ruimTxt').value.trim(); if (t.length < 10) { $('ruimEst').textContent = 'Escreva como ela deveria ter respondido (pelo menos 10 letras).'; return; }
    try { localStorage.setItem('testar-ia-rascunho', t.slice(0, 400)); } catch (e) {}
    pai({ event: 'assistente:abrir-testar-ia' });
    $('ruimEst').textContent = 'Abri a tela “Agente” com a lição preenchida: teste e salve.';
  };
  pausaBt.onclick = function(){
    if (!S || !conversa) return;
    pausaBt.disabled = true;
    chamar('/api/public/assistente/pausa', { conversa: conversa, acao: pausada ? 'reativar' : 'pausar' }).then(function(r){
      if (r.ok) mostrarPausa(r.j); else if (r.status !== 401) bolha('sis', r.j.error || 'Não consegui mudar a pausa agora.');
    }).catch(function(){ bolha('sis', 'Sem conexão com a assistente. Tente de novo.'); }).then(function(){ pausaBt.disabled = false; });
  };
  function sugerir(){
    if (ocupado || !S || !conversa) return;
    ocupado = true; atualizar();
    var espera = bolha('sis', 'Lendo a conversa…');
    chamar('/api/public/assistente/sugerir', { conversaId: conversa }).then(function(r){
      espera.remove();
      if (r.ok && r.j.semSugestao) bolha('sis', r.j.aviso || 'Não sugiro resposta para esta conversa.');
      else if (r.ok) cartaoSugestao(r.j);
      else if (r.status !== 401) bolha('sis', r.j.error || 'Não consegui agora. Tente de novo.');
    }).catch(function(){ espera.remove(); bolha('sis', 'Sem conexão com a assistente. Tente de novo.'); })
      .then(function(){ ocupado = false; atualizar(); });
  }
  function perguntar(pergunta){
    if (ocupado || !S) return;
    ocupado = true; atualizar(); bolha('eu', pergunta);
    var espera = bolha('sis', 'Procurando…');
    chamar('/api/public/assistente/perguntar', { pergunta: pergunta, conversaId: conversa, historico: historico.slice(-8) }).then(function(r){
      espera.remove();
      if (r.ok) {
        historico.push({ role: 'user', content: pergunta }, { role: 'assistant', content: r.j.resposta });
        bolha('ia', r.j.resposta, r.j.fontes && r.j.fontes.length ? 'Fontes: ' + r.j.fontes.join(' · ') : '');
      } else if (r.status !== 401) bolha('sis', r.j.error || 'Não consegui agora. Tente de novo.');
    }).catch(function(){ espera.remove(); bolha('sis', 'Sem conexão com a assistente. Tente de novo.'); })
      .then(function(){ ocupado = false; atualizar(); q.focus(); });
  }
  $('f').addEventListener('submit', function(e){ e.preventDefault(); var t = q.value.trim(); if (t.length < 2) return; q.value = ''; perguntar(t); });
  q.addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('f').requestSubmit(); } });
  sug.addEventListener('click', sugerir);
  $('min').addEventListener('click', function(){ pai({ event: 'assistente:minimizar' }); });
  window.addEventListener('message', function(ev){
    if (ev.origin !== ORIGEM_CW || ev.source !== window.parent) return;
    var d = ev.data; if (!d || typeof d.event !== 'string') return;
    if (d.event === 'assistente-sessao') {
      S = d.sessao && d.sessao.token ? d.sessao : null; if (typeof d.conversa === 'number' || d.conversa === null) conversa = d.conversa;
      if (!S && pedindo < 3) { pedindo++; setTimeout(pedirSessao, 1500); }
      atualizar(); lerPausa(); mostrarAval();
    } else if (d.event === 'assistente-conversa') {
      conversa = typeof d.conversa === 'number' ? d.conversa : null; atualizar(); lerPausa(); mostrarAval(); ruim.hidden = true; $('ruimTxt').value = '';
    } else if (d.event === 'assistente-inserido' && pendente) {
      var p = pendente; pendente = null;
      if (d.ok) { p.estado.textContent = 'Está no campo de resposta. Revise e envie você.'; return; }
      if (d.motivo === 'ocupado') {
        p.estado.textContent = 'Já tem texto escrito no campo. ';
        var sub = document.createElement('button'); sub.type = 'button'; sub.className = 'bt'; sub.textContent = 'Trocar pelo texto sugerido';
        sub.onclick = function(){ sub.remove(); pendente = p; pai({ event: 'assistente:inserir', texto: p.texto, substituir: true }); };
        p.estado.appendChild(sub);
      } else if (d.motivo === 'nota-privada') p.estado.textContent = 'O campo está em "Nota privada". Mude para "Responder" e tente de novo, ou use Copiar.';
      else p.estado.textContent = 'Não achei o campo de resposta com segurança. Use Copiar e cole.';
    }
  });
  atualizar(); pedirSessao();
})();
</script></body></html>`;
