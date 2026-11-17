/**
 * A tela «Disparos» do menu do Chatwoot (16/11/2026): o «Broadcast» do CRM. Três passos numa página só — Público (filtro + contagem + quem sai e
 * por quê), Mensagem (modelo APROVADO da caixa, variáveis, prévia por pessoa, num celular com o WhatsApp) e Revisão (montar, aprovar, acompanhar). Mesmo visual das telas
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
:root{--app:#f7f7f7;--side:#fff;--canvas:#f0f0f3;--node:#fff;--ink:#1c2024;--ink-2:#60646c;--line:#e2e3e7;--brand:#2781f6;--brand-soft:#e9f3ff;--send:#29a71a;--stop:#8b8d98;--ruim:#ca244d;--aviso:#8f5300;--aviso-forte:#ffb224;--chat:#efeae2;--rec:#fff;--rec-ink:#111b21;--wa-top:#008069;--wa-sub:#667781;--wa-link:#027eb5;--dia:#fff;--bisel:#0c0d0f;--shadow:0 1px 2px rgba(28,32,36,.06),0 6px 18px rgba(28,32,36,.08);--f-ui:Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif;--f-head:Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--app:#1c1d20;--side:#17171a;--canvas:#18191b;--node:#1d1e24;--ink:#edeef0;--ink-2:#b0b4ba;--line:#2e2d32;--brand:#2781f6;--brand-soft:#0f2748;--ruim:#ff6b8f;--aviso:#ffca16;--chat:#0b141a;--rec:#202c33;--rec-ink:#e9edef;--wa-top:#1f2c34;--wa-sub:#8696a0;--wa-link:#53bdeb;--dia:#182229;--bisel:#2a2c31;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px rgba(0,0,0,.35)}}
*{box-sizing:border-box}html{min-height:100%}
body{margin:0;background:var(--app);color:var(--ink);font:14px/1.45 var(--f-ui);display:grid;grid-template-rows:auto auto 1fr;min-height:100%;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
[hidden]{display:none!important}
.topo{display:flex;align-items:center;gap:10px;padding-block:12px;flex-wrap:wrap}
.logo{width:28px;height:28px;display:block;flex:none}
.topo b{font:700 17px var(--f-head)}
.topo .un{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--ink-2);font-size:13px}
select,input[type=text],input[type=number]{font:500 14px var(--f-ui);color:var(--ink);background:var(--node);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-height:38px;max-width:100%}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font:600 12px var(--f-ui);background:var(--brand-soft);color:var(--brand);white-space:nowrap}
.pill.seco{background:color-mix(in srgb,var(--aviso-forte) 22%,transparent);color:var(--aviso)}
.pill.vivo{background:color-mix(in srgb,var(--send) 18%,transparent);color:var(--send)}
.pill.off,.pill.mudo{background:var(--app);color:var(--ink-2);border:1px solid var(--line)}
.pill.ruim{background:color-mix(in srgb,var(--ruim) 15%,transparent);color:var(--ruim)}
.pill.est::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.faixa{margin:0 0 14px;padding:11px 14px;border:1px solid var(--line);border-left-width:5px;border-radius:10px;background:var(--node);font-size:13.5px;display:flex;gap:4px 10px;flex-wrap:wrap;align-items:baseline}
.faixa b{font:700 14px var(--f-head)}
.faixa .como{flex-basis:100%}.faixa .como p{margin:2px 0 4px}.faixa .como summary{font-weight:500;color:var(--ink-2);display:inline-block}
.faixa.seco{border-color:var(--aviso-forte);background:color-mix(in srgb,var(--aviso-forte) 12%,var(--node))}
.faixa.vivo{border-color:var(--send)}
.faixa.erro{border-color:var(--ruim);color:var(--ruim)}
.app{display:grid;grid-template-columns:280px minmax(0,1fr);border:1px solid var(--line);border-radius:14px;overflow:clip;background:var(--side);min-height:640px;margin-bottom:16px}
@media (max-width:860px){.app{grid-template-columns:1fr}.lado{border-right:0!important;border-bottom:1px solid var(--line)}.lista{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;padding:0 14px 14px}.item{flex:0 0 220px;border:1px solid var(--line)}.vazio{padding:4px 0}}
.lado{border-right:1px solid var(--line);display:grid;grid-template-rows:auto 1fr;min-height:0;align-content:start}
.lado-cab{display:flex;gap:8px;align-items:center;padding:14px;flex-wrap:wrap}
.lado-cab .bt.pri{flex:1}
.bt{appearance:none;border:0;border-radius:9px;padding:9px 14px;min-height:40px;font:600 13.5px var(--f-ui);cursor:pointer;display:inline-flex;gap:6px;align-items:center;justify-content:center;white-space:nowrap}
.bt.pri{background:var(--brand);color:#fff}.bt.sec{background:var(--node);color:var(--ink);border:1px solid var(--line)}.bt.perigo{background:var(--node);color:var(--ruim);border:1px solid var(--ruim)}
.bt:disabled{opacity:.5;cursor:default}
.bt:focus-visible,.item:focus-visible,select:focus-visible,input:focus-visible,.chip:focus-visible,summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.lista{overflow-y:auto;padding:0 8px 14px;min-height:0}
.item{display:grid;grid-template-columns:minmax(0,1fr);justify-items:start;gap:4px;padding:10px;border-radius:9px;cursor:pointer}
.item:hover{background:var(--app)}.item[aria-current=true]{background:var(--brand-soft)}
.item b{font:600 13.5px var(--f-ui);max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item small{color:var(--ink-2);font-size:12px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.palco{background:var(--canvas);padding:18px;min-width:0;container-type:inline-size}
.col{display:grid;gap:14px;max-width:960px}
.card{background:var(--node);border:1px solid var(--line);border-radius:14px;padding:16px;display:grid;gap:12px;box-shadow:var(--shadow);min-width:0}
.card h2{margin:0;font:700 16px var(--f-head);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.card h2 .n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--app);border:1px solid var(--line);color:var(--ink-2);font:700 12px var(--f-ui)}
.card p{margin:0;color:var(--ink-2)}
.campo{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:6px}.campo>select{width:100%}.campo>label,.campo>.rot,.rot{font:600 13px var(--f-ui);color:var(--ink)}
.dica{color:var(--ink-2);font-size:12.5px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{appearance:none;border:1px solid var(--line);background:var(--app);color:var(--ink);border-radius:999px;padding:5px 12px;min-height:32px;font:500 13px var(--f-ui);cursor:pointer}
.chip[aria-pressed=true]{background:var(--brand-soft);border-color:var(--brand);color:var(--brand);font-weight:600}
.chip.fora[aria-pressed=true]{background:color-mix(in srgb,var(--ruim) 14%,transparent);border-color:var(--ruim);color:var(--ruim)}
.linha{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.par{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:start;gap:12px}
.fatos{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px}
.fatos div{background:color-mix(in srgb,var(--ink) 5%,var(--node));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.fatos b{font:700 22px/1.15 var(--f-head);font-variant-numeric:tabular-nums}.fatos span{color:var(--ink-2);font-size:12.5px;line-height:1.3}
.fatos .destaque b{color:var(--brand)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:13px;vertical-align:top}th{font:600 12px var(--f-ui);color:var(--ink-2);white-space:nowrap}
.rolar{overflow-x:auto;max-height:340px;overflow-y:auto}
details>summary{cursor:pointer;font:600 13px var(--f-ui);color:var(--ink);padding:4px 0}
details>summary .dica{font-weight:400}
details[open]>summary{margin-bottom:8px}
.mudo{color:var(--ink-2)}.ruim{color:var(--ruim)}.bom{color:var(--send)}.card p.ruim{color:var(--ruim)}.card p.bom{color:var(--send)}
.vazio{padding:24px 14px;color:var(--ink-2)}
.toast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--app);padding:10px 16px;border-radius:10px;font-size:13.5px;z-index:50;max-width:92vw}
.toast.erro{background:#ca244d;color:#fff}
.custo{display:grid;gap:6px;border-radius:12px;padding:14px;background:color-mix(in srgb,var(--ink) 4%,var(--node));border:1px solid var(--line)}
.custo .valor{font:700 28px/1.15 var(--f-head);font-variant-numeric:tabular-nums}
.custo.desconhecido{border-color:var(--aviso-forte);background:color-mix(in srgb,var(--aviso-forte) 14%,var(--node))}
.custo.desconhecido .valor{color:var(--aviso)}
.confirma{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--aviso-forte);border-radius:10px;font-size:13.5px}
.confirma input{margin-top:3px;width:18px;height:18px;flex:none}
.kv{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:6px 14px;margin:0;font-size:13.5px}
.kv dt{color:var(--ink-2)}.kv dd{margin:0;font-variant-numeric:tabular-nums}
@media (max-width:520px){.kv{grid-template-columns:1fr;gap:0}.kv dd{margin-bottom:8px}}
ul.lis{margin:0;padding-left:1.2em;display:grid;gap:3px}
ul.fora{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px}
ul.fora li{display:inline-flex;gap:8px;align-items:baseline;background:color-mix(in srgb,var(--ink) 6%,var(--node));border-radius:8px;padding:5px 10px;font-size:13px}
ul.fora li b{font:700 14px var(--f-ui);font-variant-numeric:tabular-nums}
.horas{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:4px 14px;font-size:13px;font-variant-numeric:tabular-nums;margin:0;padding:0;list-style:none}
a{color:var(--brand)}
#areaFiltro,#detModelo{display:grid;gap:12px}
#resContagem{display:grid;gap:12px}#resContagem:empty{display:none}
/* o celular: a mensagem como a pessoa recebe no WhatsApp */
.msg-grid{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.msg-form{flex:1 1 280px;min-width:0;display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:12px}
.msg-fone{flex:0 0 auto;margin-inline:auto}
.duas{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
.duas>.topo-onda,.duas>.resto-onda{min-width:0;display:grid;gap:14px;align-content:start}
.lateral{margin-inline:auto;width:min(100%,312px)}
@container (min-width:660px){.duas{grid-template-columns:minmax(0,1fr) 312px;grid-template-areas:"topo lateral" "resto lateral"}.duas>.topo-onda{grid-area:topo}.duas>.resto-onda{grid-area:resto}.duas>.lateral{grid-area:lateral;margin-inline:0}}
.lateral .card{justify-items:center;width:100%}
.cel{width:272px;max-width:100%;background:var(--bisel);border-radius:40px;padding:9px;box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 14%,transparent),0 14px 30px rgba(0,0,0,.22);position:relative}
.cel-tela{border-radius:31px;overflow:hidden;background:var(--chat);display:flex;flex-direction:column;min-height:520px;max-height:680px}
.cel-status{display:flex;justify-content:space-between;align-items:center;padding:8px 20px 4px;background:var(--wa-top);color:#fff;font:600 11px var(--f-ui);font-variant-numeric:tabular-nums}
.cel-status i{display:block;width:16px;height:8px;border:1.5px solid #fff;border-radius:3px;position:relative}
.cel-status i::after{content:"";position:absolute;inset:1px;right:4px;background:#fff;border-radius:1px}
.cel-topo{background:var(--wa-top);color:#fff;display:flex;gap:8px;align-items:center;padding:4px 10px 9px 8px}
.cel-topo .volta{font:400 22px/1 var(--f-ui);opacity:.9}
.cel-topo .foto{width:32px;height:32px;border-radius:50%;background:#e9fff6;color:#008069;display:grid;place-items:center;font:700 14px var(--f-ui);flex:none}
.cel-topo .quem{min-width:0;display:grid;line-height:1.2}
.cel-topo .quem b{font:600 14px var(--f-ui);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cel-topo .quem span{font-size:11px;opacity:.8}
.cel-conversa{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 8px;display:flex;flex-direction:column;gap:3px;background-image:radial-gradient(color-mix(in srgb,var(--ink) 9%,transparent) 1px,transparent 1.6px);background-size:16px 16px}
.cel-dia{align-self:center;background:var(--dia);color:var(--wa-sub);font:500 11px var(--f-ui);padding:3px 10px;border-radius:7px;margin-bottom:6px;box-shadow:0 1px 1px rgba(0,0,0,.1)}
.cel-vazio{align-self:center;text-align:center;color:var(--wa-sub);font-size:12.5px;padding:30px 18px;background:var(--dia);border-radius:10px;margin-top:20px}
.cel-msg{max-width:88%;display:grid;gap:3px}
.bal{background:var(--rec);color:var(--rec-ink);border-radius:0 8px 8px 8px;padding:6px 8px 4px;font-size:13.5px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 1px rgba(0,0,0,.14)}
.bal::after{content:"";display:block;clear:both}
.bal .cab{display:block;font-weight:700;margin-bottom:2px}
.bal .rod{display:block;color:var(--wa-sub);font-size:12px;margin-top:4px}
.bal .hora{float:right;margin:4px 0 0 10px;font-size:10.5px;color:var(--wa-sub);line-height:1}
.cel-bt{background:var(--rec);color:var(--wa-link);border-radius:8px;padding:9px 8px;text-align:center;font:500 13px var(--f-ui);box-shadow:0 1px 1px rgba(0,0,0,.14);overflow-wrap:anywhere}
.cel-entrada{background:var(--chat);padding:6px 8px 12px;display:flex;gap:6px}
.cel-entrada span{flex:1;background:var(--rec);color:var(--wa-sub);border-radius:20px;padding:8px 14px;font-size:13px}
.cel-entrada i{width:36px;height:36px;border-radius:50%;background:var(--wa-top);flex:none}
.cel-troca{display:flex;gap:6px;justify-content:center;flex-wrap:wrap}
@media (max-width:520px){body{padding-left:max(12px,env(safe-area-inset-left,0px));padding-right:max(12px,env(safe-area-inset-right,0px))}.palco{padding:12px}.card{padding:14px}.topo .un{margin-left:0;width:100%}}
</style></head><body>
<div class="topo"><img class="logo" src="__LOGO_DD__" alt="Doutor Digital" width="28" height="28"><b>Disparos</b>
  <span class="un"><span id="modo" class="pill off" hidden></span><span id="papel" class="pill mudo" hidden></span><select id="unidadeSel" hidden aria-label="Unidade"></select><span id="unidadeNome"></span></span></div>
<div id="avisos"></div>
<div class="app" id="corpo" hidden>
  <aside class="lado" aria-label="Seus disparos">
    <div class="lado-cab"><button class="bt pri" type="button" id="btNovo">Novo disparo</button><button class="bt sec" type="button" id="btRel">Relatório</button></div>
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
    if (!r.ok) { var er = new Error(j.error || ('erro ' + r.status)); er.corpo = j; if (r.status === 401) { S = null; pedirSessao(); } throw er; }
    return j;
  }
  function enc(x){ return encodeURIComponent(x); }
  function quando(iso){
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', ''); } catch (e) { return d.toISOString().slice(5, 16); }
  }
  function quandoHora(t){ var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2})$/.exec(String(t)); return m ? m[3] + '/' + m[2] + ' às ' + Number(m[4]) + 'h' : String(t).replace(' ', ' às ') + 'h'; }
  function horaAgora(){
    try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date()); } catch (e) { return ''; }
  }
  var ESTADO = { montando: 'Montando a lista…', montada: 'Esperando aprovação', aprovada: 'Aprovada', pausada: 'Pausada', concluida: 'Concluída', cancelada: 'Cancelada' };
  var CLASSE = { montando: 'mudo', montada: 'seco', aprovada: 'vivo', pausada: 'ruim', concluida: 'vivo', cancelada: 'off' };
  var ROTULO_ESTADO = { pendente: 'Pendente', enviando: 'Enviando…', enviado: 'Enviado', falhou: 'Falhou', saiu: 'Pediu SAIR', descartado: 'Descartado' };
  var CLASSE_DEST = { pendente: 'mudo', enviando: 'mudo', enviado: 'vivo', falhou: 'ruim', saiu: 'seco', descartado: 'off' };
  function pillEstado(estado){ return el('span', 'pill est ' + (CLASSE[estado] || 'mudo'), ESTADO[estado] || estado); }

  // ── cabeçalho: modo da unidade e quem sou ──
  function cabecalho(){
    var m = $('modo'); m.hidden = false;
    m.className = 'pill est ' + (D.modo === 'ligado' ? 'vivo' : D.modo === 'seco' ? 'seco' : 'off');
    m.textContent = D.modo === 'ligado' ? 'Ligado' : D.modo === 'seco' ? 'Modo seco: nada é enviado' : 'Desligado';
    var p = $('papel'); p.hidden = false;
    p.textContent = D.podeAprovar ? 'Você pode aprovar' : 'Você monta; a administração aprova';
  }
  // A faixa do modo: sempre no topo, em cada tela. Retorna o elemento pronto.
  function faixaDoModo(modo){
    var f = D.freios;
    modo = modo || D.modo;
    var cx = el('div', 'faixa ' + (modo === 'ligado' ? 'vivo' : modo === 'seco' ? 'seco' : ''));
    function mais(txt){ var dt = el('details', 'como'); dt.appendChild(el('summary', null, 'Como funciona')); dt.appendChild(el('p', 'dica', txt)); cx.appendChild(dt); }
    if (modo === 'seco') {
      cx.appendChild(el('b', null, 'Modo seco:'));
      cx.appendChild(el('span', null, 'nada é enviado. O sistema só anota quem receberia.'));
      mais('Montar e aprovar conferem a lista e aplicam todas as regras, mas nenhuma mensagem sai até a Doutor Digital ligar os disparos desta unidade.');
    } else if (modo === 'desligado') {
      cx.appendChild(el('b', null, 'Desligado:'));
      cx.appendChild(el('span', null, 'os disparos estão desligados nesta unidade.'));
    } else {
      cx.appendChild(el('b', null, 'Ligado:'));
      cx.appendChild(el('span', null, 'depois de aprovado, sai em ondas das ' + f.janela + '.'));
      mais('No máximo ' + f.tetoPorHora + ' por hora e ' + f.tetoPorDia + ' por 24 horas.' + (f.tetoDoTier ? ' O número está no ' + f.tier + ' da Meta.' : ''));
    }
    return cx;
  }

  // ── o celular: a mensagem como a pessoa recebe ──
  function celular(){
    var raiz = el('div', 'cel'), tela = el('div', 'cel-tela'); raiz.appendChild(tela);
    var st = el('div', 'cel-status'); st.appendChild(el('span', null, horaAgora())); st.appendChild(el('i')); tela.appendChild(st);
    var top = el('div', 'cel-topo'); top.appendChild(el('span', 'volta', '‹'));
    var nome = (U && U.nome) ? U.nome : 'Clínica';
    top.appendChild(el('span', 'foto', nome.trim().charAt(0).toUpperCase()));
    var q = el('div', 'quem'); q.appendChild(el('b', null, nome)); q.appendChild(el('span', null, 'Conta comercial')); top.appendChild(q); tela.appendChild(top);
    var conversa = el('div', 'cel-conversa'); tela.appendChild(conversa);
    var ent = el('div', 'cel-entrada'); ent.appendChild(el('span', null, 'Mensagem')); ent.appendChild(el('i')); tela.appendChild(ent);
    return { raiz: raiz, conversa: conversa };
  }
  // *negrito* e _itálico_ como o WhatsApp mostra (sempre por textContent). SEM lookbehind na regex: Safari/iOS < 16.4 não conhece e a regex literal
  // derruba o <script> inteiro (tela em branco).
  function formatar(no, texto){
    var t = String(texto), re = /(^|[^\p{L}\p{N}_*])([*_])(?=\S)((?:(?!\2)[^\n])*?(?!\2)\S)\2(?![\p{L}\p{N}_*])/gu, ult = 0, m;
    while ((m = re.exec(t))) {
      var ini = m.index + m[1].length;
      if (ini > ult) no.appendChild(document.createTextNode(t.slice(ult, ini)));
      no.appendChild(el(m[2] === '*' ? 'strong' : 'em', null, m[3]));
      ult = re.lastIndex;
    }
    if (ult < t.length) no.appendChild(document.createTextNode(t.slice(ult)));
  }
  // m = { cabecalho, texto, rodape, botoes } (só o que o modelo tem) ou null = ainda sem mensagem
  function mensagemNoCelular(conversa, m){
    limpar(conversa); conversa.appendChild(el('div', 'cel-dia', 'Hoje'));
    if (!m) { conversa.appendChild(el('div', 'cel-vazio', 'Escolha um modelo para ver a mensagem aqui.')); return; }
    var wrap = el('div', 'cel-msg'), bal = el('div', 'bal');
    if (m.cabecalho) bal.appendChild(el('span', 'cab', m.cabecalho));
    var corpo = el('span'); formatar(corpo, m.texto); bal.appendChild(corpo);
    if (m.rodape) bal.appendChild(el('span', 'rod', m.rodape));
    bal.appendChild(el('span', 'hora', horaAgora()));
    wrap.appendChild(bal);
    (m.botoes || []).forEach(function(b){ wrap.appendChild(el('div', 'cel-bt', '↩ ' + b)); });
    conversa.appendChild(wrap);
  }

  // ── a lista à esquerda ──
  function desenharLista(){
    var l = limpar($('lista'));
    if (!D.disparos.length) { l.appendChild(el('div', 'vazio', 'Nenhum disparo ainda. Toque em Novo disparo.')); return; }
    D.disparos.forEach(function(o){
      var i = el('div', 'item'); i.tabIndex = 0; i.setAttribute('role', 'button');
      if (o.id === atualId) i.setAttribute('aria-current', 'true');
      i.appendChild(el('b', null, o.nome));
      i.appendChild(pillEstado(o.estado));
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
  function titulo(n, txt){ var h = el('h2'); if (n) h.appendChild(el('span', 'n', n)); h.appendChild(document.createTextNode(txt)); return h; }
  function mostrarNovo(){
    pararPoll(); atualId = null; ONDA = null; F = filtroVazio(); CONTA_PREVIA = null; ESCOLHA = { modelo: null, fontes: [], texto: [] }; desenharLista();
    var p = limpar($('palco')), col = el('div', 'col'); p.appendChild(col);
    col.appendChild(faixaDoModo());
    var oficiais = D.caixas.filter(function(c){ return c.oficial; });
    if (!oficiais.length) {
      var c0 = el('div', 'card'); c0.appendChild(el('h2', null, 'Sem caixa de WhatsApp oficial'));
      c0.appendChild(el('p', null, 'Os disparos só saem por uma caixa de WhatsApp oficial (a API da Meta). Esta unidade não tem nenhuma pronta:'));
      var ul = el('ul', 'lis'); D.caixas.forEach(function(c){ ul.appendChild(el('li', null, c.nome + ': ' + (c.motivo || 'não é WhatsApp oficial'))); }); c0.appendChild(ul);
      col.appendChild(c0); return;
    }
    F.caixa = oficiais[0].id;

    // 1. Público
    var c1 = el('div', 'card'); c1.appendChild(titulo('1', 'Quem recebe'));
    var campoCaixa = el('div', 'campo'); campoCaixa.appendChild(el('label', null, 'Caixa de WhatsApp'));
    var sc = el('select'); oficiais.forEach(function(c){ var o = el('option', null, c.nome); o.value = String(c.id); sc.appendChild(o); });
    sc.addEventListener('change', function(){ F.caixa = Number(sc.value); carregarOpcoes(c1, c2); }); campoCaixa.appendChild(sc); c1.appendChild(campoCaixa);
    var area = el('div'); area.id = 'areaFiltro'; c1.appendChild(area);
    var linha = el('div', 'linha'); var btC = el('button', 'bt sec', 'Contar quem recebe'); btC.type = 'button'; btC.id = 'btContar'; linha.appendChild(btC); c1.appendChild(linha);
    var res = el('div'); res.id = 'resContagem'; c1.appendChild(res);
    col.appendChild(c1);
    btC.addEventListener('click', function(){ contar(btC, res); });

    // 2. Mensagem
    var c2 = el('div', 'card'); c2.appendChild(titulo('2', 'Mensagem'));
    var area2 = el('div'); area2.id = 'areaModelo'; c2.appendChild(area2); col.appendChild(c2);

    // 3. Montar
    var c3 = el('div', 'card'); c3.appendChild(titulo('3', 'Montar o disparo'));
    var par = el('div', 'par');
    var cn = el('div', 'campo'); cn.appendChild(el('label', null, 'Nome da campanha')); var nome = el('input'); nome.type = 'text'; nome.maxLength = 80; nome.placeholder = 'Ex.: Reativação de novembro'; nome.id = 'nomeCamp'; cn.appendChild(nome); par.appendChild(cn);
    var cmx = el('div', 'campo'); cmx.appendChild(el('label', null, 'Máximo de pessoas')); var mx = el('input'); mx.type = 'number'; mx.min = '1'; mx.max = '500'; mx.value = '50'; mx.id = 'maxPessoas'; mx.style.width = '120px'; cmx.appendChild(mx);
    cmx.appendChild(el('small', 'dica', 'Obrigatório. A lista é cortada neste número (ficam as conversas mais recentes) e o envio nunca passa dele.')); par.appendChild(cmx);
    c3.appendChild(par);
    c3.appendChild(el('p', 'dica', 'Montar só confere a lista: nada é enviado. A aprovação vem depois.'));
    var btM = el('button', 'bt pri', 'Montar disparo'); btM.type = 'button'; btM.id = 'btMontar'; var l3 = el('div', 'linha'); l3.appendChild(btM); c3.appendChild(l3);
    col.appendChild(c3);
    btM.addEventListener('click', function(){ montar(btM, nome, mx); });
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
    var c = el('div', 'campo'); c.appendChild(el('div', 'rot', titulo)); if (ajuda) c.appendChild(el('small', 'dica', ajuda)); var chips = el('div', 'chips'); c.appendChild(chips); return { campo: c, chips: chips };
  }
  function desenharFiltro(area){
    var g = grupoDeChips('Etiquetas', 'Um toque inclui (azul), dois excluem (vermelho), três limpam.');
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
    todas.appendChild(ck); todas.appendChild(el('span', null, 'Só quem tem todas as etiquetas incluídas')); todas.appendChild(el('small', 'dica', '(sem marcar, basta uma)')); area.appendChild(todas);
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
    var dias = el('div', 'campo'); dias.appendChild(el('label', null, 'Sem conversa há pelo menos (dias)'));
    var inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.max = '730'; inp.value = '0'; inp.style.width = '110px';
    inp.addEventListener('input', function(){ F.dias = Math.max(0, Math.min(730, Number(inp.value) || 0)); invalidarContagem(); });
    dias.appendChild(inp); dias.appendChild(el('small', 'dica', '0 não filtra. Nota interna não conta como conversa.')); area.appendChild(dias);
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
  function listaDeFora(fora){
    var ul = el('ul', 'fora');
    fora.forEach(function(x){ var li = el('li'); li.appendChild(el('b', null, String(x.n))); li.appendChild(el('span', null, x.rotulo)); ul.appendChild(li); });
    return ul;
  }
  function desenharContagem(res, r){
    var f = el('div', 'fatos');
    [[r.lidas, 'conversas na caixa'], [r.noFiltro, 'passaram no filtro'], [r.total, 'devem receber', true]].forEach(function(x){ var d = el('div', x[2] ? 'destaque' : null); d.appendChild(el('b', null, String(x[0]))); d.appendChild(el('span', null, x[1])); f.appendChild(d); });
    res.appendChild(f);
    res.appendChild(el('small', 'dica', 'Estimativa. Quem pediu SAIR e a agenda da franquia só entram na conta ao montar, então o número final pode ser menor.'));
    if (r.truncada) res.appendChild(el('p', 'ruim', 'Contagem parcial: a leitura parou no limite de tempo ou de tamanho e a lista pode estar incompleta.'));
    if (r.fora.length) { res.appendChild(el('div', 'rot', 'Ficam de fora')); res.appendChild(listaDeFora(r.fora)); }
    if (r.amostra.length) {
      var t = el('table'), th = el('thead'), tr = el('tr'); ['Nome', 'Telefone'].forEach(function(h){ tr.appendChild(el('th', null, h)); }); th.appendChild(tr); t.appendChild(th);
      var tb = el('tbody'); r.amostra.forEach(function(a){ var x = el('tr'); x.appendChild(el('td', null, a.nome)); x.appendChild(el('td', null, a.telefone)); tb.appendChild(x); }); t.appendChild(tb);
      var w = el('div', 'rolar'); w.appendChild(t);
      var dt = el('details'); dt.appendChild(el('summary', null, 'Ver amostra (' + r.amostra.length + ' pessoas)')); dt.appendChild(w); res.appendChild(dt);
    }
  }

  // ── a mensagem: modelo, variáveis, prévia no celular ──
  function desenharModelo(area){
    limpar(area);
    var ok = OPC.modelos.filter(function(m){ return !m.problema; });
    if (!OPC.modelos.length) { area.appendChild(el('p', 'ruim', 'Esta caixa não tem nenhum modelo aprovado na Meta. Peça à Doutor Digital para criar e aprovar um modelo.')); return; }
    var grade = el('div', 'msg-grid'), form = el('div', 'msg-form'), lado = el('div', 'msg-fone');
    grade.appendChild(form); grade.appendChild(lado); area.appendChild(grade);
    var cm = el('div', 'campo'); cm.appendChild(el('label', null, 'Modelo aprovado'));
    var s = el('select'); var o0 = el('option', null, 'Escolha um modelo…'); o0.value = ''; s.appendChild(o0);
    OPC.modelos.forEach(function(m, i){ var o = el('option', null, m.nome + (m.problema ? ' (não dá: ' + m.problema + ')' : '')); o.value = String(i); if (m.problema) o.disabled = true; s.appendChild(o); });
    cm.appendChild(s); form.appendChild(cm);
    if (!ok.length) form.appendChild(el('p', 'ruim', 'Nenhum modelo desta caixa serve para esta tela ainda. O motivo de cada um está na lista acima.'));
    var det = el('div'); det.id = 'detModelo'; form.appendChild(det);
    var fone = celular(); fone.conversa.id = 'zapPrevia'; lado.appendChild(fone.raiz); mensagemNoCelular(fone.conversa, null);
    s.addEventListener('change', function(){ escolherModelo(s.value === '' ? null : OPC.modelos[Number(s.value)], limpar(det)); });
  }
  function escolherModelo(m, det){
    ESCOLHA = { modelo: m, fontes: [], texto: [] };
    if (!m) { var z0 = $('zapPrevia'); if (z0) mensagemNoCelular(z0, null); return; }
    for (var i = 0; i < m.variaveis; i++) { ESCOLHA.fontes.push(i === 0 ? 'primeiroNome' : 'unidade'); ESCOLHA.texto.push(''); }
    var linhaVars = el('div', 'campo');
    if (m.variaveis) linhaVars.appendChild(el('div', 'rot', 'O que entra em cada variável'));
    for (var k = 0; k < m.variaveis; k++) (function(k){
      var l = el('div', 'linha'); l.appendChild(el('span', 'pill', '{{' + (k + 1) + '}}'));
      var sel = el('select'); [['primeiroNome', 'Primeiro nome do contato'], ['unidade', 'Nome da unidade'], ['texto', 'Texto fixo']].forEach(function(x){ var o = el('option', null, x[1]); o.value = x[0]; sel.appendChild(o); });
      sel.value = ESCOLHA.fontes[k]; sel.setAttribute('aria-label', 'Variável ' + (k + 1));
      var tx = el('input'); tx.type = 'text'; tx.maxLength = 120; tx.placeholder = 'Digite o texto'; tx.setAttribute('aria-label', 'Texto fixo da variável ' + (k + 1)); tx.hidden = true;
      sel.addEventListener('change', function(){ ESCOLHA.fontes[k] = sel.value; tx.hidden = sel.value !== 'texto'; atualizarPrevia(); });
      tx.addEventListener('input', function(){ ESCOLHA.texto[k] = tx.value; atualizarPrevia(); });
      l.appendChild(sel); l.appendChild(tx); linhaVars.appendChild(l);
    })(k);
    det.appendChild(linhaVars);
    var qp = el('div', 'campo'); qp.id = 'quemPrevia'; det.appendChild(qp);
    atualizarPrevia();
  }
  function fontesParaOServidor(){ return ESCOLHA.fontes.map(function(f, i){ return f === 'texto' ? 'texto:' + (ESCOLHA.texto[i] || '').trim() : f; }); }
  function atualizarPrevia(){
    var z = $('zapPrevia'); if (!z) return;
    if (!ESCOLHA.modelo) { mensagemNoCelular(z, null); return; }
    var qEl = $('quemPrevia'); if (!qEl) return;
    var amostra = CONTA_PREVIA ? CONTA_PREVIA.amostra : [];
    var q = limpar(qEl);
    var sel = el('select'); var nomes = amostra.length ? amostra.map(function(a){ return a.nome; }) : ['Maria'];
    nomes.forEach(function(n){ var o = el('option', null, n); o.value = n; sel.appendChild(o); });
    var rotQ = el('label', 'rot', 'Prévia para'); rotQ.htmlFor = 'quemSel'; sel.id = 'quemSel'; q.appendChild(rotQ); q.appendChild(sel);
    if (!amostra.length) q.appendChild(el('small', 'dica', 'Conte quem recebe para ver com nomes de verdade.'));
    function desenhar(){
      var t = ESCOLHA.modelo.texto.replace(/\{\{\s*(\d+)\s*\}\}/g, function(_m, n){
        var f = ESCOLHA.fontes[Number(n) - 1]; if (!f) return '{{' + n + '}}';
        return f === 'primeiroNome' ? sel.value : f === 'unidade' ? U.nome : (ESCOLHA.texto[Number(n) - 1] || '…');
      });
      mensagemNoCelular(z, { cabecalho: ESCOLHA.modelo.cabecalho || null, texto: t, rodape: ESCOLHA.modelo.rodape || null, botoes: ESCOLHA.modelo.botoes || [] });
    }
    sel.addEventListener('change', desenhar); desenhar();
  }
  async function montar(bt, nome, mx){
    if (!ESCOLHA || !ESCOLHA.modelo) { toast('Escolha um modelo.', true); return; }
    var fontes = fontesParaOServidor();
    for (var i = 0; i < fontes.length; i++) if (fontes[i] === 'texto:') { toast('Preencha o texto fixo da variável {{' + (i + 1) + '}}.', true); return; }
    var maximo = Math.floor(Number(mx.value));
    if (!(maximo >= 1 && maximo <= 500)) { toast('Diga o máximo de pessoas (de 1 a 500).', true); mx.focus(); return; }
    if (!nome.value.trim() || nome.value.trim().length < 3) { toast('Dê um nome à campanha.', true); nome.focus(); return; }
    bt.disabled = true; bt.textContent = 'Montando…';
    try {
      var r = await api('POST', '/api/public/disparos/ondas', { slug: U.slug, nome: nome.value.trim(), maximo: maximo, filtro: filtroParaOServidor(), modelo: { nome: ESCOLHA.modelo.nome, idioma: ESCOLHA.modelo.idioma, variaveis: fontes } });
      toast('Disparo criado: montando a lista…'); await carregar(); abrirOnda(r.id);
    } catch (e) { toast(e.message, true); bt.disabled = false; bt.textContent = 'Montar disparo'; }
  }

  // ── RELATÓRIO ──
  function brl(v){ try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v); } catch (e) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); } }
  function pct(n, t){ return t ? Math.round((n / t) * 100) + '%' : '—'; }
  function numeroComPct(n, base){ return base == null ? String(n) : n + ' (' + pct(n, base) + ')'; }
  async function mostrarRelatorio(){
    pararPoll(); atualId = null; ONDA = null; desenharLista();
    var p = limpar($('palco')), col = el('div', 'col'); p.appendChild(col);
    col.appendChild(faixaDoModo());
    var c = el('div', 'card'); c.appendChild(el('h2', null, 'Relatório por campanha')); col.appendChild(c);
    var corpo = el('p', 'mudo', 'Carregando…'); c.appendChild(corpo);
    var r;
    try { r = await api('GET', '/api/public/disparos/relatorio?slug=' + enc(U.slug)); } catch (e) { corpo.textContent = e.message; corpo.className = 'ruim'; return; }
    if (!r.campanhas.length) { corpo.textContent = 'Nenhum disparo ainda.'; return; }
    c.removeChild(corpo);
    var t = el('table'), th = el('thead'), tr = el('tr');
    ['Campanha', 'Selecionadas', 'Enviadas', 'Entregues', 'Lidas', 'Responderam (72 h)', 'Pediram SAIR', 'Falharam', 'Incertas', 'Gasto (estimado)'].forEach(function(h){ tr.appendChild(el('th', null, h)); }); th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody');
    r.campanhas.forEach(function(k){
      var n = k.numeros, x = el('tr'), nome = el('td'); var a = el('a', null, k.nome); a.href = '#'; a.addEventListener('click', function(ev){ ev.preventDefault(); abrirOnda(k.id); }); nome.appendChild(a);
      nome.appendChild(el('br')); nome.appendChild(el('small', 'mudo', (ESTADO[k.estado] || k.estado) + ' · ' + quando(k.criadoEm)));
      if (k.categoriaAssumida) { nome.appendChild(el('br')); nome.appendChild(el('small', 'mudo', 'Categoria não informada pelo CRM: preço de marketing')); }
      x.appendChild(nome);
      [n.selecionadas, numeroComPct(n.enviadas, n.selecionadas), numeroComPct(n.entregues, n.enviadas), numeroComPct(n.lidas, n.enviadas), numeroComPct(n.responderam, n.enviadas), numeroComPct(n.pediramSair, n.enviadas), n.falharam, n.incertas || 0, k.gastoEstimadoBrl == null ? '—' : brl(k.gastoEstimadoBrl) + (k.gastoComReserva ? ' (reserva)' : '')].forEach(function(v){ x.appendChild(el('td', null, String(v))); });
      tb.appendChild(x);
    });
    t.appendChild(tb); var w = el('div', 'rolar'); w.appendChild(t); c.appendChild(w);
    c.appendChild(el('small', 'dica', 'Entregue, lida e respondeu vêm da última conferência do CRM (a cada 5 minutos, por 72 h depois do envio). Quem pediu SAIR não conta como resposta. Em modo seco tudo fica em zero, porque nada foi enviado.'));
  }

  // ── UM DISPARO ──
  async function abrirOnda(id){
    pararPoll(); atualId = id; desenharLista();
    var lido;
    try { lido = await api('GET', '/api/public/disparos/ondas/' + enc(id) + '?slug=' + enc(U.slug)); }
    catch (e) { if (atualId === id) { var p0 = limpar($('palco')); p0.appendChild(el('div', 'faixa erro', e.message)); } return; }
    if (atualId !== id) return; // a pessoa já abriu outro disparo (ou Novo disparo): a resposta velha não apaga a tela dela
    ONDA = lido; desenharOnda();
    if (ONDA.estado === 'montando') {
      tPoll = setTimeout(function(){
        if (atualId !== id) return;
        carregar().then(function(){ abrirOnda(id); }).catch(function(e){ if (atualId === id) { aviso(e.message + ' Recarregue a tela.', true); } });
      }, 3500);
    }
  }
  function fato(f, valor, rotulo, destaque){ var d = el('div', destaque ? 'destaque' : null), m = /^(\S+) \((\S+)\)$/.exec(String(valor)); d.appendChild(el('b', null, m ? m[1] : String(valor))); d.appendChild(el('span', null, m ? rotulo + ' · ' + m[2] : rotulo)); f.appendChild(d); }
  function kv(dl, k, v){ dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
  function desenharOnda(){
    var o = ONDA, p = limpar($('palco')), col = el('div', 'col'); p.appendChild(col);
    col.appendChild(faixaDoModo(o.modo));
    var c = el('div', 'card'); var h = el('h2', null, o.nome); h.appendChild(pillEstado(o.estado)); c.appendChild(h);
    c.appendChild(el('p', 'dica', 'Modelo ' + o.modelo.nome + ' (' + o.modelo.idioma + ') · Público: ' + o.filtro));
    if (o.pausaMotivo) c.appendChild(el('p', 'ruim', (o.estado === 'cancelada' ? 'Motivo: ' : 'Parada: ') + o.pausaMotivo));
    if (o.aprovadaPor) c.appendChild(el('p', 'dica', 'Aprovada por ' + o.aprovadaPor + ' em ' + quando(o.aprovadaEm) + (o.aprovadaModo && o.aprovadaModo !== 'ligado' ? ' com a unidade em ' + (o.aprovadaModo === 'seco' ? 'modo seco' : 'modo desligado') + ': não vale como aprovação de envio.' : '.')));
    var f = el('div', 'fatos'); fato(f, o.total, 'pessoas', true); fato(f, o.candidatos == null ? '—' : o.candidatos, 'passaram no filtro'); fato(f, o.contagem.enviado || 0, 'enviadas'); fato(f, o.simulados, 'receberiam (seco)'); fato(f, (o.contagem.falhou || 0) + (o.contagem.saiu || 0) + (o.contagem.descartado || 0), 'falhas, SAIR e saídas'); c.appendChild(f);
    col.appendChild(c);

    var duas = el('div', 'duas'), topo = el('div', 'topo-onda'), lateral = el('div', 'lateral'), resto = el('div', 'resto-onda');
    duas.appendChild(topo); duas.appendChild(lateral); duas.appendChild(resto); col.appendChild(duas);

    // a mensagem, no celular
    var cz = el('div', 'card'); cz.appendChild(el('h2', null, 'Como a pessoa recebe'));
    var fone = celular(); cz.appendChild(fone.raiz);
    var exs = o.exemplos.length ? o.exemplos : [o.modelo.texto];
    function mostrarEx(i){ mensagemNoCelular(fone.conversa, { cabecalho: o.modelo.cabecalho || null, texto: exs[i], rodape: o.modelo.rodape || null, botoes: o.modelo.botoes || [] }); }
    mostrarEx(0);
    if (exs.length > 1) {
      var troca = el('div', 'cel-troca');
      exs.forEach(function(_t, i){
        var b = el('button', 'chip', 'Exemplo ' + (i + 1)); b.type = 'button'; b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
        b.addEventListener('click', function(){ Array.prototype.forEach.call(troca.children, function(x){ x.setAttribute('aria-pressed', 'false'); }); b.setAttribute('aria-pressed', 'true'); mostrarEx(i); });
        troca.appendChild(b);
      });
      cz.appendChild(troca);
    }
    if (o.estado === 'montada' && o.conferencia) cz.appendChild(el('p', o.conferencia.ok ? 'bom' : 'ruim', o.conferencia.ok ? 'Conferido no CRM: modelo aprovado e texto igual.' : 'O CRM não confere: ' + o.conferencia.motivo));
    lateral.appendChild(cz);

    // custo e ritmo
    if (o.custo && o.estado !== 'montando' && o.total > 0) topo.appendChild(cartaoDeCusto(o));

    // ações (aprovar / cancelar)
    var ca = el('div', 'card'); var la = el('div', 'linha');
    if (o.estado === 'montada') {
      var ba = el('button', 'bt pri', 'Aprovar este disparo (' + o.total + ' pessoas)'); ba.type = 'button';
      // A caixa da confirmação existe SEMPRE e aparece quando o custo é sem histórico — ou quando o SERVIDOR acha isso na hora de aprovar (o custo mudou desde que a tela abriu).
      var cf0 = el('label', 'confirma'); var confirmaCusto = el('input'); confirmaCusto.type = 'checkbox'; confirmaCusto.id = 'confirmaCusto'; cf0.appendChild(confirmaCusto);
      cf0.appendChild(el('span', null, o.custo && o.custo.categoriaAssumida ? 'Estou ciente: o CRM não informou a categoria deste modelo, então o valor é estimado pelo preço de marketing. Quero aprovar mesmo assim.' : 'Estou ciente: não há histórico de custo da Meta para este modelo, então o valor é estimado com preço de reserva. Quero aprovar mesmo assim.')); ca.appendChild(cf0);
      cf0.style.display = o.custo && !o.custo.conhecido ? '' : 'none';
      var liberar = function(){ ba.disabled = !(o.podeAprovar && o.conferencia && o.conferencia.ok) || (cf0.style.display !== 'none' && !confirmaCusto.checked); };
      confirmaCusto.addEventListener('change', liberar);
      liberar();
      ba.addEventListener('click', function(){
        var seco = o.modo !== 'ligado';
        if (!confirm(seco ? 'Aprovar com a unidade em ' + (o.modo === 'seco' ? 'SECO' : 'modo DESLIGADO') + '? Nada será enviado: só fica registrado quem receberia.' : 'Aprovar o envio para ' + o.total + ' pessoas (máximo ' + o.maximo + ')' + (o.custo && o.custo.conhecido ? ', custo estimado ' + brl(o.custo.brl) : ', ' + (o.custo.categoriaAssumida ? 'categoria não informada pelo CRM, custo estimado pelo preço de marketing ' : 'custo estimado com preço de reserva ') + brl(o.custo.brl)) + '? As mensagens saem sozinhas, em ondas.')) return;
        ba.disabled = true;
        api('POST', '/api/public/disparos/ondas/' + enc(o.id) + '/aprovar', { slug: U.slug, total: o.total, impressao: o.impressao, maximo: o.maximo, confirmarCustoDesconhecido: !!(confirmaCusto && confirmaCusto.checked) }).then(function(){ toast('Aprovado.'); return carregar().then(function(){ abrirOnda(o.id); }); }).catch(function(e){ toast(e.message, true); if (e.corpo && e.corpo.precisaConfirmarCusto) { cf0.style.display = ''; confirmaCusto.checked = false; } liberar(); });
      });
      la.appendChild(ba);
      if (!o.podeAprovar) ca.appendChild(el('p', 'dica', o.motivoSemAprovar || 'Você não pode aprovar.'));
      else if (!(o.conferencia && o.conferencia.ok)) ca.appendChild(el('p', 'dica', 'A aprovação fica travada até o CRM confirmar o modelo.'));
    }
    if (['montando', 'montada', 'aprovada', 'pausada'].indexOf(o.estado) >= 0) {
      var bc = el('button', 'bt perigo', o.estado === 'aprovada' || o.estado === 'pausada' ? 'Parar e cancelar' : 'Cancelar'); bc.type = 'button';
      bc.addEventListener('click', function(){
        if (!confirm('Cancelar este disparo?')) return; bc.disabled = true;
        api('POST', '/api/public/disparos/ondas/' + enc(o.id) + '/cancelar', { slug: U.slug, motivo: 'cancelado na tela Disparos' }).then(function(){ toast('Cancelado.'); return carregar().then(function(){ abrirOnda(o.id); }); }).catch(function(e){ toast(e.message, true); bc.disabled = false; });
      });
      la.appendChild(bc);
    }
    if (o.estado === 'pausada') ca.appendChild(el('p', 'dica', 'Os freios pausaram este disparo e não dá para retomar por aqui. Cancele e monte de novo depois de resolver o motivo.'));
    if (la.childNodes.length) { ca.appendChild(la); topo.appendChild(ca); }

    // relatório do envio
    if (o.relatorio && o.relatorio.numeros.enviadas + o.relatorio.numeros.falharam + o.relatorio.numeros.incertas > 0) {
      var cr = el('div', 'card'); cr.appendChild(el('h2', null, 'Relatório')); var n = o.relatorio.numeros, fr2 = el('div', 'fatos');
      if (o.gastoEstimadoBrl != null) fato(fr2, brl(o.gastoEstimadoBrl), o.gastoComReserva ? 'gasto até agora (teto, preço de reserva)' : 'gasto até agora (estimado)', true);
      fato(fr2, n.enviadas, 'enviadas'); fato(fr2, numeroComPct(n.entregues, n.enviadas), 'entregues'); fato(fr2, numeroComPct(n.lidas, n.enviadas), 'lidas'); fato(fr2, numeroComPct(n.responderam, n.enviadas), 'responderam (até 72 h)'); fato(fr2, numeroComPct(n.pediramSair, n.enviadas), 'pediram para sair'); fato(fr2, n.falharam, 'falharam'); if (n.incertas) fato(fr2, n.incertas, 'incertas (podem ter saído; não reenvia)');
      cr.appendChild(fr2);
      if (o.relatorio.porHora.length) { var ul2 = el('ul', 'horas'); o.relatorio.porHora.forEach(function(h){ ul2.appendChild(el('li', null, quandoHora(h.hora) + ': ' + h.enviadas + ' enviadas')); }); cr.appendChild(el('div', 'rot', 'Envios por hora (' + (o.relatorio.fuso || 'America/Sao_Paulo') + ')')); cr.appendChild(ul2); }
      cr.appendChild(el('small', 'dica', 'Entregue, lida e respondeu vêm da última conferência do CRM (a cada 5 minutos, por 72 h depois do envio).'));
      resto.appendChild(cr);
    }

    // exclusões
    var ce = el('div', 'card'); ce.appendChild(el('h2', null, 'Quem ficou de fora, e por quê'));
    if (o.fora.length) ce.appendChild(listaDeFora(o.fora)); else ce.appendChild(el('p', null, 'Ninguém ficou de fora pelas regras.'));
    if (o.truncada) ce.appendChild(el('p', 'ruim', 'A leitura da caixa parou no limite (de tempo ou de tamanho) e a lista pode estar incompleta.'));
    resto.appendChild(ce);

    // freios (recolhido, com o resumo na linha)
    var cf = el('div', 'card'); var dtf = el('details'), fr = o.freios;
    var sm = el('summary', null, 'Os freios '); sm.appendChild(el('span', 'dica', '· janela ' + fr.janela + ', até ' + fr.tetoPorHora + ' por hora')); dtf.appendChild(sm);
    var fl = el('ul', 'lis');
    [['Janela de envio: ' + fr.janela + '.'], ['Teto: ' + fr.tetoPorHora + ' por hora e ' + fr.tetoPorDia + ' por 24 horas' + (fr.tetoDoTier ? ' (o número está no ' + fr.tier + ', ' + fr.tetoDoTier + ' por dia na Meta)' : '') + '.'], ['Para tudo se mais de ' + fr.maxSair + ' pessoas responderem SAIR, e pausa se ' + fr.falhasSeguidas + ' envios seguidos falharem.'],
      [fr.comAgenda ? 'Reconfere a agenda da franquia (consulta marcada, tratamento aberto) e o SAIR na hora de cada envio.' : 'Esta unidade não tem a agenda da franquia ligada. A conferência de paciente é pela etapa do CRM (agendado, em tratamento, fechou) e o SAIR é conferido na hora de cada envio.'], ['Nunca duas vezes para a mesma pessoa, nem para quem recebeu outro disparo nos últimos 7 dias.']].forEach(function(x){ fl.appendChild(el('li', null, x[0])); });
    dtf.appendChild(fl); cf.appendChild(dtf); resto.appendChild(cf);

    // pessoa por pessoa
    var cp = el('div', 'card'); cp.appendChild(el('h2', null, 'Pessoa por pessoa'));
    if (o.destinatarios.length) {
      var t = el('table'), th = el('thead'), tr = el('tr'); ['Nome', 'Telefone', 'Estado', 'Quando', 'Motivo'].forEach(function(x){ tr.appendChild(el('th', null, x)); }); th.appendChild(tr); t.appendChild(th);
      var tb = el('tbody');
      o.destinatarios.forEach(function(d){
        var x = el('tr'); x.appendChild(el('td', null, d.nome)); x.appendChild(el('td', null, d.telefone));
        var ce2 = el('td'); ce2.appendChild(el('span', 'pill ' + (CLASSE_DEST[d.estado] || 'mudo'), ROTULO_ESTADO[d.estado] || d.estado)); x.appendChild(ce2);
        x.appendChild(el('td', null, d.enviadoEm ? quando(d.enviadoEm) : d.simuladoEm ? 'receberia (seco) ' + quando(d.simuladoEm) : '—')); x.appendChild(el('td', 'mudo', d.motivo || '—')); tb.appendChild(x);
      });
      t.appendChild(tb); var w = el('div', 'rolar'); w.appendChild(t); cp.appendChild(w);
      if (o.total > o.destinatariosMostrados) cp.appendChild(el('small', 'dica', 'Mostrando ' + o.destinatariosMostrados + ' de ' + o.total + ' pessoas.'));
    } else cp.appendChild(el('p', 'mudo', o.estado === 'montando' ? 'Montando a lista… esta tela atualiza sozinha.' : 'Sem destinatários.'));
    resto.appendChild(cp);

    // ajuste (só a Doutor Digital)
    if (D.podeAjustar) resto.appendChild(cartaoDeAjuste());
  }
  // O CUSTO e o RITMO: o que a pessoa lê ANTES de aprovar (e depois, como o gasto até agora)
  function cartaoDeCusto(o){
    var c = el('div', 'card'); c.appendChild(el('h2', null, 'Custo e ritmo')); var k = o.custo, r = o.ritmo;
    var caixa = el('div', 'custo' + (k.conhecido ? '' : ' desconhecido'));
    if (k.conhecido) {
      caixa.appendChild(el('div', 'valor', 'cerca de ' + brl(k.brl)));
      caixa.appendChild(el('div', null, o.total + ' pessoas × ' + brl(k.porMensagemBrl) + ' por mensagem (modelo de categoria ' + k.categoria + ')'));
    } else if (k.categoriaAssumida) {
      caixa.appendChild(el('div', 'valor', 'até ' + brl(k.brl)));
      caixa.appendChild(el('div', null, 'O CRM não informou a categoria do modelo, então vale o preço de marketing, o mais caro: ' + o.total + ' pessoas × ' + brl(k.porMensagemBrl) + ' por mensagem. Se for de outra categoria, o custo real é menor. Aprovar exige a sua confirmação.'));
    } else {
      caixa.appendChild(el('div', 'valor', 'até ' + brl(k.brl)));
      caixa.appendChild(el('div', null, 'Sem histórico da Meta para este modelo, então vale o preço de reserva: ' + o.total + ' pessoas × ' + brl(k.porMensagemBrl) + ' por mensagem. Ele é alto de propósito e o gasto real tende a ser menor. Aprovar exige a sua confirmação.'));
    }
    var dn = el('details'); dn.appendChild(el('summary', null, 'Como o valor foi calculado')); dn.appendChild(el('small', 'dica', k.nota)); caixa.appendChild(dn); c.appendChild(caixa);
    var dl = el('dl', 'kv');
    kv(dl, 'Máximo de pessoas', (o.maximo == null ? '—' : o.maximo) + ' (a lista foi cortada nele e o envio nunca o passa)');
    if (r) {
      var porque = r.limitadoPor === 'gasto' ? 'o teto de gasto' : r.limitadoPor === 'hora' ? 'o teto por hora' : 'o teto por dia';
      kv(dl, 'Ritmo', 'até ' + r.porDia + ' por dia (' + r.porHora + ' por hora, ' + r.horasDaJanela + ' h de janela), limitado por ' + porque + '. Num dia cheio, sem contar o que já foi gasto hoje.');
      kv(dl, 'Prazo', r.dias == null ? 'Com estes tetos o disparo não anda.' : 'cerca de ' + r.dias + (r.soDiasUteis ? ' dia(s) útil(eis)' : ' dia(s)') + ' depois de aprovado');
    }
    kv(dl, 'Teto de gasto', brl(o.freios.tetoReaisDia) + ' por dia, por número. As unidades e os disparos que dividem o número somam. Ao atingir, o envio para e a Doutor Digital é avisada.');
    if (o.gastoDoNumero24hBrl != null) kv(dl, 'Gasto do número, 24 h', brl(o.gastoDoNumero24hBrl) + (o.cabemPeloGasto != null ? ' (ainda cabem cerca de ' + o.cabemPeloGasto + ' mensagens deste modelo no teto)' : ''));
    if (o.gastoEstimadoBrl != null && o.relatorio && o.relatorio.numeros.enviadas > 0) kv(dl, 'Gasto deste disparo', brl(o.gastoEstimadoBrl) + (o.gastoComReserva ? ' (estimado com preço de reserva: é um teto, o real tende a ser menor)' : ' (estimado pelas enviadas)'));
    c.appendChild(dl); return c;
  }
  function cartaoDeAjuste(){
    var c = el('div', 'card'); c.appendChild(el('h2', null, 'Ajustes da unidade')); c.appendChild(el('small', 'dica', 'Só a Doutor Digital vê.'));
    var l1 = el('label', 'linha'); var ck = el('input'); ck.type = 'checkbox'; ck.checked = !!D.ajuste.gerenteAprova; l1.appendChild(ck); l1.appendChild(el('span', null, 'A administradora da clínica também pode aprovar disparos (desligado por padrão)')); c.appendChild(l1);
    var l2 = el('div', 'linha'); l2.appendChild(el('span', 'mudo', 'Tier do número na Meta:')); var tier = el('input'); tier.type = 'text'; tier.maxLength = 14; tier.placeholder = 'TIER_250'; tier.setAttribute('aria-label', 'Tier do número na Meta'); tier.value = D.ajuste.tierDoNumero || ''; tier.style.width = '130px'; l2.appendChild(tier); c.appendChild(l2);
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
