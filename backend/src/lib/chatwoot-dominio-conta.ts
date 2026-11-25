/**
 * O endereço da clínica abre a conta DELA (pedido do João, 25/11/2026). O Chatwoot é UMA instalação com várias contas: quem tem mais de uma (as administradoras
 * da Doutor Digital) abre `drtimbo.doutordigitalconsultoria.com` e cai na última conta usada (ex.: /app/accounts/1 = Parauapebas).
 *
 * O servidor manda no `menu.js` só o mapa subdomínio → número da conta (nada além disso). No navegador, para o host de uma clínica (conta X):
 *  - na CHEGADA (1º carregamento desta aba; ou a aba estava fora de qualquer conta) em /app/accounts/Y com Y ≠ X, e se a pessoa TEM a conta X (confere o perfil
 *    da sessão, `GET /api/v1/profile`; nunca vai para conta sem acesso): vai para a mesma rota na conta X (`location.replace`, sem entrada no histórico; o `#hash`
 *    e a busca ficam; rota com número de recurso — conversa, contato — vai para o painel da conta X, porque o número é da conta Y);
 *  - se a pessoa TROCOU de conta de propósito pelo seletor com a aba aberta (a conta da URL mudou durante a sessão da aba; o último estado fica em
 *    `sessionStorage`), NÃO puxa de volta: mostra uma faixa discreta «Você está no endereço de <Clínica> vendo <Outra> — ir para <Clínica>?» com o botão;
 *  - sem laço: o redirecionamento acontece no máximo uma vez por aba e dentro de uma janela curta; se o Chatwoot devolver para Y, vira faixa;
 *  - domínio principal (atendimento.…) ou sem clínica no mapa: o bloco não faz nada; atendente com uma conta só: nada muda (não tem a conta X ou já está nela).
 * Os nomes da faixa vêm do PRÓPRIO perfil da pessoa (`accounts[].name`) e entram por `textContent`; nenhum dado de paciente. Claro e escuro (`html.dark` ou o aparelho).
 *
 * Bloco INDEPENDENTE do `menu.js` (`;try{ … }catch(e){}`): se falhar ao executar, o menu, a assistente, o guia e o selo seguem.
 */

