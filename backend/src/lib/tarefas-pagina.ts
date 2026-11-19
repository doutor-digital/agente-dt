/**
 * A tela «Tarefas» do Chatwoot (18/11/2026): mensagem agendada ao paciente, ligação com lembrete e lembrete simples, para as meninas da recepção.
 * Abre de dois jeitos, a mesma página: no MENU do CRM (todas as tarefas da unidade) e como ABA dentro da conversa (Dashboard App), onde recebe a conversa
 * aberta por postMessage (`appContext`) e agenda direto para ela. Mesmo visual da tela Disparos: Inter, os mesmos tokens de cor, claro/escuro pelo navegador,
 * a prévia da mensagem num celular com o WhatsApp.
 *
 * A sessão chega do menu do Chatwoot por postMessage (`funil:pede-sessao` → `funil-sessao`, com checagem de origem); a conta vem do `?conta=N` do iframe
 * (só um PEDIDO: o servidor confere). Todo texto que vem do servidor entra por textContent (nunca innerHTML). O JavaScript não usa crase nem `${`, nem
 * `?.`, `??` ou lookbehind (iPhone antigo derruba o script inteiro): a página é um String.raw e só `__ORIGEM_CW__` e `__LOGO_DD__` são trocados.
 */
import { LOGO_DD_PNG } from './marca-dd.js';
import { comContaNaPagina } from './conta-no-navegador.js';
import { comSalvarNaPagina } from './tarefas-salvar-na-pagina.js';

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tarefas</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap" rel="stylesheet">
<style>
:root{--app:#f7f7f7;--side:#fff;--canvas:#f0f0f3;--node:#fff;--ink:#1c2024;--ink-2:#60646c;--line:#e2e3e7;--brand:#2781f6;--brand-soft:#e9f3ff;--send:#29a71a;--stop:#8b8d98;--ruim:#ca244d;--aviso:#8f5300;--aviso-forte:#ffb224;--chat:#efeae2;--rec:#fff;--rec-ink:#111b21;--wa-top:#008069;--wa-sub:#667781;--wa-link:#027eb5;--dia:#fff;--bisel:#0c0d0f;--shadow:0 1px 2px rgba(28,32,36,.06),0 6px 18px rgba(28,32,36,.08);--f-ui:Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif;--f-head:Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--app:#1c1d20;--side:#17171a;--canvas:#18191b;--node:#1d1e24;--ink:#edeef0;--ink-2:#b0b4ba;--line:#2e2d32;--brand:#2781f6;--brand-soft:#0f2748;--ruim:#ff6b8f;--aviso:#ffca16;--chat:#0b141a;--rec:#202c33;--rec-ink:#e9edef;--wa-top:#1f2c34;--wa-sub:#8696a0;--wa-link:#53bdeb;--dia:#182229;--bisel:#2a2c31;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px rgba(0,0,0,.35)}}
*{box-sizing:border-box}html{min-height:100%}
body{margin:0;background:var(--app);color:var(--ink);font:14px/1.45 var(--f-ui);min-height:100%;padding:0 max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px))}
[hidden]{display:none!important}
.topo{display:flex;align-items:center;gap:10px;padding-block:12px;flex-wrap:wrap}
.logo{width:28px;height:28px;display:block;flex:none}
.topo b{font:700 17px var(--f-head)}
.topo .un{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--ink-2);font-size:13px}
select,input[type=text],input[type=tel],input[type=search],input[type=datetime-local],textarea{font:500 14px var(--f-ui);color:var(--ink);background:var(--node);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-height:38px;max-width:100%}
textarea{width:100%;resize:vertical;min-height:84px;font-weight:400;line-height:1.4}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font:600 12px var(--f-ui);background:var(--brand-soft);color:var(--brand);white-space:nowrap}
.pill.seco{background:color-mix(in srgb,var(--aviso-forte) 22%,transparent);color:var(--aviso)}
.pill.vivo{background:color-mix(in srgb,var(--send) 18%,transparent);color:var(--send)}
.pill.off,.pill.mudo{background:var(--app);color:var(--ink-2);border:1px solid var(--line)}
.pill.ruim{background:color-mix(in srgb,var(--ruim) 15%,transparent);color:var(--ruim)}
.pill.est::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.faixa{margin:0 0 12px;padding:11px 14px;border:1px solid var(--line);border-left-width:5px;border-radius:10px;background:var(--node);font-size:13.5px;display:flex;gap:4px 10px;flex-wrap:wrap;align-items:baseline}
.faixa b{font:700 14px var(--f-head)}
.faixa .como{flex-basis:100%}.faixa .como p{margin:2px 0 4px}.faixa .como summary{font-weight:500;color:var(--ink-2);display:inline-block}
.faixa.seco{border-color:var(--aviso-forte);background:color-mix(in srgb,var(--aviso-forte) 12%,var(--node))}
.faixa.vivo{border-color:var(--send)}
.faixa.erro{border-color:var(--ruim);color:var(--ruim)}
.faixa.conv{border-color:var(--brand);background:var(--brand-soft)}
.palco{max-width:980px}
.barra{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.abas{display:flex;gap:4px;flex-wrap:wrap;background:var(--node);border:1px solid var(--line);border-radius:11px;padding:3px}
.aba{appearance:none;border:0;background:transparent;color:var(--ink-2);border-radius:8px;padding:7px 12px;min-height:36px;font:600 13.5px var(--f-ui);cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.aba[aria-pressed=true]{background:var(--brand-soft);color:var(--brand)}
.aba .n{font:700 11.5px var(--f-ui);background:var(--app);border:1px solid var(--line);color:var(--ink-2);border-radius:999px;padding:0 7px;min-width:20px;text-align:center;line-height:18px}
.aba .n.alerta{background:var(--ruim);border-color:var(--ruim);color:#fff}
.barra .dir{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bt{appearance:none;border:0;border-radius:9px;padding:9px 14px;min-height:40px;font:600 13.5px var(--f-ui);cursor:pointer;display:inline-flex;gap:6px;align-items:center;justify-content:center;white-space:nowrap}
.bt.pri{background:var(--brand);color:#fff}.bt.sec{background:var(--node);color:var(--ink);border:1px solid var(--line)}.bt.perigo{background:var(--node);color:var(--ruim);border:1px solid var(--ruim)}
.bt.peq{min-height:34px;padding:6px 11px;font-size:13px}
.bt:disabled{opacity:.5;cursor:default}
.bt:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible,.chip:focus-visible,.aba:focus-visible,summary:focus-visible,.seg button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.lista{display:grid;gap:10px}
.tar{background:var(--node);border:1px solid var(--line);border-radius:14px;padding:14px;display:grid;gap:8px;box-shadow:var(--shadow);min-width:0}
.tar.atrasada{border-left:5px solid var(--ruim)}
.tar.confirme{border-left:5px solid var(--aviso-forte)}
.tar-topo{display:flex;gap:10px;align-items:flex-start}
.tar-ico{width:34px;height:34px;border-radius:10px;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;flex:none}
.tar-ico svg{width:18px;height:18px}
.tar-ico.lig{background:color-mix(in srgb,var(--send) 16%,transparent);color:var(--send)}
.tar-ico.lem{background:color-mix(in srgb,var(--aviso-forte) 24%,transparent);color:var(--aviso)}
.tar-quem{min-width:0;flex:1;display:grid;gap:1px}
.tar-quem b{font:600 14.5px var(--f-ui);overflow-wrap:anywhere}
.tar-quem span{color:var(--ink-2);font-size:12.5px}
.tar-texto{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.tar-nota{margin:0;font-size:12.5px;color:var(--ink-2);overflow-wrap:anywhere}
.tar-nota.ruim{color:var(--ruim)}.tar-nota.seco{color:var(--aviso)}
.tar-acoes{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.painel{border:1px solid var(--line);border-radius:11px;padding:12px;display:grid;gap:10px;background:color-mix(in srgb,var(--ink) 3%,var(--node))}
.painel h3{margin:0;font:600 13.5px var(--f-ui)}
.vazio{padding:28px 14px;color:var(--ink-2);text-align:center;background:var(--node);border:1px dashed var(--line);border-radius:14px}
.card{background:var(--node);border:1px solid var(--line);border-radius:14px;padding:16px;display:grid;gap:14px;box-shadow:var(--shadow);min-width:0;margin-bottom:14px}
.card h2{margin:0;font:700 16px var(--f-head)}
.card p{margin:0;color:var(--ink-2)}
.campo{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:6px}.campo>select,.campo>input{width:100%}.campo>label,.rot{font:600 13px var(--f-ui);color:var(--ink)}
.dica{color:var(--ink-2);font-size:12.5px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{appearance:none;border:1px solid var(--line);background:var(--app);color:var(--ink);border-radius:999px;padding:5px 12px;min-height:32px;font:500 13px var(--f-ui);cursor:pointer}
.chip[aria-pressed=true]{background:var(--brand-soft);border-color:var(--brand);color:var(--brand);font-weight:600}
.seg{display:inline-flex;justify-self:start;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--node);max-width:100%}
.seg button{appearance:none;border:0;background:transparent;color:var(--ink);padding:8px 14px;min-height:38px;font:600 13.5px var(--f-ui);cursor:pointer;border-right:1px solid var(--line)}
.seg button:last-child{border-right:0}
.seg button[aria-pressed=true]{background:var(--brand);color:#fff}
.linha{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.par{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:start;gap:12px}
.achados{display:grid;gap:4px}
.achado{appearance:none;text-align:left;border:1px solid var(--line);background:var(--node);color:var(--ink);border-radius:9px;padding:8px 10px;min-height:38px;font:500 13.5px var(--f-ui);cursor:pointer;display:flex;gap:8px;justify-content:space-between}
.achado span{color:var(--ink-2)}
.alvo{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--brand);background:var(--brand-soft);border-radius:9px}
.mudo{color:var(--ink-2)}.ruim{color:var(--ruim)}.bom{color:var(--send)}
.toast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--app);padding:10px 16px;border-radius:10px;font-size:13.5px;z-index:50;max-width:92vw}
.toast.erro{background:#ca244d;color:#fff}
details>summary{cursor:pointer;font:600 13px var(--f-ui);color:var(--ink);padding:4px 0}
details[open]>summary{margin-bottom:8px}
.zaps{display:grid;gap:8px}
.zap{display:grid;grid-template-columns:minmax(0,1fr) minmax(130px,170px) auto auto;gap:8px;align-items:center}
.zap b{font:600 13.5px var(--f-ui);overflow-wrap:anywhere}
@media (max-width:560px){.zap{grid-template-columns:1fr 1fr}.zap b{grid-column:1/-1}}
.msg-grid{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.msg-form{flex:1 1 280px;min-width:0;display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:12px}
.msg-fone{flex:0 0 auto;margin-inline:auto;display:grid;gap:8px;justify-items:center}
.cel{width:272px;max-width:100%;background:var(--bisel);border-radius:40px;padding:9px;box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 14%,transparent),0 14px 30px rgba(0,0,0,.22);position:relative}
.cel-tela{border-radius:31px;overflow:hidden;background:var(--chat);display:flex;flex-direction:column;min-height:380px;max-height:520px}
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
@media (max-width:520px){.abas{flex-wrap:nowrap;max-width:100%;overflow-x:auto}.aba{padding:7px 9px;flex:none}body{padding-left:max(12px,env(safe-area-inset-left,0px));padding-right:max(12px,env(safe-area-inset-right,0px))}.card{padding:14px}.topo .un{margin-left:0;width:100%}.barra .dir{margin-left:0;width:100%}.barra .dir .bt{flex:1}.cel-tela{min-height:380px}}
</style></head><body>
<div class="topo"><img class="logo" src="__LOGO_DD__" alt="Doutor Digital" width="28" height="28"><b>Tarefas</b>
  <span class="un"><span id="modo" class="pill off" hidden></span><select id="unidadeSel" hidden aria-label="Unidade"></select><span id="unidadeNome"></span></span></div>
<div id="avisos"></div>
<div class="palco" id="corpo" hidden>
  <div id="faixaModo"></div>
  <div id="faixaConversa"></div>
  <div id="faixaZap"></div>
  <div id="faixaLimite"></div>
  <div class="barra">
    <div class="abas" id="abas" role="group" aria-label="Quais tarefas"></div>
    <div class="dir"><select id="quemSel" aria-label="De quem"></select><button class="bt pri" type="button" id="btNova">Nova tarefa</button></div>
  </div>
  <div id="formArea"></div>
  <div class="lista" id="lista"></div>
  <div id="zapArea"></div>
</div>
<div id="toast" class="toast" role="status" hidden></div>
<script>
(function(){
  var CW = __ORIGEM_CW__, S = null, U = null, UNIDADES = [], D = null, ABA = 'hoje', QUEM = 'minhas', CONV = null, SO_CONV = true, FORM = null, tPoll = null, CARREGANDO = false, PAINEL = null;
  var MENU = /[?&]menu=1/.test(location.search);
  var $ = function(id){ return document.getElementById(id); };
  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function limpar(n){ while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function guardar(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function lerGuardado(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }
  var tToast = null;
  function toast(txt, erro){ var t = $('toast'); t.textContent = txt; t.className = 'toast' + (erro ? ' erro' : ''); t.hidden = false; clearTimeout(tToast); tToast = setTimeout(function(){ t.hidden = true; }, 5200); }
  function aviso(txt, erro){ var a = $('avisos'); limpar(a); if (txt) a.appendChild(el('div', 'faixa' + (erro ? ' erro' : ''), txt)); }

  // ── servidor (com o login do Chatwoot de quem está usando) ──
  /*__CONTA_JS__*/
  /*__SALVAR_JS__*/
  function cab(){ var h = { 'Content-Type': 'application/json' }; if (S) { h['X-CW-Token'] = S.token; h['X-CW-Client'] = S.client; h['X-CW-Uid'] = S.uid; } return h; }
  function pedirSessao(){ try { window.parent.postMessage({ event: 'funil:pede-sessao' }, CW); } catch (e) {} }
  async function api(method, path, body){
    // rede que cai ou demora demais: erro SEM status (não se sabe se o servidor chegou a gravar) e sem o «Failed to fetch» cru do navegador
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var corte = ctl ? setTimeout(function(){ ctl.abort(); }, 45000) : null;
    var r;
    try { r = await fetch(comConta(path), { method: method, headers: cab(), body: method === 'GET' ? undefined : JSON.stringify(body || {}), signal: ctl ? ctl.signal : undefined }); }
    catch (e0) { var er0 = new Error('Sem resposta do servidor (a conexão caiu ou demorou demais).'); er0.semResposta = true; throw er0; }
    finally { if (corte) clearTimeout(corte); }
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { var er = new Error(j.error || ('erro ' + r.status)); er.corpo = j; er.status = r.status; if (r.status === 401) { S = null; pedirSessao(); } throw er; }
    return j;
  }
  function enc(x){ return encodeURIComponent(x); }

  // ── datas: sempre no relógio da unidade ──
  function fusoDaUnidade(){ return (D && D.fuso) || 'America/Sao_Paulo'; }
  function partes(d){
    var o = { ano: 0, mes: 0, dia: 0, hora: 0, min: 0 };
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: fusoDaUnidade(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).forEach(function(p){
        if (p.type === 'year') o.ano = Number(p.value); else if (p.type === 'month') o.mes = Number(p.value); else if (p.type === 'day') o.dia = Number(p.value);
        else if (p.type === 'hour') o.hora = Number(p.value) % 24; else if (p.type === 'minute') o.min = Number(p.value);
      });
    } catch (e) { o = { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(), hora: d.getUTCHours(), min: d.getUTCMinutes() }; }
    return o;
  }
  function z2(n){ return (n < 10 ? '0' : '') + n; }
  function agoraDoServidor(){ return D && D.agora ? new Date(new Date(D.agora).getTime() + (Date.now() - D.lidoEm)) : new Date(); }
  function diaNum(p){ return Math.round(Date.UTC(p.ano, p.mes - 1, p.dia) / 86400000); }
  var SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function rotuloDoDia(d){
    var p = partes(d), h = partes(agoraDoServidor()), dif = diaNum(p) - diaNum(h), hh = z2(p.hora) + ':' + z2(p.min);
    var dm = z2(p.dia) + '/' + z2(p.mes);
    if (dif === 0) return 'hoje ' + hh;
    if (dif === 1) return 'amanhã ' + hh;
    if (dif === -1) return 'ontem ' + hh;
    var sem = SEMANA[new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay()];
    return (dif > 1 && dif < 7 ? sem + ' ' : '') + dm + ' ' + hh;
  }
  // «2026-11-18T14:30» no relógio da unidade, a partir de agora + ms (para os atalhos)
  function localEm(ms){ var p = partes(new Date(agoraDoServidor().getTime() + ms)); return p.ano + '-' + z2(p.mes) + '-' + z2(p.dia) + 'T' + z2(p.hora) + ':' + z2(p.min); }
  function localDoDia(diasAFrente, hora){ var p = partes(new Date(agoraDoServidor().getTime() + diasAFrente * 86400000)); return p.ano + '-' + z2(p.mes) + '-' + z2(p.dia) + 'T' + z2(hora) + ':00'; }
  function segundaQueVem(){
    var h = partes(agoraDoServidor()), dow = new Date(Date.UTC(h.ano, h.mes - 1, h.dia)).getUTCDay(), falta = ((8 - dow) % 7) || 7;
    return localDoDia(falta, 9);
  }
  function horaAgora(){ var p = partes(new Date()); return z2(p.hora) + ':' + z2(p.min); }

  // ── ícones (traço, no estilo do menu do CRM) ──
  var ICONES = {
    mensagem: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    ligacao: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z'],
    lembrete: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']
  };
  function icone(tipo){
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    (ICONES[tipo] || []).forEach(function(d){ var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  var NOME_TIPO = { mensagem: 'Mensagem', ligacao: 'Ligação', lembrete: 'Lembrete' };

  // ── faixas do topo ──
  function cabecalho(){
    var m = $('modo'); m.hidden = false;
    m.className = 'pill est ' + (D.modo === 'ligado' ? 'vivo' : D.modo === 'seco' ? 'seco' : 'off');
    m.textContent = D.modo === 'ligado' ? 'Robô ligado' : D.modo === 'seco' ? 'Modo seco' : 'Robô desligado';
  }
  function faixaDoModo(){
    limpar($('faixaModo'));
    var modo = D.modo, j = D.janela;
    var cx = el('div', 'faixa ' + (modo === 'ligado' ? 'vivo' : modo === 'seco' ? 'seco' : ''));
    function mais(txt){ var dt = el('details', 'como'); dt.appendChild(el('summary', null, 'Como funciona')); dt.appendChild(el('p', 'dica', txt)); cx.appendChild(dt); }
    if (modo === 'seco') {
      cx.appendChild(el('b', null, 'Modo seco:'));
      cx.appendChild(el('span', null, 'o robô ainda não manda nada. As tarefas ficam aqui e você marca como feita à mão.'));
      mais('Você já pode criar, editar e cancelar. Quando a Doutor Digital ligar o robô, a mensagem agendada sai sozinha na hora, e as ligações avisam você aqui no CRM e no seu WhatsApp. Em modo seco o sistema só anota o que faria.');
    } else if (modo === 'desligado') {
      cx.appendChild(el('b', null, 'Robô desligado:'));
      cx.appendChild(el('span', null, 'as tarefas ficam só na lista, sem aviso e sem envio.'));
    } else {
      cx.appendChild(el('b', null, 'Ligado:'));
      cx.appendChild(el('span', null, 'a mensagem agendada sai sozinha, entre ' + j.inicio + 'h e ' + j.fim + 'h. As ligações avisam você no CRM e no WhatsApp.'));
      mais('Se o paciente escreveu há menos de 24 h, sai o texto que você escreveu. Se a janela do WhatsApp já fechou, sai o modelo aprovado que você escolheu. Mensagem atrasada em mais de ' + Math.round(D.atrasoMaxMin / 60 * 10) / 10 + ' h espera a sua confirmação.');
    }
    $('faixaModo').appendChild(cx);
  }
  function faixaDoZap(){
    var f = limpar($('faixaZap')), eu = null;
    D.atendentes.forEach(function(a){ if (a.id === D.eu.id) eu = a; });
    if (eu && !eu.temZap) {
      var cx = el('div', 'faixa seco'); cx.appendChild(el('b', null, 'Falta o seu WhatsApp:')); cx.appendChild(el('span', null, 'o lembrete chega só aqui no CRM (no sininho). Peça à Doutor Digital para cadastrar o seu número.')); f.appendChild(cx);
    }
  }
  // a lista tem limite: o que não coube é dito, para ninguém recriar uma tarefa que só está fora da tela
  function faixaDoLimite(){
    var f = limpar($('faixaLimite')), e = D.escondidas || { atrasadas: 0, proximas: 0 };
    if (!e.atrasadas && !e.proximas) return;
    var cx = el('div', 'faixa seco'); cx.appendChild(el('b', null, 'Nem tudo cabe na lista:'));
    var partes2 = [];
    if (e.atrasadas) partes2.push(e.atrasadas + ' atrasada(s) mais antiga(s)');
    if (e.proximas) partes2.push(e.proximas + ' tarefa(s) mais para frente');
    cx.appendChild(el('span', null, 'faltam ' + partes2.join(' e ') + '. Antes de criar uma tarefa de novo, confira com a Doutor Digital se ela já existe.'));
    f.appendChild(cx);
  }
  function faixaDaConversa(){
    var f = limpar($('faixaConversa'));
    if (!CONV) return;
    var cx = el('div', 'faixa conv'); cx.appendChild(el('b', null, CONV.nome ? CONV.nome : 'Conversa aberta'));
    cx.appendChild(el('span', null, SO_CONV ? 'Tarefas desta conversa.' : 'Mostrando as tarefas de todas as conversas.'));
    var b = el('button', 'bt sec peq', SO_CONV ? 'Ver todas da unidade' : 'Só desta conversa'); b.type = 'button';
    b.addEventListener('click', function(){ SO_CONV = !SO_CONV; faixaDaConversa(); desenhar(); });
    cx.appendChild(b); f.appendChild(cx);
  }

  // ── abas, filtro e lista ──
  var ROTULO_ABA = { hoje: 'Hoje', atrasadas: 'Atrasadas', proximas: 'Próximas', feitas: 'Feitas' };
  function visiveis(){
    return D.tarefas.filter(function(t){
      // dentro da conversa: todas as tarefas dela, de quem for
      if (CONV && SO_CONV) return t.conversaId === CONV.conversaId;
      if (QUEM === 'minhas') return t.responsavel.id === D.eu.id;
      if (QUEM !== 'todas') return String(t.responsavel.id) === QUEM;
      return true;
    });
  }
  function desenharFiltro(){
    var s = limpar($('quemSel'));
    function op(v, txt){ var o = el('option', null, txt); o.value = v; s.appendChild(o); }
    op('minhas', 'Minhas tarefas'); op('todas', 'Todas'); D.atendentes.forEach(function(a){ if (a.id !== D.eu.id) op(String(a.id), a.nome); });
    s.value = QUEM; if (s.value !== QUEM) { QUEM = 'minhas'; s.value = 'minhas'; }
  }
  function desenharAbas(){
    var a = limpar($('abas')), v = visiveis();
    ['hoje', 'atrasadas', 'proximas', 'feitas'].forEach(function(g){
      var n = v.filter(function(t){ return t.grupo === g; }).length;
      var b = el('button', 'aba'); b.type = 'button'; b.setAttribute('aria-pressed', ABA === g ? 'true' : 'false');
      b.appendChild(document.createTextNode(ROTULO_ABA[g]));
      if (g !== 'feitas') b.appendChild(el('span', 'n' + (g === 'atrasadas' && n ? ' alerta' : ''), String(n)));
      b.addEventListener('click', function(){ ABA = g; PAINEL = null; desenhar(); });
      a.appendChild(b);
    });
  }
  // «sai no próximo minuto» só vale dentro do horário de falar com o paciente; D.modo diz se o robô está ligado
  function avisoDoConfirmar(){
    var h = partes(agoraDoServidor()).hora, dentro = h >= D.janela.inicio && h < D.janela.fim;
    if (D.modo !== 'ligado') return 'Confirmado. O robô não está ligado: a mensagem só sai quando ele for ligado.';
    return dentro ? 'Confirmado: a mensagem sai no próximo minuto.' : 'Confirmado: a mensagem sai quando o horário de falar com o paciente abrir (' + D.janela.inicio + 'h).';
  }
  var ESTADO_ROTULO = { pendente: 'Marcada', enviando: 'Enviando…', aguardando: 'Confirme', feita: 'Feita', falhou: 'Falhou', barrada: 'Não saiu', cancelada: 'Cancelada' };
  var ESTADO_CLASSE = { pendente: 'mudo', enviando: 'mudo', aguardando: 'seco', feita: 'vivo', falhou: 'ruim', barrada: 'ruim', cancelada: 'off' };
  var RESULTADO_ROTULO = { atendeu: 'Atendeu', nao_atendeu: 'Não atendeu', remarcar: 'Remarcar' };
  function rotuloDoEstado(t){
    if (t.estado === 'feita') {
      if (t.tipo === 'ligacao' && t.resultado) return RESULTADO_ROTULO[t.resultado] || 'Feita';
      return t.tipo === 'mensagem' && t.enviadaEm ? 'Enviada' : 'Feita';
    }
    return ESTADO_ROTULO[t.estado] || t.estado;
  }
  function cartaoDaTarefa(t){
    var aberto = t.estado === 'pendente' || t.estado === 'aguardando';
    var c = el('div', 'tar' + (t.grupo === 'atrasadas' && aberto ? (t.estado === 'aguardando' ? ' confirme' : ' atrasada') : ''));
    var topo = el('div', 'tar-topo');
    var ic = el('div', 'tar-ico' + (t.tipo === 'ligacao' ? ' lig' : t.tipo === 'lembrete' ? ' lem' : '')); ic.appendChild(icone(t.tipo)); topo.appendChild(ic);
    var q = el('div', 'tar-quem'); q.appendChild(el('b', null, t.contato));
    var quando = rotuloDoDia(new Date(t.quando));
    q.appendChild(el('span', null, NOME_TIPO[t.tipo] + ' · ' + quando + ' · ' + t.responsavel.nome));
    topo.appendChild(q);
    var semSucesso = t.estado === 'feita' && (t.resultado === 'nao_atendeu' || t.resultado === 'remarcar');
    topo.appendChild(el('span', 'pill est ' + (semSucesso ? 'seco' : (ESTADO_CLASSE[t.estado] || 'mudo')), rotuloDoEstado(t)));
    c.appendChild(topo);
    if (t.tipo === 'mensagem' && aberto && t.saiEm) c.appendChild(el('p', 'tar-nota', 'Fora do horário: sai ' + rotuloDoDia(new Date(t.saiEm)) + '.'));
    if (t.texto) c.appendChild(el('p', 'tar-texto', t.texto));
    if (t.modelo) c.appendChild(el('p', 'tar-nota', 'Modelo se a janela de 24 h fechar: ' + t.modelo.nome));
    if (t.motivo && (t.estado === 'falhou' || t.estado === 'barrada' || t.estado === 'aguardando')) c.appendChild(el('p', 'tar-nota ' + (t.estado === 'aguardando' ? 'seco' : 'ruim'), t.motivo));
    else if (t.motivo && t.estado === 'feita' && t.tipo === 'mensagem') c.appendChild(el('p', 'tar-nota', t.motivo));
    if (t.simulado && aberto) c.appendChild(el('p', 'tar-nota seco', 'Modo seco: ' + t.simulado + '. Nada foi enviado.'));
    if (t.lembreteResumo && aberto) c.appendChild(el('p', 'tar-nota', 'Lembrete: ' + t.lembreteResumo));
    if (!t.responsavel.temZap && aberto && t.tipo !== 'mensagem') c.appendChild(el('p', 'tar-nota', t.responsavel.nome + ' ainda não tem WhatsApp cadastrado: o lembrete vai só para o CRM.'));
    var ac = el('div', 'tar-acoes');
    function botao(txt, cls, fn){ var b = el('button', 'bt peq ' + cls, txt); b.type = 'button'; b.addEventListener('click', function(){ fn(b); }); ac.appendChild(b); return b; }
    if (t.tipo === 'ligacao' && aberto) botao('Registrar resultado', 'pri', function(){ PAINEL = PAINEL === t.id ? null : t.id; desenhar(); });
    if (t.estado === 'aguardando') botao('Enviar mesmo assim', 'pri', function(b){ acao(b, '/api/public/tarefas/' + enc(t.id) + '/confirmar', {}, avisoDoConfirmar()); });
    if (aberto && t.tipo !== 'ligacao') botao(t.tipo === 'mensagem' ? 'Já mandei' : 'Feito', 'sec', function(b){ acao(b, '/api/public/tarefas/' + enc(t.id) + '/feita', {}, 'Marcada como feita.'); });
    if (aberto) botao('Editar', 'sec', function(){ abrirForm('editar', t); });
    if (aberto) botao('Cancelar', 'perigo', function(b){ if (window.confirm('Cancelar esta tarefa?')) acao(b, '/api/public/tarefas/' + enc(t.id) + '/cancelar', {}, 'Tarefa cancelada.'); });
    if (!aberto) botao('Criar de novo', 'sec', function(){ abrirForm('copia', t); });
    if (!CONV || CONV.conversaId !== t.conversaId) botao('Abrir conversa', 'sec', function(){ try { window.parent.postMessage({ event: 'funil:abrir-conversa', id: t.conversaId }, CW); } catch (e) {} });
    if (ac.firstChild) c.appendChild(ac);
    if (PAINEL === t.id && t.tipo === 'ligacao' && aberto) c.appendChild(painelDoResultado(t));
    return c;
  }
  async function acao(bt, caminho, corpo, ok){
    bt.disabled = true;
    try { var c = corpo; c.slug = U.slug; await api('POST', caminho, c); toast(ok); PAINEL = null; await carregar(); }
    catch (e) { toast(e.message, true); bt.disabled = false; }
  }
  function painelDoResultado(t){
    var p = el('div', 'painel'); p.appendChild(el('h3', null, 'Como foi a ligação?'));
    var l = el('div', 'linha');
    function enviar(resultado, proxima, bt){
      bt.disabled = true;
      api('POST', '/api/public/tarefas/' + enc(t.id) + '/resultado', { slug: U.slug, resultado: resultado, proximaLocal: proxima || null })
        .then(function(){ toast(proxima ? 'Resultado registrado e a próxima ligação marcada.' : 'Resultado registrado.'); PAINEL = null; return carregar(); })
        .catch(function(e){ toast(e.message, true); bt.disabled = false; });
    }
    var b1 = el('button', 'bt sec peq', 'Atendeu'); b1.type = 'button'; b1.addEventListener('click', function(){ enviar('atendeu', null, b1); });
    var b2 = el('button', 'bt sec peq', 'Não atendeu'); b2.type = 'button';
    var b3 = el('button', 'bt sec peq', 'Remarcar'); b3.type = 'button';
    l.appendChild(b1); l.appendChild(b2); l.appendChild(b3); p.appendChild(l);
    var extra = el('div'); p.appendChild(extra);
    function proximaTentativa(){
      limpar(extra);
      extra.appendChild(el('p', 'dica', 'Quer marcar a próxima tentativa?'));
      var ch = el('div', 'chips');
      [['Daqui 1 hora', function(){ return localEm(3600000); }], ['Hoje à tarde (16h)', function(){ return localDoDia(0, 16); }], ['Amanhã 9h', function(){ return localDoDia(1, 9); }]].forEach(function(x){
        var c = el('button', 'chip', x[0]); c.type = 'button'; c.addEventListener('click', function(){ enviar('nao_atendeu', x[1](), c); }); ch.appendChild(c);
      });
      var nao = el('button', 'chip', 'Não, só registrar'); nao.type = 'button'; nao.addEventListener('click', function(){ enviar('nao_atendeu', null, nao); }); ch.appendChild(nao);
      extra.appendChild(ch);
    }
    function remarcar(){
      limpar(extra);
      extra.appendChild(el('p', 'dica', 'Para quando fica a nova ligação?'));
      var lin = el('div', 'linha'), dt = el('input'); dt.type = 'datetime-local'; dt.value = localDoDia(1, 9); dt.setAttribute('aria-label', 'Nova data e hora'); lin.appendChild(dt);
      var ok = el('button', 'bt pri peq', 'Remarcar'); ok.type = 'button'; ok.addEventListener('click', function(){ if (!dt.value) { toast('Escolha o dia e a hora.', true); return; } enviar('remarcar', dt.value, ok); });
      lin.appendChild(ok); extra.appendChild(lin);
    }
    b2.addEventListener('click', proximaTentativa); b3.addEventListener('click', remarcar);
    return p;
  }
  function desenharLista(){
    var l = limpar($('lista')), v = visiveis().filter(function(t){ return t.grupo === ABA; });
    if (ABA === 'feitas') v.reverse();
    if (!v.length) {
      var txt = { hoje: 'Nada para hoje. Toque em Nova tarefa para agendar uma mensagem, uma ligação ou um lembrete.', atrasadas: 'Nenhuma tarefa atrasada.', proximas: 'Nenhuma tarefa nos próximos dias.', feitas: 'Ainda não há tarefas feitas nos últimos 14 dias.' };
      l.appendChild(el('div', 'vazio', txt[ABA]));
      return;
    }
    v.forEach(function(t){ l.appendChild(cartaoDaTarefa(t)); });
  }
  function desenhar(){ desenharAbas(); desenharLista(); }

  // ── o celular: a mensagem como a pessoa recebe ──
  function celular(nome){
    var raiz = el('div', 'cel'), tela = el('div', 'cel-tela'); raiz.appendChild(tela);
    var st = el('div', 'cel-status'); st.appendChild(el('span', null, horaAgora())); st.appendChild(el('i')); tela.appendChild(st);
    var top = el('div', 'cel-topo'); top.appendChild(el('span', 'volta', '‹'));
    var n = nome || 'Clínica';
    top.appendChild(el('span', 'foto', n.trim().charAt(0).toUpperCase()));
    var q = el('div', 'quem'); q.appendChild(el('b', null, n)); q.appendChild(el('span', null, 'Conta comercial')); top.appendChild(q); tela.appendChild(top);
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
  function mensagemNoCelular(conversa, m, vazio){
    limpar(conversa); conversa.appendChild(el('div', 'cel-dia', 'Hoje'));
    if (!m) { conversa.appendChild(el('div', 'cel-vazio', vazio || 'Escreva a mensagem para ver como ela chega.')); return; }
    var wrap = el('div', 'cel-msg'), bal = el('div', 'bal');
    if (m.cabecalho) bal.appendChild(el('span', 'cab', m.cabecalho));
    var corpo = el('span'); formatar(corpo, m.texto); bal.appendChild(corpo);
    if (m.rodape) bal.appendChild(el('span', 'rod', m.rodape));
    bal.appendChild(el('span', 'hora', horaAgora()));
    wrap.appendChild(bal);
    (m.botoes || []).forEach(function(b){ wrap.appendChild(el('div', 'cel-bt', '↩ ' + b)); });
    conversa.appendChild(wrap);
  }

  // ── NOVA TAREFA / EDITAR ──
  function fecharForm(){ FORM = null; limpar($('formArea')); }
  function primeiroNome(n){ return String(n || '').trim().split(/\s+/)[0] || ''; }
  async function abrirForm(modo, base){
    PAINEL = null;
    FORM = { modo: modo, id: modo === 'editar' && base ? base.id : null, tipo: base ? base.tipo : 'mensagem', alvo: null, quandoLocal: base && modo === 'editar' ? base.quandoLocal : localDoDia(1, 9), resp: base ? base.responsavel.id : D.eu.id, texto: base ? base.texto : '', modeloSel: null, fontes: [], fixo: [], ctxAlvo: null, modelos: null, via: 'texto' };
    if (base) FORM.alvo = { conversaId: base.conversaId, nome: base.contato };
    else if (CONV) FORM.alvo = { conversaId: CONV.conversaId, nome: CONV.nome };
    if (modo !== 'novo' && base && base.modelo) FORM.modeloGuardado = base.modelo;
    desenharForm();
    if (FORM.alvo) await carregarAlvo();
    if ($('formArea').scrollIntoView) $('formArea').scrollIntoView({ block: 'nearest' });
  }
  // a conversa escolhida: caixa, janela de 24 h e os modelos aprovados
  async function carregarAlvo(){
    var F = FORM;
    try {
      var q = F.alvo.conversaId ? 'conversa=' + F.alvo.conversaId : 'contato=' + F.alvo.contatoId;
      F.ctxAlvo = await api('GET', '/api/public/tarefas/contexto?slug=' + enc(U.slug) + '&' + q);
      if (FORM !== F) return;
      F.alvo.conversaId = F.ctxAlvo.conversaId; F.alvo.nome = F.ctxAlvo.nome;
      if (F.ctxAlvo.oficial) {
        var m = await api('GET', '/api/public/tarefas/modelos?slug=' + enc(U.slug) + '&caixa=' + F.ctxAlvo.caixa);
        if (FORM !== F) return;
        F.modelos = m.modelos || [];
        if (F.modeloGuardado) F.modelos.forEach(function(x, i){
          if (x.nome !== F.modeloGuardado.nome || x.idioma !== F.modeloGuardado.idioma) return;
          F.modeloSel = i; F.fontes = []; F.fixo = [];
          F.modeloGuardado.variaveis.forEach(function(v){ var fixo = v.indexOf('texto:') === 0; F.fontes.push(fixo ? 'texto' : v); F.fixo.push(fixo ? v.slice(6) : ''); });
        });
      } else F.modelos = [];
      F.modeloGuardado = null;
    } catch (e) { if (FORM === F) { F.erroAlvo = e.message; } }
    if (FORM === F) desenharForm();
  }
  // a janela de 24 h está garantida no horário escolhido? (mesma conta do servidor)
  function exigeModelo(F){
    if (F.tipo !== 'mensagem' || !F.ctxAlvo || !F.ctxAlvo.oficial) return false;
    if (!F.ctxAlvo.modeloAPartirDe) return true;
    var q = F.quandoLocal ? paraUtcAprox(F.quandoLocal) : null;
    return !q || q.getTime() >= new Date(F.ctxAlvo.modeloAPartirDe).getTime();
  }
  // «2026-11-18T14:30» do relógio da unidade → instante (só para decidir se exige modelo; o servidor refaz a conta)
  function paraUtcAprox(local){
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local); if (!m) return null;
    var chute = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]), p = partes(new Date(chute));
    var visto = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.min), off = visto - chute;
    return new Date(chute - off);
  }
  function desenharForm(){
    var F = FORM, area = limpar($('formArea'));
    if (!F) return;
    var card = el('div', 'card'); card.appendChild(el('h2', null, F.modo === 'editar' ? 'Editar tarefa' : 'Nova tarefa'));

    // tipo
    var campoTipo = el('div', 'campo'); campoTipo.appendChild(el('div', 'rot', 'O que agendar'));
    var seg = el('div', 'seg');
    ['mensagem', 'ligacao', 'lembrete'].forEach(function(t){
      var b = el('button', null, NOME_TIPO[t]); b.type = 'button'; b.setAttribute('aria-pressed', F.tipo === t ? 'true' : 'false');
      if (F.modo === 'editar' && F.tipo !== t) b.disabled = true;
      b.addEventListener('click', function(){ F.tipo = t; desenharForm(); });
      seg.appendChild(b);
    });
    campoTipo.appendChild(seg); card.appendChild(campoTipo);

    // para quem
    var campoQuem = el('div', 'campo'); campoQuem.appendChild(el('label', null, 'Para quem'));
    if (F.alvo) {
      var al = el('div', 'alvo'); al.appendChild(el('b', null, F.alvo.nome));
      if (F.modo === 'novo' && !(CONV && CONV.conversaId === F.alvo.conversaId)) { var tr = el('button', 'bt sec peq', 'Trocar'); tr.type = 'button'; tr.addEventListener('click', function(){ F.alvo = null; F.ctxAlvo = null; F.modelos = null; F.modeloSel = null; desenharForm(); }); al.appendChild(tr); }
      campoQuem.appendChild(al);
      if (F.erroAlvo) campoQuem.appendChild(el('p', 'ruim', F.erroAlvo));
    } else {
      var busca = el('input'); busca.type = 'search'; busca.placeholder = 'Nome ou telefone do contato'; busca.setAttribute('aria-label', 'Procurar contato'); campoQuem.appendChild(busca);
      var achados = el('div', 'achados'); campoQuem.appendChild(achados);
      var tBusca = null;
      busca.addEventListener('input', function(){
        clearTimeout(tBusca);
        tBusca = setTimeout(async function(){
          limpar(achados); var q = busca.value.trim(); if (q.length < 2) return;
          try {
            var r = await api('GET', '/api/public/tarefas/buscar?slug=' + enc(U.slug) + '&q=' + enc(q));
            limpar(achados);
            if (!r.contatos.length) achados.appendChild(el('p', 'dica', 'Ninguém com esse nome ou telefone.'));
            r.contatos.forEach(function(c){
              var b = el('button', 'achado'); b.type = 'button'; b.appendChild(el('b', null, c.nome)); b.appendChild(el('span', null, c.telefone));
              b.addEventListener('click', function(){ F.alvo = { contatoId: c.id, nome: c.nome }; F.erroAlvo = null; desenharForm(); carregarAlvo(); });
              achados.appendChild(b);
            });
          } catch (e) { limpar(achados); achados.appendChild(el('p', 'ruim', e.message)); }
        }, 350);
      });
    }
    card.appendChild(campoQuem);

    // quando e quem cuida
    var par = el('div', 'par');
    var cq = el('div', 'campo'); cq.appendChild(el('label', null, F.tipo === 'mensagem' ? 'Quando a mensagem sai' : F.tipo === 'ligacao' ? 'Quando ligar' : 'Quando lembrar'));
    var dt = el('input'); dt.type = 'datetime-local'; dt.value = F.quandoLocal; dt.id = 'fQuando'; cq.appendChild(dt);
    dt.addEventListener('change', function(){ F.quandoLocal = dt.value; if (F.tipo === 'mensagem') desenharForm(); });
    var chs = el('div', 'chips');
    [['Daqui 1 hora', function(){ return localEm(3600000); }], ['Amanhã 9h', function(){ return localDoDia(1, 9); }], ['Segunda 9h', segundaQueVem]].forEach(function(x){
      var c = el('button', 'chip', x[0]); c.type = 'button'; c.addEventListener('click', function(){ F.quandoLocal = x[1](); desenharForm(); }); chs.appendChild(c);
    });
    cq.appendChild(chs);
    cq.appendChild(el('small', 'dica', 'Horário de ' + (D.unidade.nome) + '.'));
    par.appendChild(cq);
    var cr = el('div', 'campo'); cr.appendChild(el('label', null, F.tipo === 'mensagem' ? 'Quem cuida (recebe o aviso)' : 'Quem vai fazer'));
    var sr = el('select'); sr.id = 'fResp';
    D.atendentes.forEach(function(a){ var o = el('option', null, a.nome + (a.id === D.eu.id ? ' (você)' : '') + (a.temZap ? '' : ' — sem WhatsApp, só no CRM')); o.value = String(a.id); sr.appendChild(o); });
    sr.value = String(F.resp); sr.addEventListener('change', function(){ F.resp = Number(sr.value); });
    cr.appendChild(sr); par.appendChild(cr);
    card.appendChild(par);

    if (F.tipo === 'mensagem') card.appendChild(blocoDaMensagem(F));
    else {
      var ct = el('div', 'campo'); ct.appendChild(el('label', null, F.tipo === 'ligacao' ? 'Anotação (o que falar)' : 'Anotação (o que lembrar)'));
      var ta = el('textarea'); ta.maxLength = 1000; ta.value = F.texto; ta.id = 'fTexto'; ta.placeholder = F.tipo === 'ligacao' ? 'Ex.: confirmar a consulta de quinta e perguntar do exame' : 'Ex.: ver se mandou os documentos';
      ta.addEventListener('input', function(){ F.texto = ta.value; }); ct.appendChild(ta); card.appendChild(ct);
    }

    var ln = el('div', 'linha');
    var salvar = el('button', 'bt pri', F.modo === 'editar' ? 'Salvar' : 'Agendar'); salvar.type = 'button'; salvar.id = 'fSalvar';
    var cancelar = el('button', 'bt sec', 'Fechar'); cancelar.type = 'button'; cancelar.addEventListener('click', fecharForm);
    salvar.addEventListener('click', function(){ salvarForm(salvar); });
    ln.appendChild(salvar); ln.appendChild(cancelar); card.appendChild(ln);
    area.appendChild(card);
  }
  function blocoDaMensagem(F){
    var grade = el('div', 'msg-grid'), form = el('div', 'msg-form'), lado = el('div', 'msg-fone');
    grade.appendChild(form); grade.appendChild(lado);
    var ct = el('div', 'campo'); ct.appendChild(el('label', null, 'Mensagem'));
    var ta = el('textarea'); ta.maxLength = 1000; ta.value = F.texto; ta.id = 'fTexto'; ta.placeholder = 'Ex.: Oi, tudo bem? Passando para lembrar da sua avaliação.';
    ct.appendChild(ta); ct.appendChild(el('small', 'dica', 'Sai assim, como texto, se o paciente tiver escrito para a clínica nas últimas 24 horas.')); form.appendChild(ct);

    var fone = celular(D.unidade.nome); fone.conversa.id = 'zapPrevia'; lado.appendChild(fone.raiz);
    var troca = el('div', 'chips'); lado.appendChild(troca);

    var precisa = exigeModelo(F);
    if (F.ctxAlvo && !F.ctxAlvo.oficial) form.appendChild(el('p', 'dica', 'Esta caixa não é o WhatsApp oficial: só vai texto, e não há janela de 24 h.'));
    else if (F.ctxAlvo && F.ctxAlvo.oficial) {
      var cm = el('div', 'campo'); cm.appendChild(el('label', null, precisa ? 'Modelo aprovado (obrigatório neste horário)' : 'Modelo aprovado (reserva, se a janela fechar)'));
      var s = el('select'); s.id = 'fModelo'; var o0 = el('option', null, precisa ? 'Escolha um modelo…' : 'Sem modelo'); o0.value = ''; s.appendChild(o0);
      (F.modelos || []).forEach(function(m, i){ var o = el('option', null, m.nome); o.value = String(i); s.appendChild(o); });
      s.value = F.modeloSel == null ? '' : String(F.modeloSel);
      cm.appendChild(s);
      if (precisa) cm.appendChild(el('small', 'dica ruim', F.ctxAlvo.ultimaDoPaciente ? 'A janela de 24 h do WhatsApp pode estar fechada nesse horário. Sem modelo, o texto livre pode não chegar.' : 'Este contato não tem mensagem recente: o WhatsApp só deixa começar por um modelo aprovado.'));
      else cm.appendChild(el('small', 'dica', 'O modelo só sai se o paciente não tiver escrito nas últimas 24 horas na hora de mandar.'));
      form.appendChild(cm);
      var det = el('div', 'campo'); det.id = 'fVars'; form.appendChild(det);
      s.addEventListener('change', function(){ F.modeloSel = s.value === '' ? null : Number(s.value); F.fontes = []; F.fixo = []; desenharVariaveis(F, det); atualizarPrevia(F, ta); });
      desenharVariaveis(F, det);
    } else if (!F.alvo) form.appendChild(el('p', 'dica', 'Escolha para quem é a mensagem para ver os modelos.'));
    ta.addEventListener('input', function(){ F.texto = ta.value; atualizarPrevia(F, ta); });
    F.trocaPrevia = troca; atualizarPrevia(F, ta);
    return grade;
  }
  function desenharVariaveis(F, det){
    limpar(det);
    if (F.modeloSel == null || !F.modelos) return;
    var m = F.modelos[F.modeloSel];
    if (!m.variaveis) return;
    if (!F.fontes.length) for (var i = 0; i < m.variaveis; i++) { F.fontes.push(i === 0 ? 'primeiroNome' : 'unidade'); F.fixo.push(''); }
    det.appendChild(el('div', 'rot', 'O que entra em cada variável'));
    for (var k = 0; k < m.variaveis; k++) (function(k){
      var l = el('div', 'linha'); l.appendChild(el('span', 'pill', '{{' + (k + 1) + '}}'));
      var sel = el('select'); [['primeiroNome', 'Primeiro nome do contato'], ['unidade', 'Nome da unidade'], ['texto', 'Texto fixo']].forEach(function(x){ var o = el('option', null, x[1]); o.value = x[0]; sel.appendChild(o); });
      sel.value = F.fontes[k]; sel.setAttribute('aria-label', 'Variável ' + (k + 1));
      var tx = el('input'); tx.type = 'text'; tx.maxLength = 120; tx.placeholder = 'Digite o texto'; tx.setAttribute('aria-label', 'Texto fixo da variável ' + (k + 1)); tx.value = F.fixo[k]; tx.hidden = sel.value !== 'texto';
      sel.addEventListener('change', function(){ F.fontes[k] = sel.value; tx.hidden = sel.value !== 'texto'; atualizarPrevia(F); });
      tx.addEventListener('input', function(){ F.fixo[k] = tx.value; atualizarPrevia(F); });
      l.appendChild(sel); l.appendChild(tx); det.appendChild(l);
    })(k);
  }
  function fontesParaOServidor(F){ return F.fontes.map(function(f, i){ return f === 'texto' ? 'texto:' + (F.fixo[i] || '').trim() : f; }); }
  // a prévia no celular: o texto livre e, se houver, o modelo (um botão troca)
  function atualizarPrevia(F, ta){
    var z = $('zapPrevia'); if (!z) return;
    var texto = (ta ? ta.value : F.texto) || '', temModelo = F.modeloSel != null && F.modelos && F.modelos[F.modeloSel];
    if (!F.via || (F.via === 'modelo' && !temModelo)) F.via = 'texto';
    if (!texto.trim() && temModelo) F.via = 'modelo';
    var troca = limpar(F.trocaPrevia || el('div'));
    if (temModelo && texto.trim()) {
      [['texto', 'Texto livre'], ['modelo', 'Modelo']].forEach(function(x){ var b = el('button', 'chip', x[1]); b.type = 'button'; b.setAttribute('aria-pressed', F.via === x[0] ? 'true' : 'false'); b.addEventListener('click', function(){ F.via = x[0]; atualizarPrevia(F, ta); }); troca.appendChild(b); });
    }
    if (F.via === 'modelo' && temModelo) {
      var m = F.modelos[F.modeloSel], nome = primeiroNome(F.alvo ? F.alvo.nome : '') || 'Maria';
      var t = m.texto.replace(/\{\{\s*(\d+)\s*\}\}/g, function(_x, n){
        var f = F.fontes[Number(n) - 1]; if (!f) return '{{' + n + '}}';
        return f === 'primeiroNome' ? nome : f === 'unidade' ? D.unidade.nome : (F.fixo[Number(n) - 1] || '…');
      });
      mensagemNoCelular(z, { cabecalho: m.cabecalho || null, texto: t, rodape: m.rodape || null, botoes: m.botoes || [] });
    } else if (texto.trim()) mensagemNoCelular(z, { texto: texto });
    else mensagemNoCelular(z, null);
  }
  async function salvarForm(bt){
    var F = FORM;
    if (!F.alvo) { toast('Escolha para quem é a tarefa.', true); return; }
    if (!F.quandoLocal) { toast('Escolha o dia e a hora.', true); return; }
    var corpo = { slug: U.slug, tipo: F.tipo, quandoLocal: F.quandoLocal, responsavelId: F.resp, texto: ($('fTexto') ? $('fTexto').value : '').trim(), modelo: null };
    if (F.tipo === 'mensagem') {
      var ok = F.modeloSel != null && F.modelos && F.modelos[F.modeloSel];
      if (exigeModelo(F) && !ok) { toast('Neste horário a janela de 24 h pode estar fechada: escolha um modelo aprovado.', true); return; }
      if (!corpo.texto && !ok) { toast('Escreva a mensagem ou escolha um modelo.', true); return; }
      if (ok) {
        var fontes = fontesParaOServidor(F);
        for (var i = 0; i < fontes.length; i++) if (fontes[i] === 'texto:') { toast('Preencha o texto fixo da variável {{' + (i + 1) + '}}.', true); return; }
        corpo.modelo = { nome: ok.nome, idioma: ok.idioma, variaveis: fontes };
      }
    }
    if (F.modo === 'editar') corpo.id = F.id; else if (F.alvo.conversaId) corpo.conversaId = F.alvo.conversaId; else corpo.contatoId = F.alvo.contatoId;
    bt.disabled = true; var texto0 = bt.textContent; bt.textContent = 'Salvando…';
    var url = F.modo === 'editar' ? '/api/public/tarefas/' + enc(F.id) + '/editar' : '/api/public/tarefas';
    var pedido = { id: F.modo === 'editar' ? F.id : null, conversaId: corpo.conversaId || null, tipo: F.tipo, quandoLocal: F.quandoLocal, texto: corpo.texto, responsavelId: corpo.responsavelId || null };
    try {
      var res = await salvarTarefa({
        enviar: function(){ return api('POST', url, corpo); },
        listar: function(){ return api('GET', '/api/public/tarefas?slug=' + enc(U.slug)); },
        confere: function(d){ return tarefaPedida(d, pedido); },
        espera: function(ms){ return new Promise(function(ok){ setTimeout(ok, ms); }); },
        // só roda depois de a tarefa existir; se a lista não atualizar, isso NÃO é erro do agendamento
        atualizar: function(){
          var quando = paraUtcAprox(F.quandoLocal), hoje = agoraDoServidor();
          ABA = quando && diaNum(partes(quando)) === diaNum(partes(hoje)) ? 'hoje' : 'proximas';
          fecharForm();
          return carregar();
        }
      });
      var r = res.resposta || {};
      toast(res.conferida ? 'Tarefa agendada. A conexão oscilou, mas conferi na lista: está lá.' : r.repetida ? 'Esta tarefa já estava agendada.' : r.aviso ? 'Agendada. ' + r.aviso : (F.modo === 'editar' ? 'Tarefa atualizada.' : 'Tarefa agendada.'));
      if (!res.atualizou) { aviso('Tarefa salva. Não consegui atualizar a lista agora: ela aparece sozinha em instantes.', false); setTimeout(function(){ carregar().then(function(){ aviso(''); }).catch(function(){}); }, 4000); }
    } catch (e) {
      toast(e.message, true); bt.disabled = false; bt.textContent = texto0;
      if (e.corpo && e.corpo.exigeModelo) desenharForm();
      // sem resposta: pode ter gravado — mostra a lista para a atendente ver antes de tentar de novo
      if (e.incerto) carregar().catch(function(){});
    }
  }

  // ── WhatsApp das meninas (só a Doutor Digital) ──
  function desenharZap(){
    var a = limpar($('zapArea'));
    if (!D.podeCadastrarZap) return;
    var dt = el('details'); dt.appendChild(el('summary', null, 'WhatsApp das atendentes (só a Doutor Digital vê)'));
    var cx = el('div', 'zaps'); cx.appendChild(el('p', 'dica', 'É para este número que o robô manda o lembrete das ligações e o aviso da mensagem. Sem número, o lembrete vai só para o CRM.'));
    D.atendentes.forEach(function(p){
      var l = el('div', 'zap'); l.appendChild(el('b', null, p.nome + (p.zap ? '  (cadastrado ' + p.zap + ')' : '')));
      var inp = el('input'); inp.type = 'tel'; inp.placeholder = '94 99999-0000'; inp.setAttribute('aria-label', 'WhatsApp de ' + p.nome); l.appendChild(inp);
      var s = el('button', 'bt sec peq', 'Salvar'); s.type = 'button';
      s.addEventListener('click', function(){
        if (!inp.value.trim()) { toast('Digite o número com DDD.', true); return; }
        s.disabled = true;
        api('POST', '/api/public/tarefas/zap', { slug: U.slug, agenteId: p.id, telefone: inp.value.trim() }).then(function(){ toast('Número de ' + p.nome + ' salvo.'); return carregar(); }).catch(function(e){ toast(e.message, true); }).then(function(){ s.disabled = false; });
      });
      l.appendChild(s);
      var r = el('button', 'bt perigo peq', 'Remover'); r.type = 'button'; r.disabled = !p.temZap;
      r.addEventListener('click', function(){
        r.disabled = true;
        api('POST', '/api/public/tarefas/zap', { slug: U.slug, agenteId: p.id, telefone: null }).then(function(){ toast('Número removido.'); return carregar(); }).catch(function(e){ toast(e.message, true); r.disabled = false; });
      });
      l.appendChild(r); cx.appendChild(l);
    });
    dt.appendChild(cx); a.appendChild(dt);
  }

  // ── entrada: sessão do Chatwoot pelo menu, unidade pelas caixas da pessoa ──
  async function carregar(){
    if (CARREGANDO) return D;
    CARREGANDO = true;
    try {
      var d = await api('GET', '/api/public/tarefas?slug=' + enc(U.slug));
      d.lidoEm = Date.now(); D = d;
      cabecalho(); faixaDoModo(); faixaDoZap(); faixaDoLimite(); faixaDaConversa(); desenharFiltro(); desenhar(); desenharZap();
      return D;
    } finally { CARREGANDO = false; }
  }
  async function escolherUnidade(u){
    U = u; guardar('tarefas:unidade', u.slug); $('unidadeNome').textContent = u.nome;
    try { await carregar(); aviso(''); } catch (e) { aviso(e.message, true); }
    if (!tPoll) tPoll = setInterval(function(){ if (U && S && !document.hidden) carregar().catch(function(){}); }, 60000);
  }
  async function entrar(){
    try {
      var r = await api('GET', '/api/public/testar-ia/unidades');
      UNIDADES = r.unidades || [];
      if (!UNIDADES.length) { aviso('Você não atende nenhuma caixa desta unidade. Peça para a Suzanne liberar a sua caixa.', true); $('unidadeNome').textContent = 'Sem unidade'; return; }
      var guardada = lerGuardado('tarefas:unidade'), u = UNIDADES.filter(function(x){ return x.slug === guardada; })[0] || UNIDADES[0];
      if (UNIDADES.length > 1) {
        var s = $('unidadeSel'); s.hidden = false; limpar(s);
        UNIDADES.forEach(function(x){ var o = el('option', null, x.nome); o.value = x.slug; s.appendChild(o); });
        s.value = u.slug; s.onchange = function(){ var x = UNIDADES.filter(function(y){ return y.slug === s.value; })[0]; if (x) escolherUnidade(x); };
        $('unidadeNome').textContent = '';
      }
      $('corpo').hidden = false;
      await escolherUnidade(u);
      if (CONV) acharUnidadeDaConversa();
    } catch (e) { aviso(e.message, true); }
  }
  // dentro da conversa: a unidade certa é a da caixa dela (uma conta pode ter mais de uma unidade)
  async function acharUnidadeDaConversa(){
    if (!CONV) return;
    for (var i = 0; i < UNIDADES.length; i++) {
      try {
        var c = await api('GET', '/api/public/tarefas/contexto?slug=' + enc(UNIDADES[i].slug) + '&conversa=' + CONV.conversaId);
        CONV.nome = c.nome;
        if (!U || U.slug !== UNIDADES[i].slug) { if ($('unidadeSel')) $('unidadeSel').value = UNIDADES[i].slug; await escolherUnidade(UNIDADES[i]); }
        faixaDaConversa(); desenhar();
        return;
      } catch (e) { /* esta unidade não é a da conversa */ }
    }
  }
  $('btNova').addEventListener('click', function(){ if (U && D) abrirForm('novo', null); });
  $('quemSel').addEventListener('change', function(){ QUEM = $('quemSel').value; PAINEL = null; desenhar(); });
  function pedirContexto(){ try { window.parent.postMessage('chatwoot-dashboard-app:fetch-info', '*'); } catch (e) {} }
  window.addEventListener('message', function(ev){
    if (!origemDoCrm(ev.origin) || ev.source !== window.parent) return;
    var d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d) return;
    if (d.event === 'funil-sessao') {
      var novo = d.sessao && d.sessao.token ? d.sessao : null, primeira = !S && novo && !U; S = novo;
      if (primeira) entrar();
      return;
    }
    if (d.event === 'appContext' && !MENU) {
      var c = d.data && d.data.conversation, id = c && Number(c.id);
      if (id && (!CONV || CONV.conversaId !== id)) {
        var nome = c.meta && c.meta.sender && c.meta.sender.name ? String(c.meta.sender.name) : '';
        CONV = { conversaId: id, nome: nome }; SO_CONV = true; fecharForm();
        if (U && UNIDADES.length) acharUnidadeDaConversa(); else faixaDaConversa();
        if (D) { faixaDaConversa(); desenhar(); }
      }
    }
  });
  pedirSessao(); setTimeout(function(){ if (!S) pedirSessao(); }, 1500);
  if (!MENU) { pedirContexto(); setInterval(pedirContexto, 5000); }
  setTimeout(function(){ if (!S) aviso('Abra esta tela pelo menu do CRM (Tarefas), já logada.', true); }, 6000);
})();
</script></body></html>`;

/** A página. `origemChatwoot` = a origem do Chatwoot (só ela fala com a página por postMessage). */
export function paginaDasTarefas(origemChatwoot: string): string {
  return comSalvarNaPagina(comContaNaPagina(PAGINA.split('__ORIGEM_CW__').join(`origemDoPai(${JSON.stringify(origemChatwoot)})`).split('__LOGO_DD__').join(LOGO_DD_PNG)));
}
