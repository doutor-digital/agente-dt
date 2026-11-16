/**
 * A tela «Disparos» do menu do Chatwoot (16/11/2026): o «Broadcast» do CRM. Três passos numa página só — Público (filtro + contagem + quem sai e
 * por quê), Mensagem (modelo APROVADO da caixa, variáveis, prévia por pessoa) e Revisão (montar, aprovar, acompanhar). Mesmo visual das telas
 * Robôs/Agente: Inter, os mesmos tokens de cor, claro/escuro pelo navegador.
 *
 * A sessão chega do menu do Chatwoot por postMessage (`funil:pede-sessao` → `funil-sessao`, com checagem de origem), como nas outras telas;
 * a conta vem do `?conta=N` do iframe (só um PEDIDO: o servidor confere). Todo texto que vem do servidor entra por textContent (nunca
 * innerHTML). O JavaScript não usa crase nem `${`: a página é um String.raw e só `__ORIGEM_CW__` e `__LOGO_DD__` são trocados.
 */
import { LOGO_DD_PNG } from './marca-dd.js';
import { comContaNaPagina } from './conta-no-navegador.js';

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Disparos</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap" rel="stylesheet">
<style>
:root{--app:#f7f7f7;--side:#fff;--canvas:#f0f0f3;--node:#fff;--ink:#1c2024;--ink-2:#60646c;--line:#e2e3e7;--brand:#2781f6;--brand-soft:#e9f3ff;--send:#29a71a;--stop:#8b8d98;--ruim:#ca244d;--aviso:#8f5300;--aviso-forte:#ffb224;--bubble:#d9fdd3;--bubble-ink:#10261a;--chat:#efeae2;--shadow:0 1px 2px rgba(28,32,36,.06),0 6px 18px rgba(28,32,36,.08);--f-ui:Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif;--f-head:Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--app:#1c1d20;--side:#17171a;--canvas:#18191b;--node:#1d1e24;--ink:#edeef0;--ink-2:#b0b4ba;--line:#2e2d32;--brand:#2781f6;--brand-soft:#0f2748;--ruim:#ff6b8f;--aviso:#ffca16;--bubble:#005c4b;--bubble-ink:#e9fff6;--chat:#0b141a;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px rgba(0,0,0,.35)}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--app);color:var(--ink);font:14px/1.45 var(--f-ui);display:grid;grid-template-rows:auto auto 1fr;min-height:100%;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
[hidden]{display:none!important}
.topo{display:flex;align-items:center;gap:10px;padding-block:12px;flex-wrap:wrap}
.logo{width:28px;height:28px;display:block;flex:none}
.topo .mig{color:var(--ink-2);font-size:13px}.topo b{font:600 15px var(--f-head)}
.topo .un{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--ink-2);font-size:13px}
select,input[type=text],input[type=number]{font:500 13px var(--f-ui);color:var(--ink);background:var(--node);border:1px solid var(--line);border-radius:8px;padding:7px 9px;max-width:100%}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font:600 12px var(--f-ui);background:var(--brand-soft);color:var(--brand)}
.pill.seco{background:color-mix(in srgb,var(--aviso-forte) 22%,transparent);color:var(--aviso)}
.pill.vivo{background:color-mix(in srgb,var(--send) 18%,transparent);color:var(--send)}
.pill.off,.pill.mudo{background:var(--app);color:var(--ink-2);border:1px solid var(--line)}
.pill.ruim{background:color-mix(in srgb,var(--ruim) 15%,transparent);color:var(--ruim)}
.faixa{margin:0 0 12px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--node);font-size:13px}
.faixa.seco{border-color:var(--aviso-forte);background:color-mix(in srgb,var(--aviso-forte) 12%,var(--node))}
.faixa.vivo{border-color:var(--send)}
.faixa.erro{border-color:var(--ruim);color:var(--ruim)}
.app{display:grid;grid-template-columns:300px minmax(0,1fr);border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--side);min-height:640px;margin-bottom:16px}
@media (max-width:860px){.app{grid-template-columns:1fr}.lado{max-height:280px;border-right:0!important;border-bottom:1px solid var(--line)}}
.lado{border-right:1px solid var(--line);display:grid;grid-template-rows:auto 1fr;min-height:0}
.lado-cab{display:flex;gap:8px;align-items:center;padding:14px}.lado-cab h1{margin:0;font:700 20px var(--f-head);flex:1}
.bt{appearance:none;border:0;border-radius:9px;padding:8px 13px;font:600 13px var(--f-ui);cursor:pointer;display:inline-flex;gap:6px;align-items:center;white-space:nowrap}
.bt.pri{background:var(--brand);color:#fff}.bt.sec{background:var(--node);color:var(--ink);border:1px solid var(--line)}.bt.perigo{background:var(--node);color:var(--ruim);border:1px solid var(--ruim)}
.bt:disabled{opacity:.5;cursor:default}
.bt:focus-visible,.item:focus-visible,select:focus-visible,input:focus-visible,.chip:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.lista{overflow-y:auto;padding:0 8px 14px;min-height:0}
.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:9px 10px;border-radius:9px;cursor:pointer}
.item:hover{background:var(--app)}.item[aria-current=true]{background:var(--brand-soft)}
.item b{font:600 13px var(--f-ui);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item small{color:var(--ink-2);font-size:12px;grid-column:1/-1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.palco{background:var(--canvas);padding:18px;overflow:auto;min-width:0}
.col{display:grid;gap:14px;max-width:880px}
.card{background:var(--node);border:1px solid var(--line);border-radius:14px;padding:16px;display:grid;gap:12px;box-shadow:var(--shadow)}
.card h2{margin:0;font:700 17px var(--f-head);display:flex;gap:10px;align-items:center}
.card h2 .n{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--brand);color:#fff;font:700 12px var(--f-ui)}
.card p{margin:0;color:var(--ink-2)}
.campo{display:grid;gap:6px}.campo>label,.campo>.rot{font:600 12px var(--f-ui);letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{appearance:none;border:1px solid var(--line);background:var(--app);color:var(--ink);border-radius:999px;padding:4px 11px;font:500 12.5px var(--f-ui);cursor:pointer}
.chip[aria-pressed=true]{background:var(--brand-soft);border-color:var(--brand);color:var(--brand);font-weight:600}
.chip.fora[aria-pressed=true]{background:color-mix(in srgb,var(--ruim) 14%,transparent);border-color:var(--ruim);color:var(--ruim)}
.linha{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.fatos{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.fatos div{background:var(--app);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column}.fatos b{font:700 22px var(--f-head);font-variant-numeric:tabular-nums}.fatos span{color:var(--ink-2);font-size:12.5px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}th{font:600 11px var(--f-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2)}
.rolar{overflow-x:auto;max-height:340px;overflow-y:auto}
.zap{background:var(--chat);border-radius:12px;padding:14px;display:grid;gap:8px}
.zap .bal{background:var(--bubble);color:var(--bubble-ink);border-radius:10px 10px 10px 2px;padding:9px 12px;white-space:pre-wrap;max-width:420px;box-shadow:0 1px 1px rgba(0,0,0,.12)}
.mudo{color:var(--ink-2)}.ruim{color:var(--ruim)}.bom{color:var(--send)}
.vazio{padding:24px;color:var(--ink-2)}
.toast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--app);padding:9px 16px;border-radius:10px;font-size:13px;z-index:50;max-width:92vw}
.toast.erro{background:#ca244d;color:#fff}
ul.lis{margin:0;padding-left:1.2em;display:grid;gap:3px}
</style></head><body>
<div class="topo"><img class="logo" src="__LOGO_DD__" alt="Doutor Digital" width="28" height="28"><span class="mig">Doutor Digital Atende ›</span><b>Disparos</b>
  <span class="un"><span id="modo" class="pill off" hidden></span><span id="papel" class="pill mudo" hidden></span><select id="unidadeSel" hidden aria-label="Unidade"></select><span id="unidadeNome"></span></span></div>
<div id="avisos"></div>
<div class="app" id="corpo" hidden>
  <aside class="lado" aria-label="Seus disparos">
    <div class="lado-cab"><h1>Disparos</h1><button class="bt sec" type="button" id="btRel">Relatório</button><button class="bt pri" type="button" id="btNovo">+ Novo</button></div>
    <nav class="lista" id="lista"></nav>
  </aside>
  <main class="palco" id="palco"></main>
</div>
<div id="toast" class="toast" role="status" hidden></div>
<script>
(function(){
  var CW = __ORIGEM_CW__, S = null, U = null, UNIDADES = [], D = null, OPC = null, ONDA = null, atualId = null, tPoll = null;
  var F = null, CONTA_PREVIA = null, ESCOLHA = null;
  var $ = function(id){ return document.getElementById(id); };
  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function limpar(n){ while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function guardar(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function lerGuardado(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }
  var tToast = null;
  function toast(txt, erro){ var t = $('toast'); t.textContent = txt; t.className = 'toast' + (erro ? ' erro' : ''); t.hidden = false; clearTimeout(tToast); tToast = setTimeout(function(){ t.hidden = true; }, 4600); }
  function aviso(txt, erro){ var a = $('avisos'); limpar(a); if (txt) a.appendChild(el('div', 'faixa' + (erro ? ' erro' : ''), txt)); }

  // ── servidor (com o login do Chatwoot de quem está usando) ──
  /*__CONTA_JS__*/
  function cab(){ var h = { 'Content-Type': 'application/json' }; if (S) { h['X-CW-Token'] = S.token; h['X-CW-Client'] = S.client; h['X-CW-Uid'] = S.uid; } return h; }
  function pedirSessao(){ try { window.parent.postMessage({ event: 'funil:pede-sessao' }, CW); } catch (e) {} }
  async function api(method, path, body){
    var r = await fetch(comConta(path), { method: method, headers: cab(), body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { var er = new Error(j.error || ('erro ' + r.status)); if (r.status === 401) { S = null; pedirSessao(); } throw er; }
    return j;
  }
  function enc(x){ return encodeURIComponent(x); }
  function quando(iso){
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', ''); } catch (e) { return d.toISOString().slice(5, 16); }
  }
  var ESTADO = { montando: 'montando a lista…', montada: 'esperando aprovação', aprovada: 'aprovada', pausada: 'PAUSADA', concluida: 'concluída', cancelada: 'cancelada' };
  var CLASSE = { montando: 'mudo', montada: 'seco', aprovada: 'vivo', pausada: 'ruim', concluida: 'vivo', cancelada: 'off' };
  var ROTULO_ESTADO = { pendente: 'pendente', enviando: 'enviando…', enviado: 'enviado', falhou: 'FALHOU', saiu: 'pediu SAIR', descartado: 'descartado' };

  // ── cabeçalho: modo da unidade e quem sou ──
  function cabecalho(){
    var m = $('modo'); m.hidden = false;
    m.className = 'pill ' + (D.modo === 'ligado' ? 'vivo' : D.modo === 'seco' ? 'seco' : 'off');
    m.textContent = D.modo === 'ligado' ? 'LIGADO' : D.modo === 'seco' ? 'MODO SECO: nada é enviado' : 'DESLIGADO';
    var p = $('papel'); p.hidden = false;
    p.textContent = D.podeAprovar ? 'Você aprova disparos' : 'Você monta; a aprovação é da administração';
  }
  function faixaDoModo(){
    var f = D.freios, t = f.tetoDoTier ? ' O número está no ' + f.tier + ' da Meta.' : '';
    if (D.modo === 'seco') return 'MODO SECO. Montar e aprovar NÃO manda mensagem nenhuma: o sistema confere a lista, aplica todas as regras e anota quem receberia. Nada sai até a Doutor Digital ligar os disparos desta unidade.';
    if (D.modo === 'desligado') return 'Os disparos estão DESLIGADOS nesta unidade.';
    return 'LIGADO. Depois de aprovado, o envio sai em ondas, dentro da janela de ' + f.janela + ', no máximo ' + f.tetoPorHora + ' por hora e ' + f.tetoPorDia + ' por 24 horas.' + t;
  }

  // ── a lista à esquerda ──
  function desenharLista(){
    var l = limpar($('lista'));
    if (!D.disparos.length) { l.appendChild(el('div', 'vazio', 'Nenhum disparo ainda. Clique em «+ Novo».')); return; }
    D.disparos.forEach(function(o){
      var i = el('div', 'item'); i.tabIndex = 0; i.setAttribute('role', 'button');
      if (o.id === atualId) i.setAttribute('aria-current', 'true');
      i.appendChild(el('b', null, o.nome));
      i.appendChild(el('span', 'pill ' + (CLASSE[o.estado] || 'mudo'), ESTADO[o.estado] || o.estado));
      i.appendChild(el('small', null, o.total + ' pessoas · ' + o.enviados + ' enviadas · ' + quando(o.criadoEm)));
      i.addEventListener('click', function(){ abrirOnda(o.id); });
      i.addEventListener('keydown', function(ev){ if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrirOnda(o.id); } });
      l.appendChild(i);
    });
  }

  // ── NOVO DISPARO ──
  function filtroVazio(){ return { caixa: null, etiquetas: {}, atributos: {}, todas: false, dias: 0 }; }
  function filtroParaOServidor(){
    var inc = [], exc = [], at = {};
    Object.keys(F.etiquetas).forEach(function(k){ (F.etiquetas[k] === 'inc' ? inc : exc).push(k); });
    Object.keys(F.atributos).forEach(function(k){ var v = Object.keys(F.atributos[k]); if (v.length) at[k] = v; });
    return { caixa: F.caixa, etiquetasIncluir: inc, todasAsEtiquetas: F.todas, etiquetasExcluir: exc, atributos: at, semInteracaoDias: F.dias || 0 };
  }
  function pararPoll(){ clearTimeout(tPoll); tPoll = null; }
  function mostrarNovo(){
    pararPoll(); atualId = null; ONDA = null; F = filtroVazio(); CONTA_PREVIA = null; ESCOLHA = { modelo: null, fontes: [], texto: [] }; desenharLista();
    var p = limpar($('palco')), col = el('div', 'col'); p.appendChild(col);
    col.appendChild(el('div', 'faixa ' + (D.modo === 'ligado' ? 'vivo' : D.modo === 'seco' ? 'seco' : ''), faixaDoModo()));
    var oficiais = D.caixas.filter(function(c){ return c.oficial; });
    if (!oficiais.length) {
      var c0 = el('div', 'card'); c0.appendChild(el('h2', null, 'Sem caixa de WhatsApp oficial'));
      c0.appendChild(el('p', null, 'Os disparos só saem por uma caixa de WhatsApp oficial (a API da Meta). Esta unidade não tem nenhuma pronta:'));
      var ul = el('ul', 'lis'); D.caixas.forEach(function(c){ ul.appendChild(el('li', null, c.nome + ' — ' + (c.motivo || 'não é WhatsApp oficial'))); }); c0.appendChild(ul);
      col.appendChild(c0); return;
    }
    F.caixa = oficiais[0].id;

    // 1. Público
    var c1 = el('div', 'card'); var h1 = el('h2'); h1.appendChild(el('span', 'n', '1')); h1.appendChild(document.createTextNode('Quem recebe')); c1.appendChild(h1);
    var campoCaixa = el('div', 'campo'); campoCaixa.appendChild(el('label', null, 'Caixa de WhatsApp'));
    var sc = el('select'); oficiais.forEach(function(c){ var o = el('option', null, c.nome); o.value = String(c.id); sc.appendChild(o); });
    sc.addEventListener('change', function(){ F.caixa = Number(sc.value); carregarOpcoes(c1, c2); }); campoCaixa.appendChild(sc); c1.appendChild(campoCaixa);
    var area = el('div'); area.id = 'areaFiltro'; c1.appendChild(area);
    var linha = el('div', 'linha'); var btC = el('button', 'bt sec', 'Contar quem recebe'); btC.type = 'button'; btC.id = 'btContar'; linha.appendChild(btC); c1.appendChild(linha);
    var res = el('div'); res.id = 'resContagem'; c1.appendChild(res);
    col.appendChild(c1);
    btC.addEventListener('click', function(){ contar(btC, res); });

    // 2. Mensagem
    var c2 = el('div', 'card'); var h2 = el('h2'); h2.appendChild(el('span', 'n', '2')); h2.appendChild(document.createTextNode('Mensagem')); c2.appendChild(h2);
    var area2 = el('div'); area2.id = 'areaModelo'; c2.appendChild(area2); col.appendChild(c2);

    // 3. Montar
    var c3 = el('div', 'card'); var h3 = el('h2'); h3.appendChild(el('span', 'n', '3')); h3.appendChild(document.createTextNode('Montar o disparo')); c3.appendChild(h3);
    c3.appendChild(el('p', null, 'Montar lê cada conversa do público, confere quem pediu para sair e, se a unidade tem agenda da franquia, quem tem consulta marcada ou tratamento aberto. NADA é enviado ao montar: depois vem a aprovação.'));
    var cn = el('div', 'campo'); cn.appendChild(el('label', null, 'Nome da campanha')); var nome = el('input'); nome.type = 'text'; nome.maxLength = 80; nome.placeholder = 'Ex.: Reativação de perdidos — novembro'; nome.id = 'nomeCamp'; cn.appendChild(nome); c3.appendChild(cn);
    var btM = el('button', 'bt pri', 'Montar disparo'); btM.type = 'button'; btM.id = 'btMontar'; var l3 = el('div', 'linha'); l3.appendChild(btM); c3.appendChild(l3);
    col.appendChild(c3);
    btM.addEventListener('click', function(){ montar(btM, nome); });
    carregarOpcoes(c1, c2);
  }
  async function carregarOpcoes(c1, c2){
    var area = limpar($('areaFiltro')), area2 = limpar($('areaModelo'));
    area.appendChild(el('p', 'mudo', 'Carregando etiquetas e modelos…'));
    try { OPC = await api('GET', '/api/public/disparos/opcoes?slug=' + enc(U.slug) + '&caixa=' + F.caixa); }
    catch (e) { limpar(area); area.appendChild(el('p', 'ruim', e.message)); return; }
    F.etiquetas = {}; F.atributos = {}; F.todas = false; F.dias = 0; CONTA_PREVIA = null; ESCOLHA = { modelo: null, fontes: [], texto: [] }; limpar($('resContagem'));
    desenharFiltro(limpar(area)); desenharModelo(area2);
  }
  function grupoDeChips(titulo, ajuda){
    var c = el('div', 'campo'); c.appendChild(el('div', 'rot', titulo)); if (ajuda) c.appendChild(el('small', 'mudo', ajuda)); var chips = el('div', 'chips'); c.appendChild(chips); return { campo: c, chips: chips };
  }
  function desenharFiltro(area){
    var g = grupoDeChips('Etiquetas', 'Clique para incluir (azul), clique de novo para excluir (vermelho), de novo para limpar.');
    OPC.etiquetas.forEach(function(nome){
      var b = el('button', 'chip', nome); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function(){
        var a = F.etiquetas[nome];
        if (!a) { F.etiquetas[nome] = 'inc'; b.setAttribute('aria-pressed', 'true'); b.classList.remove('fora'); }
        else if (a === 'inc') { F.etiquetas[nome] = 'exc'; b.classList.add('fora'); }
        else { delete F.etiquetas[nome]; b.setAttribute('aria-pressed', 'false'); b.classList.remove('fora'); }
        invalidarContagem();
      });
      g.chips.appendChild(b);
    });
    if (!OPC.etiquetas.length) g.chips.appendChild(el('span', 'mudo', 'Esta conta ainda não tem etiquetas.'));
    area.appendChild(g.campo);
    var todas = el('label', 'linha'); var ck = el('input'); ck.type = 'checkbox'; ck.addEventListener('change', function(){ F.todas = ck.checked; invalidarContagem(); });
    todas.appendChild(ck); todas.appendChild(el('span', 'mudo', 'Exigir TODAS as etiquetas incluídas (sem marcar, basta uma)')); area.appendChild(todas);
    OPC.atributos.filter(function(a){ return a.valores; }).forEach(function(a){
      var ga = grupoDeChips(a.nome === a.chave ? a.chave : a.nome);
      a.valores.forEach(function(v){
        var b = el('button', 'chip', v); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function(){
          F.atributos[a.chave] = F.atributos[a.chave] || {};
          if (F.atributos[a.chave][v]) { delete F.atributos[a.chave][v]; b.setAttribute('aria-pressed', 'false'); } else { F.atributos[a.chave][v] = 1; b.setAttribute('aria-pressed', 'true'); }
          invalidarContagem();
        });
        ga.chips.appendChild(b);
      });
      area.appendChild(ga.campo);
    });
    var dias = el('div', 'campo'); dias.appendChild(el('label', null, 'Sem interação há pelo menos (dias)'));
    var inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.max = '730'; inp.value = '0'; inp.style.width = '110px';
    inp.addEventListener('input', function(){ F.dias = Math.max(0, Math.min(730, Number(inp.value) || 0)); invalidarContagem(); });
    dias.appendChild(inp); dias.appendChild(el('small', 'mudo', '0 = não filtra. Conta a última mensagem de verdade (nota interna não conta).')); area.appendChild(dias);
  }
  function invalidarContagem(){ CONTA_PREVIA = null; var r = $('resContagem'); if (r) limpar(r); }
  async function contar(bt, res){
    bt.disabled = true; bt.textContent = 'Contando…'; limpar(res);
    try {
      var r = await api('POST', '/api/public/disparos/contar', { slug: U.slug, filtro: filtroParaOServidor() });
      CONTA_PREVIA = r; desenharContagem(res, r); atualizarPrevia();
    } catch (e) { res.appendChild(el('p', 'ruim', e.message)); }
    bt.disabled = false; bt.textContent = 'Contar quem recebe';
  }
  function desenharContagem(res, r){
    var f = el('div', 'fatos');
    [[r.lidas, 'conversas na caixa'], [r.noFiltro, 'passaram no filtro'], [r.total, 'devem receber (estimativa)']].forEach(function(x){ var d = el('div'); d.appendChild(el('b', null, String(x[0]))); d.appendChild(el('span', null, x[1])); f.appendChild(d); });
    res.appendChild(f);
    if (r.truncada) res.appendChild(el('p', 'ruim', 'Contagem PARCIAL: a leitura parou no limite de tempo ou de tamanho e a lista pode estar incompleta.'));
    if (r.fora.length) { res.appendChild(el('div', 'rot mudo', 'Ficam de fora (automático)')); var ul = el('ul', 'lis'); r.fora.forEach(function(x){ ul.appendChild(el('li', null, x.n + ' — ' + x.rotulo)); }); res.appendChild(ul); }
    res.appendChild(el('p', 'mudo', 'Contagem rápida: quem pediu para sair e a agenda da franquia só são conferidos ao montar. O número final pode ser menor.'));
    if (r.amostra.length) {
      var t = el('table'), th = el('thead'), tr = el('tr'); ['Nome na saudação', 'Telefone'].forEach(function(h){ tr.appendChild(el('th', null, h)); }); th.appendChild(tr); t.appendChild(th);
      var tb = el('tbody'); r.amostra.forEach(function(a){ var x = el('tr'); x.appendChild(el('td', null, a.nome)); x.appendChild(el('td', null, a.telefone)); tb.appendChild(x); }); t.appendChild(tb);
      var w = el('div', 'rolar'); w.appendChild(t); res.appendChild(el('div', 'rot mudo', 'Amostra')); res.appendChild(w);
    }
  }

  // ── a mensagem: modelo, variáveis, prévia ──
  function desenharModelo(area){
    limpar(area);
    var ok = OPC.modelos.filter(function(m){ return !m.problema; });
    if (!OPC.modelos.length) { area.appendChild(el('p', 'ruim', 'Esta caixa não tem nenhum modelo APROVADO na Meta. Peça à Doutor Digital para criar e aprovar um modelo.')); return; }
    var cm = el('div', 'campo'); cm.appendChild(el('label', null, 'Modelo aprovado'));
    var s = el('select'); var o0 = el('option', null, 'Escolha um modelo…'); o0.value = ''; s.appendChild(o0);
    OPC.modelos.forEach(function(m, i){ var o = el('option', null, m.nome + (m.problema ? ' — não dá: ' + m.problema : '')); o.value = String(i); if (m.problema) o.disabled = true; s.appendChild(o); });
    cm.appendChild(s); area.appendChild(cm);
    if (!ok.length) area.appendChild(el('p', 'ruim', 'Nenhum modelo desta caixa serve para esta tela ainda (veja o motivo de cada um acima).'));
    var det = el('div'); det.id = 'detModelo'; area.appendChild(det);
    s.addEventListener('change', function(){ escolherModelo(s.value === '' ? null : OPC.modelos[Number(s.value)], limpar(det)); });
  }
  function escolherModelo(m, det){
    ESCOLHA = { modelo: m, fontes: [], texto: [] };
    if (!m) return;
    for (var i = 0; i < m.variaveis; i++) { ESCOLHA.fontes.push(i === 0 ? 'primeiroNome' : 'unidade'); ESCOLHA.texto.push(''); }
    var linhaVars = el('div', 'campo');
    if (m.variaveis) linhaVars.appendChild(el('div', 'rot', 'O que entra em cada variável'));
    for (var k = 0; k < m.variaveis; k++) (function(k){
      var l = el('div', 'linha'); l.appendChild(el('span', 'pill', '{{' + (k + 1) + '}}'));
      var sel = el('select'); [['primeiroNome', 'Primeiro nome do contato'], ['unidade', 'Nome da unidade'], ['texto', 'Texto fixo']].forEach(function(x){ var o = el('option', null, x[1]); o.value = x[0]; sel.appendChild(o); });
      sel.value = ESCOLHA.fontes[k];
      var tx = el('input'); tx.type = 'text'; tx.maxLength = 120; tx.placeholder = 'Texto fixo'; tx.hidden = true;
      sel.addEventListener('change', function(){ ESCOLHA.fontes[k] = sel.value; tx.hidden = sel.value !== 'texto'; atualizarPrevia(); });
      tx.addEventListener('input', function(){ ESCOLHA.texto[k] = tx.value; atualizarPrevia(); });
      l.appendChild(sel); l.appendChild(tx); linhaVars.appendChild(l);
    })(k);
    det.appendChild(linhaVars);
    var qp = el('div', 'campo'); qp.id = 'quemPrevia'; det.appendChild(qp);
    var zap = el('div', 'zap'); zap.id = 'zapPrevia'; det.appendChild(zap);
    if (m.rodape || m.botoes.length) det.appendChild(el('small', 'mudo', (m.rodape ? 'Rodapé: ' + m.rodape + '. ' : '') + (m.botoes.length ? 'Botões: ' + m.botoes.join(', ') + '.' : '')));
    atualizarPrevia();
  }
  function fontesParaOServidor(){ return ESCOLHA.fontes.map(function(f, i){ return f === 'texto' ? 'texto:' + (ESCOLHA.texto[i] || '').trim() : f; }); }
  function atualizarPrevia(){
    var z = $('zapPrevia'); if (!z || !ESCOLHA.modelo) return;
    var amostra = CONTA_PREVIA ? CONTA_PREVIA.amostra : [];
    var q = limpar($('quemPrevia'));
    var sel = el('select'); var nomes = amostra.length ? amostra.map(function(a){ return a.nome; }) : ['Maria'];
    nomes.forEach(function(n){ var o = el('option', null, n); o.value = n; sel.appendChild(o); });
    q.appendChild(el('div', 'rot', amostra.length ? 'Prévia para' : 'Prévia (conte o público para ver com nomes de verdade)')); q.appendChild(sel);
    function desenhar(){
      var t = ESCOLHA.modelo.texto.replace(/\{\{\s*(\d+)\s*\}\}/g, function(_m, n){
        var f = ESCOLHA.fontes[Number(n) - 1]; if (!f) return '{{' + n + '}}';
        return f === 'primeiroNome' ? sel.value : f === 'unidade' ? U.nome : (ESCOLHA.texto[Number(n) - 1] || '…');
      });
      limpar(z); if (ESCOLHA.modelo.cabecalho) z.appendChild(el('small', 'mudo', ESCOLHA.modelo.cabecalho)); z.appendChild(el('div', 'bal', t));
    }
    sel.addEventListener('change', desenhar); desenhar();
  }
  async function montar(bt, nome){
    if (!ESCOLHA || !ESCOLHA.modelo) { toast('Escolha um modelo.', true); return; }
    var fontes = fontesParaOServidor();
    for (var i = 0; i < fontes.length; i++) if (fontes[i] === 'texto:') { toast('Preencha o texto fixo da variável {{' + (i + 1) + '}}.', true); return; }
    if (!nome.value.trim() || nome.value.trim().length < 3) { toast('Dê um nome à campanha.', true); nome.focus(); return; }
    bt.disabled = true; bt.textContent = 'Montando…';
    try {
      var r = await api('POST', '/api/public/disparos/ondas', { slug: U.slug, nome: nome.value.trim(), filtro: filtroParaOServidor(), modelo: { nome: ESCOLHA.modelo.nome, idioma: ESCOLHA.modelo.idioma, variaveis: fontes } });
      toast('Disparo criado: montando a lista…'); await carregar(); abrirOnda(r.id);
    } catch (e) { toast(e.message, true); bt.disabled = false; bt.textContent = 'Montar disparo'; }
  }

  // ── RELATÓRIO ──
  function pct(n, t){ return t ? Math.round((n / t) * 100) + '%' : '—'; }
  function numeroComPct(n, base){ return base == null ? String(n) : n + ' (' + pct(n, base) + ')'; }
  async function mostrarRelatorio(){
    pararPoll(); atualId = null; ONDA = null; desenharLista();
    var p = limpar($('palco')), col = el('div', 'col'); p.appendChild(col);
    var c = el('div', 'card'); c.appendChild(el('h2', null, 'Relatório por campanha')); col.appendChild(c);
    var corpo = el('p', 'mudo', 'Carregando…'); c.appendChild(corpo);
    var r;
    try { r = await api('GET', '/api/public/disparos/relatorio?slug=' + enc(U.slug)); } catch (e) { corpo.textContent = e.message; corpo.className = 'ruim'; return; }
    if (!r.campanhas.length) { corpo.textContent = 'Nenhum disparo ainda.'; return; }
    c.removeChild(corpo);
    var t = el('table'), th = el('thead'), tr = el('tr');
    ['Campanha', 'Selecionadas', 'Enviadas', 'Entregues', 'Lidas', 'Responderam (72 h)', 'Pediram SAIR', 'Falharam'].forEach(function(h){ tr.appendChild(el('th', null, h)); }); th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody');
    r.campanhas.forEach(function(k){
      var n = k.numeros, x = el('tr'), nome = el('td'); var a = el('a', null, k.nome); a.href = '#'; a.addEventListener('click', function(ev){ ev.preventDefault(); abrirOnda(k.id); }); nome.appendChild(a);
      nome.appendChild(el('small', 'mudo', ' · ' + (ESTADO[k.estado] || k.estado) + ' · ' + quando(k.criadoEm))); x.appendChild(nome);
      [n.selecionadas, numeroComPct(n.enviadas, n.selecionadas), numeroComPct(n.entregues, n.enviadas), numeroComPct(n.lidas, n.enviadas), numeroComPct(n.responderam, n.enviadas), numeroComPct(n.pediramSair, n.enviadas), n.falharam].forEach(function(v){ x.appendChild(el('td', null, String(v))); });
      tb.appendChild(x);
    });
    t.appendChild(tb); var w = el('div', 'rolar'); w.appendChild(t); c.appendChild(w);
    c.appendChild(el('p', 'mudo', 'Entregue, lida e respondeu são o que o CRM mostrava na última conferência (a cada 5 minutos, por 72 h depois do envio). «Responderam» não inclui quem pediu para sair. Em modo seco as colunas ficam em zero: nada foi enviado.'));
  }

  // ── UM DISPARO ──
  async function abrirOnda(id){
    pararPoll(); atualId = id; desenharLista();
    var lido;
    try { lido = await api('GET', '/api/public/disparos/ondas/' + enc(id) + '?slug=' + enc(U.slug)); }
    catch (e) { if (atualId === id) { var p0 = limpar($('palco')); p0.appendChild(el('div', 'faixa erro', e.message)); } return; }
    if (atualId !== id) return; // a pessoa já abriu outro disparo (ou «+ Novo»): a resposta velha não apaga a tela dela
    ONDA = lido; desenharOnda();
    if (ONDA.estado === 'montando') {
      tPoll = setTimeout(function(){
        if (atualId !== id) return;
        carregar().then(function(){ abrirOnda(id); }).catch(function(e){ if (atualId === id) { aviso(e.message + ' — recarregue a tela.', true); } });
      }, 3500);
    }
  }
  function fato(f, valor, rotulo){ var d = el('div'); d.appendChild(el('b', null, String(valor))); d.appendChild(el('span', null, rotulo)); f.appendChild(d); }
  function desenharOnda(){
    var o = ONDA, p = limpar($('palco')), col = el('div', 'col'); p.appendChild(col);
    col.appendChild(el('div', 'faixa ' + (o.modo === 'ligado' ? 'vivo' : o.modo === 'seco' ? 'seco' : ''), faixaDoModo()));
    var c = el('div', 'card'); var h = el('h2', null, o.nome); h.appendChild(el('span', 'pill ' + (CLASSE[o.estado] || 'mudo'), ESTADO[o.estado] || o.estado)); c.appendChild(h);
    c.appendChild(el('p', null, 'Público: ' + o.filtro + ' · modelo ' + o.modelo.nome + ' (' + o.modelo.idioma + ')'));
    if (o.pausaMotivo) c.appendChild(el('p', 'ruim', (o.estado === 'cancelada' ? 'Motivo: ' : 'Parada: ') + o.pausaMotivo));
    if (o.aprovadaPor) c.appendChild(el('p', 'mudo', 'Aprovada por ' + o.aprovadaPor + ' em ' + quando(o.aprovadaEm) + (o.aprovadaModo && o.aprovadaModo !== 'ligado' ? ' (com a unidade em ' + (o.aprovadaModo === 'seco' ? 'seco' : 'modo desligado') + ': não vale como aprovação de envio)' : '') + '.'));
    var f = el('div', 'fatos'); fato(f, o.total, 'pessoas'); fato(f, o.candidatos == null ? '—' : o.candidatos, 'passaram no filtro'); fato(f, o.contagem.enviado || 0, 'enviadas'); fato(f, o.simulados, 'com «receberia» (seco)'); fato(f, (o.contagem.falhou || 0) + (o.contagem.saiu || 0) + (o.contagem.descartado || 0), 'falharam, pediram SAIR ou saíram da lista'); c.appendChild(f);
    col.appendChild(c);
    if (o.relatorio && o.relatorio.numeros.enviadas + o.relatorio.numeros.falharam > 0) {
      var cr = el('div', 'card'); cr.appendChild(el('h2', null, 'Relatório')); var n = o.relatorio.numeros, fr2 = el('div', 'fatos');
      fato(fr2, n.enviadas, 'enviadas'); fato(fr2, numeroComPct(n.entregues, n.enviadas), 'entregues'); fato(fr2, numeroComPct(n.lidas, n.enviadas), 'lidas'); fato(fr2, numeroComPct(n.responderam, n.enviadas), 'responderam (até 72 h)'); fato(fr2, numeroComPct(n.pediramSair, n.enviadas), 'pediram para sair'); fato(fr2, n.falharam, 'falharam');
      cr.appendChild(fr2);
      if (o.relatorio.porHora.length) { var ul2 = el('ul', 'lis'); o.relatorio.porHora.forEach(function(h){ ul2.appendChild(el('li', null, h.hora.replace(' ', ' às ') + 'h — ' + h.enviadas + ' enviadas')); }); cr.appendChild(el('div', 'rot mudo', 'Envios por hora (' + (o.relatorio.fuso || 'America/Sao_Paulo') + ')')); cr.appendChild(ul2); }
      cr.appendChild(el('p', 'mudo', 'Entregue, lida e respondeu são o que o CRM mostrava na última conferência (a cada 5 minutos, por 72 h depois do envio).'));
      col.appendChild(cr);
    }
    // a mensagem
    var cz = el('div', 'card'); cz.appendChild(el('h2', null, 'O que cada pessoa vai ler')); var zap = el('div', 'zap');
    if (o.exemplos.length) o.exemplos.forEach(function(t){ zap.appendChild(el('div', 'bal', t)); }); else zap.appendChild(el('div', 'bal', o.modelo.texto));
    cz.appendChild(zap); cz.appendChild(el('p', 'mudo', 'Três exemplos, cada um com o primeiro nome da pessoa no lugar.'));
    if (o.estado === 'montada' && o.conferencia) cz.appendChild(el('p', o.conferencia.ok ? 'bom' : 'ruim', o.conferencia.ok ? 'Conferido no CRM: o modelo está APROVADO e o texto bate.' : 'O CRM não confere: ' + o.conferencia.motivo));
    col.appendChild(cz);
    // exclusões
    var ce = el('div', 'card'); ce.appendChild(el('h2', null, 'Quem ficou de fora, e por quê'));
    if (o.fora.length) { var ul = el('ul', 'lis'); o.fora.forEach(function(x){ ul.appendChild(el('li', null, x.n + ' — ' + x.rotulo)); }); ce.appendChild(ul); } else ce.appendChild(el('p', null, 'Ninguém ficou de fora pelas regras.'));
    if (o.truncada) ce.appendChild(el('p', 'ruim', 'A leitura da caixa parou no limite (de tempo ou de tamanho): a lista pode estar incompleta.'));
    col.appendChild(ce);
    // pessoa por pessoa
    var cp = el('div', 'card'); cp.appendChild(el('h2', null, 'Pessoa por pessoa'));
    if (o.destinatarios.length) {
      var t = el('table'), th = el('thead'), tr = el('tr'); ['Nome', 'Telefone', 'Estado', 'Quando', 'Motivo'].forEach(function(x){ tr.appendChild(el('th', null, x)); }); th.appendChild(tr); t.appendChild(th);
      var tb = el('tbody');
      o.destinatarios.forEach(function(d){
        var x = el('tr'); x.appendChild(el('td', null, d.nome)); x.appendChild(el('td', null, d.telefone)); x.appendChild(el('td', null, ROTULO_ESTADO[d.estado] || d.estado));
        x.appendChild(el('td', null, d.enviadoEm ? quando(d.enviadoEm) : d.simuladoEm ? 'receberia (seco) ' + quando(d.simuladoEm) : '—')); x.appendChild(el('td', 'mudo', d.motivo || '—')); tb.appendChild(x);
      });
      t.appendChild(tb); var w = el('div', 'rolar'); w.appendChild(t); cp.appendChild(w);
      if (o.total > o.destinatariosMostrados) cp.appendChild(el('p', 'mudo', 'Mostrando ' + o.destinatariosMostrados + ' de ' + o.total + ' pessoas.'));
    } else cp.appendChild(el('p', 'mudo', o.estado === 'montando' ? 'Montando a lista… esta tela atualiza sozinha.' : 'Sem destinatários.'));
    col.appendChild(cp);
    // freios
    var cf = el('div', 'card'); cf.appendChild(el('h2', null, 'Os freios')); var fl = el('ul', 'lis'), fr = o.freios;
    [['Janela de envio: ' + fr.janela + '.'], ['Teto: ' + fr.tetoPorHora + ' por hora e ' + fr.tetoPorDia + ' por 24 horas' + (fr.tetoDoTier ? ' (o número está no ' + fr.tier + ', ' + fr.tetoDoTier + ' por dia na Meta)' : '') + '.'], ['Para tudo se mais de ' + fr.maxSair + ' pessoas responderem SAIR; pausa se ' + fr.falhasSeguidas + ' envios seguidos falharem.'],
      [fr.comAgenda ? 'Reconfere a agenda da franquia (consulta marcada, tratamento aberto) e o SAIR na hora de cada envio.' : 'Esta unidade não tem a agenda da franquia ligada: a conferência de paciente é pela etapa do CRM (agendado, em tratamento, fechou…) e o SAIR na hora de cada envio.'], ['Nunca duas vezes para a mesma pessoa, nem para quem recebeu outro disparo nos últimos 7 dias.']].forEach(function(x){ fl.appendChild(el('li', null, x[0])); });
    cf.appendChild(fl); col.appendChild(cf);
    // ações
    var ca = el('div', 'card'); var la = el('div', 'linha');
    if (o.estado === 'montada') {
      var ba = el('button', 'bt pri', 'Aprovar este disparo (' + o.total + ' pessoas)'); ba.type = 'button';
      ba.disabled = !(o.podeAprovar && o.conferencia && o.conferencia.ok);
      ba.addEventListener('click', function(){
        var seco = o.modo !== 'ligado';
        if (!confirm(seco ? 'Aprovar com a unidade em ' + (o.modo === 'seco' ? 'SECO' : 'modo DESLIGADO') + '? Nada será enviado: só fica registrado quem receberia.' : 'Aprovar o envio para ' + o.total + ' pessoas? As mensagens saem sozinhas, em ondas.')) return;
        ba.disabled = true;
        api('POST', '/api/public/disparos/ondas/' + enc(o.id) + '/aprovar', { slug: U.slug, total: o.total, impressao: o.impressao }).then(function(){ toast('Aprovado.'); return carregar().then(function(){ abrirOnda(o.id); }); }).catch(function(e){ toast(e.message, true); ba.disabled = false; });
      });
      la.appendChild(ba);
      if (!o.podeAprovar) ca.appendChild(el('p', 'mudo', o.motivoSemAprovar || 'Você não pode aprovar.'));
      else if (!(o.conferencia && o.conferencia.ok)) ca.appendChild(el('p', 'mudo', 'A aprovação fica travada até o CRM confirmar o modelo.'));
    }
    if (['montando', 'montada', 'aprovada', 'pausada'].indexOf(o.estado) >= 0) {
      var bc = el('button', 'bt perigo', o.estado === 'aprovada' || o.estado === 'pausada' ? 'Parar e cancelar' : 'Cancelar'); bc.type = 'button';
      bc.addEventListener('click', function(){
        if (!confirm('Cancelar este disparo?')) return; bc.disabled = true;
        api('POST', '/api/public/disparos/ondas/' + enc(o.id) + '/cancelar', { slug: U.slug, motivo: 'cancelado na tela Disparos' }).then(function(){ toast('Cancelado.'); return carregar().then(function(){ abrirOnda(o.id); }); }).catch(function(e){ toast(e.message, true); bc.disabled = false; });
      });
      la.appendChild(bc);
    }
    if (o.estado === 'pausada') ca.appendChild(el('p', 'mudo', 'Disparo pausado pelos freios: não tem retomada por aqui. Cancele e monte de novo depois de resolver o motivo.'));
    if (la.childNodes.length) { ca.appendChild(la); col.appendChild(ca); }
    // ajuste (só a Doutor Digital)
    if (D.podeAjustar) col.appendChild(cartaoDeAjuste());
  }
  function cartaoDeAjuste(){
    var c = el('div', 'card'); c.appendChild(el('h2', null, 'Ajustes da unidade (só a Doutor Digital vê)'));
    var l1 = el('label', 'linha'); var ck = el('input'); ck.type = 'checkbox'; ck.checked = !!D.ajuste.gerenteAprova; l1.appendChild(ck); l1.appendChild(el('span', null, 'A administradora da clínica também pode aprovar disparos (desligado por padrão)')); c.appendChild(l1);
    var l2 = el('div', 'linha'); l2.appendChild(el('span', 'mudo', 'TIER do número na Meta:')); var tier = el('input'); tier.type = 'text'; tier.maxLength = 14; tier.placeholder = 'TIER_250'; tier.value = D.ajuste.tierDoNumero || ''; tier.style.width = '130px'; l2.appendChild(tier); c.appendChild(l2);
    var b = el('button', 'bt sec', 'Salvar ajustes'); b.type = 'button';
    b.addEventListener('click', function(){
      b.disabled = true;
      api('POST', '/api/public/disparos/ajuste', { slug: U.slug, gerenteAprova: ck.checked, tierDoNumero: tier.value.trim() ? tier.value.trim() : null }).then(function(r){ D.ajuste = r.ajuste; toast('Ajustes salvos.'); return carregar(); }).catch(function(e){ toast(e.message, true); }).then(function(){ b.disabled = false; });
    });
    c.appendChild(b); return c;
  }

  // ── entrada: sessão do Chatwoot pelo menu, unidade pelas caixas da pessoa ──
  async function carregar(){
    D = await api('GET', '/api/public/disparos?slug=' + enc(U.slug));
    cabecalho(); desenharLista(); return D;
  }
  async function escolherUnidade(u){
    U = u; guardar('disparos:unidade', u.slug); $('unidadeNome').textContent = u.nome; atualId = null; pararPoll();
    try { await carregar(); aviso(''); if (D.disparos.length) abrirOnda(D.disparos[0].id); else mostrarNovo(); } catch (e) { aviso(e.message, true); }
  }
  async function entrar(){
    try {
      var r = await api('GET', '/api/public/testar-ia/unidades');
      UNIDADES = r.unidades || [];
      if (!UNIDADES.length) { aviso('Você não atende nenhuma caixa com disparos. Peça para a Suzanne liberar a caixa da sua unidade.', true); $('unidadeNome').textContent = 'Sem unidade'; return; }
      var guardada = lerGuardado('disparos:unidade'), u = UNIDADES.filter(function(x){ return x.slug === guardada; })[0] || UNIDADES[0];
      if (UNIDADES.length > 1) {
        var s = $('unidadeSel'); s.hidden = false; limpar(s);
        UNIDADES.forEach(function(x){ var o = el('option', null, x.nome); o.value = x.slug; s.appendChild(o); });
        s.value = u.slug; s.onchange = function(){ var x = UNIDADES.filter(function(y){ return y.slug === s.value; })[0]; if (x) escolherUnidade(x); };
        $('unidadeNome').textContent = '';
      }
      $('corpo').hidden = false;
      await escolherUnidade(u);
    } catch (e) { aviso(e.message, true); }
  }
  $('btNovo').addEventListener('click', function(){ if (U && D) mostrarNovo(); });
  $('btRel').addEventListener('click', function(){ if (U && D) mostrarRelatorio(); });
  window.addEventListener('message', function(ev){
    if (!origemDoCrm(ev.origin) || ev.source !== window.parent) return;
    var d = ev.data; if (!d || d.event !== 'funil-sessao') return;
    var novo = d.sessao && d.sessao.token ? d.sessao : null, primeira = !S && novo && !U; S = novo;
    if (primeira) entrar();
  });
  pedirSessao(); setTimeout(function(){ if (!S) pedirSessao(); }, 1500);
  setTimeout(function(){ if (!S) aviso('Abra esta tela pelo menu do CRM (Disparos), já logada.', true); }, 6000);
})();
</script></body></html>`;

/** A página. `origemChatwoot` = a origem do Chatwoot (só ela fala com a página por postMessage). */
export function paginaDosDisparos(origemChatwoot: string): string {
  return comContaNaPagina(PAGINA.split('__ORIGEM_CW__').join(`origemDoPai(${JSON.stringify(origemChatwoot)})`).split('__LOGO_DD__').join(LOGO_DD_PNG));
}