// String.raw: o que está aqui é o JavaScript que o navegador recebe. Sem crases nem «${» aqui dentro.
const DOMINIO_CONTA_JS = String.raw`(function(){
  if (window.top !== window || window.__dominioContaDD) return; window.__dominioContaDD = 1;
  var MAPA = __MAPA__, SUFIXO = '.doutordigitalconsultoria.com', CHAVE = 'dd-dominio-conta', JANELA_MS = 15000;
  var host = String(location.hostname || '').toLowerCase();
  if (host.length <= SUFIXO.length || host.slice(-SUFIXO.length) !== SUFIXO) return;
  var sub = host.slice(0, -SUFIXO.length);
  var X = Object.prototype.hasOwnProperty.call(MAPA, sub) ? Number(MAPA[sub]) : 0;
  if (!X || X < 1) return; // domínio principal ou endereço sem clínica: nada muda

  // sem sessionStorage (bloqueado) não há como lembrar a chegada nem evitar laço: nada acontece
  try { sessionStorage.setItem(CHAVE + '-t', '1'); sessionStorage.removeItem(CHAVE + '-t'); } catch (e) { return; }
  function lerEstado(){ try { var j = JSON.parse(sessionStorage.getItem(CHAVE) || 'null'); return j && typeof j === 'object' ? j : null; } catch (e) { return null; } }
  function gravar(e){ try { sessionStorage.setItem(CHAVE, JSON.stringify(e)); } catch (err) {} }
  function contaDaUrl(){ var m = String(location.pathname || '').match(/\/accounts\/(\d+)/); return m ? Number(m[1]) : null; }
  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  // o mesmo caminho na conta X; rota com número de recurso (conversa, contato…) é da conta de origem: vai para o painel da conta X (sem a busca, que também é de lá)
  function destino(){
    var p = String(location.pathname || ''), m = p.match(/^(.*?\/accounts\/)(\d+)(\/.*)?$/);
    var base = m ? m[1] : '/app/accounts/', resto = m && m[3] ? m[3] : '/dashboard', busca = String(location.search || '');
    if (/\/\d/.test(resto)) { resto = '/dashboard'; busca = ''; }
    return base + X + resto + busca + String(location.hash || '');
  }

  var perfil = null, pedindoPerfil = null;
  // as contas DA PESSOA (id → nome), do perfil da própria sessão; sem sessão, sem rede ou resposta estranha = null (nada acontece)
  function contasDaPessoa(){
    if (perfil) return Promise.resolve(perfil);
    if (pedindoPerfil) return pedindoPerfil;
    var s = sessao(); if (!s) return Promise.resolve(null);
    pedindoPerfil = fetch('/api/v1/profile', { headers: { 'access-token': s.token, client: s.client, uid: s.uid } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(p){
        if (!p || !Array.isArray(p.accounts)) return null;
        var m = {}; p.accounts.forEach(function(a){ if (a && Number(a.id) > 0) m[Number(a.id)] = String(a.name || ''); });
        perfil = m; return m;
      })
      .catch(function(){ return null; })
      .then(function(r){ pedindoPerfil = null; return r; });
    return pedindoPerfil;
  }

  // ── a faixa (só aparece quando a pessoa está de propósito em outra conta); textContent, claro/escuro, nunca empurra o layout ──
  var faixa = null;
  function css(){
    if (document.getElementById('dd-dominio-css')) return;
    var st = document.createElement('style'); st.id = 'dd-dominio-css';
    st.textContent = '[data-dd-dominio]{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147482000;display:flex;align-items:center;gap:10px;max-width:min(720px,calc(100vw - 24px));'
      + 'padding:8px 10px 8px 14px;border-radius:10px;border:1px solid #e0b455;background:#fff6dd;color:#5a3d00;box-shadow:0 6px 24px rgba(0,0,0,.18);font:500 13px/1.35 Inter,-apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif}'
      + '[data-dd-dominio] button{font-size:12.5px;font-weight:600;line-height:1;font-family:inherit;border-radius:8px;cursor:pointer;min-height:30px;padding:0 12px;white-space:nowrap}'
      + '[data-dd-dominio] .dd-ir{border:1px solid #5a3d00;background:#5a3d00;color:#fff}'
      + '[data-dd-dominio] .dd-fechar{border:0;background:transparent;color:inherit;font-size:16px;padding:0 8px;min-width:30px}'
      + 'html.dark [data-dd-dominio]{border-color:#7a5a12;background:#3a2c0b;color:#fbe6b0}html.dark [data-dd-dominio] .dd-ir{border-color:#f0a030;background:#f0a030;color:#1a1200}'
      + '@media (prefers-color-scheme:dark){html:not(.light) [data-dd-dominio]{border-color:#7a5a12;background:#3a2c0b;color:#fbe6b0}html:not(.light) [data-dd-dominio] .dd-ir{border-color:#f0a030;background:#f0a030;color:#1a1200}}'
      + '@media (max-width:560px){[data-dd-dominio]{left:12px;right:12px;transform:none;max-width:none;flex-wrap:wrap}[data-dd-dominio] span{flex:1 1 100%}}';
    (document.head || document.documentElement).appendChild(st);
  }
  function sumirFaixa(){ if (faixa && faixa.parentNode) faixa.parentNode.removeChild(faixa); faixa = null; }
  function mostrarFaixa(Y, nomes){
    var est = lerEstado() || {};
    if (est.dispensou && est.dispensou[String(Y)]) return;
    sumirFaixa(); css();
    var clinica = nomes[X] || ('a clínica'), outra = nomes[Y] || ('a conta ' + Y);
    faixa = document.createElement('div'); faixa.setAttribute('data-dd-dominio', '1'); faixa.setAttribute('role', 'status');
    var t = document.createElement('span'); t.textContent = 'Você está no endereço de ' + clinica + ' vendo ' + outra + ' — ir para ' + clinica + '?'; faixa.appendChild(t);
    var ir = document.createElement('button'); ir.type = 'button'; ir.className = 'dd-ir'; ir.textContent = 'Ir para ' + clinica;
    ir.onclick = function(){ var e = lerEstado() || {}; e.conta = X; gravar(e); location.assign(destino()); };
    faixa.appendChild(ir);
    var f = document.createElement('button'); f.type = 'button'; f.className = 'dd-fechar'; f.setAttribute('aria-label', 'Fechar o aviso'); f.title = 'Fechar'; f.textContent = '×';
    f.onclick = function(){ var e = lerEstado() || {}; e.dispensou = e.dispensou || {}; e.dispensou[String(Y)] = 1; gravar(e); sumirFaixa(); };
    faixa.appendChild(f);
    (document.body || document.documentElement).appendChild(faixa);
  }

  // ── a decisão: chegada (redireciona) ou troca de propósito (faixa) ──
  function avaliar(chegada){
    var Y = contaDaUrl(), est = lerEstado();
    if (Y === null) { if (!est || est.conta !== null) { var e0 = est || {}; e0.conta = null; gravar(e0); } sumirFaixa(); return; } // fora de qualquer conta (login, perfil…): a próxima conta vista é uma CHEGADA
    if (Y === X) { var e1 = est || {}; e1.conta = X; gravar(e1); sumirFaixa(); return; }
    // Y ≠ X
    var antes = est && est.conta !== undefined ? est.conta : undefined; // undefined = 1º carregamento da aba; null = estava fora de conta
    var ehChegada = chegada && (antes === undefined || antes === null);
    var jaRedirecionou = est && est.redirecionouEm && (Date.now() - est.redirecionouEm) < JANELA_MS;
    contasDaPessoa().then(function(nomes){
      if (!nomes || !(X in nomes) || contaDaUrl() !== Y) return; // sem perfil, sem a conta X, ou já mudou de conta enquanto a resposta vinha: nada
      var e = lerEstado() || {};
      if (ehChegada && !jaRedirecionou) { e.conta = X; e.redirecionouEm = Date.now(); gravar(e); location.replace(destino()); return; }
      e.conta = Y; gravar(e); mostrarFaixa(Y, nomes);
    });
  }

  avaliar(true);
  // a troca de conta pelo seletor é navegação SEM recarregar: acompanha o endereço (history + popstate) e, de reserva, confere a cada 1,5 s (só compara texto)
  var ultimo = String(location.pathname);
  function mudou(){ var p = String(location.pathname); if (p === ultimo) return; ultimo = p; avaliar(false); }
  ['pushState', 'replaceState'].forEach(function(k){ var o = history[k]; if (typeof o !== 'function') return; history[k] = function(){ var r = o.apply(this, arguments); setTimeout(mudou, 0); return r; }; });
  window.addEventListener('popstate', mudou);
  setInterval(mudou, 1500);
})();`;

/** O mapa que vai para o navegador: SÓ subdomínio → número da conta (inteiro > 0). Qualquer outra coisa é descartada aqui. */
export function mapaParaOMenu(mapa: Readonly<Record<string, number>>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const [sub, conta] of Object.entries(mapa)) if (/^[a-z0-9]{3,40}$/.test(sub) && Number.isInteger(conta) && conta > 0) m[sub] = conta;
  return m;
}

/** O bloco para o `menu.js`; vazio se não há clínica no mapa (nada a fazer em nenhum endereço). */
export function dominioContaJs(mapa: Readonly<Record<string, number>>): string {
  const m = mapaParaOMenu(mapa);
  if (!Object.keys(m).length) return '';
  return DOMINIO_CONTA_JS.split('__MAPA__').join(JSON.stringify(m).replace(/</g, '\\u003c'));
}
