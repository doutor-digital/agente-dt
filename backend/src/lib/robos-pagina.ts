/**
 * A tela «Robôs» do menu do Chatwoot (pedido do João, 14/11/2026: "eu quero ver isso no CRM! configurar tudo isso", "poder configurar sem
 * precisar do dev esses bots", "estilo n8n… top e bonito"). O molde é a prévia aprovada (robos-previa.html): lista de robôs à esquerda
 * (por funil, com busca e liga/desliga), prancheta pontilhada com o fluxo do robô — Gatilho → Esperar → Só se → Enviar WhatsApp / Não
 * envia —, painel do bloco ao clicar, aba «Execuções» e o post-it das proteções. Tema claro/escuro pelo navegador.
 *
 * FASE A (este PR): Gatilho e «Só se» são SOMENTE LEITURA (mostram a regra do código). Editáveis, e só para o administrador do Chatwoot: o
 * número/unidade do bloco Esperar (a direção antes/depois e a âncora são do robô e não trocam), o modelo do bloco Enviar (só os aprovados
 * na caixa, com as mesmas variáveis) e o liga/desliga. A atendente só vê. O «+ Novo» e os blocos editáveis de Gatilho/«Só se» são a Fase B.
 *
 * A sessão chega do menu do Chatwoot por postMessage (`funil:pede-sessao` → `funil-sessao`, com checagem de origem), como na tela Agente.
 * Todo texto que vem do servidor entra por textContent (nunca innerHTML). O JavaScript não usa crase nem `${`: a página é um String.raw e só
 * `__ORIGEM_CW__` é trocado.
 */

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Robôs</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
:root{--app:#f3f5fa;--side:#fff;--canvas:#eceff6;--dot:#c7cedd;--node:#fff;--ink:#131a2e;--ink-2:#4c5672;--line:#d9dfeb;--wire:#9aa5bd;--brand:#1f4fd1;--brand-soft:#e7edff;--trig:#e8590c;--wait:#c08400;--cond:#2f6fdd;--send:#128c4f;--stop:#8a93a8;--sticky:#fff3b0;--sticky-ink:#4a3d00;--bubble:#d9fdd3;--bubble-ink:#10261a;--chat:#efeae2;--shadow:0 1px 2px rgba(19,26,46,.08),0 10px 28px rgba(19,26,46,.10);--f-ui:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--f-head:"Space Grotesk","Inter",system-ui,sans-serif;--f-mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--app:#0e1322;--side:#141b2e;--canvas:#101728;--dot:#263150;--node:#1a2238;--ink:#e8ecf7;--ink-2:#a1abc6;--line:#2a3555;--wire:#56648a;--brand:#86a3ff;--brand-soft:#1d2a56;--trig:#ff8a4c;--wait:#ffc24d;--cond:#7fa8ff;--send:#4fd393;--stop:#6b7591;--sticky:#3d3714;--sticky-ink:#ffe98a;--bubble:#005c4b;--bubble-ink:#e9fff6;--chat:#0b141a;--shadow:0 1px 2px rgba(0,0,0,.4),0 12px 30px rgba(0,0,0,.4)}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--app);color:var(--ink);font:14px/1.45 var(--f-ui);display:grid;grid-template-rows:auto 1fr;min-height:100%;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
[hidden]{display:none!important}
.topo{display:flex;align-items:center;gap:10px;padding-block:12px;flex-wrap:wrap}
.logo{width:24px;height:24px;border-radius:7px;background:var(--brand);color:#fff;display:grid;place-items:center;font:700 12px var(--f-head)}
.topo .mig{color:var(--ink-2);font-size:13px}.topo b{font:600 15px var(--f-head)}
.topo .un{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--ink-2);font-size:13px}
.topo select{font:500 13px var(--f-ui);color:var(--ink);background:var(--node);border:1px solid var(--line);border-radius:8px;padding:5px 8px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font:600 12px var(--f-ui);background:var(--brand-soft);color:var(--brand)}
.pill.so-ver{background:var(--app);color:var(--ink-2);border:1px solid var(--line)}
.aviso{margin:0 0 12px;padding:10px 14px;border:1px solid #f0e2b6;border-radius:10px;background:#fffbeb;color:#6b4e00;font-size:13px}
.aviso.erro{border-color:#f4d0d8;background:#fff5f7;color:#8f1d3a}
.app{display:grid;grid-template-columns:290px minmax(0,1fr);border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--side);min-height:640px;margin-bottom:16px}
@media (max-width:860px){.app{grid-template-columns:1fr}.lado{max-height:320px;border-right:0!important;border-bottom:1px solid var(--line)}}
.lado{border-right:1px solid var(--line);display:grid;grid-template-rows:auto auto 1fr;min-height:0}
.lado-cab{display:flex;gap:8px;align-items:center;padding:14px 14px 10px}.lado-cab h1{margin:0;font:700 20px var(--f-head);flex:1}
.bt{appearance:none;border:0;border-radius:9px;padding:8px 12px;font:600 13px var(--f-ui);cursor:pointer;display:inline-flex;gap:6px;align-items:center;white-space:nowrap}
.bt.pri{background:var(--brand);color:#fff}.bt.sec{background:var(--node);color:var(--ink);border:1px solid var(--line)}.bt.link{background:transparent;color:var(--brand);padding:6px 4px}
.bt:disabled{opacity:.5;cursor:default}
.busca{margin:0 14px 10px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--app);color:var(--ink);font:13px var(--f-ui)}
.lista{overflow-y:auto;padding:0 8px 14px;min-height:0}
.grupo{margin:10px 6px 4px;font:600 11px var(--f-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);display:flex;justify-content:space-between}
.item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px;border-radius:9px;cursor:pointer}
.item:hover{background:var(--app)}.item[aria-current=true]{background:var(--brand-soft)}
.item .mini{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:#fff;background:var(--send)}.item .mini svg{width:14px;height:14px}
.item b{font:600 13px var(--f-ui);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item small{color:var(--ink-2);font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item.desl .mini{background:var(--stop)}.item.desl b,.item.desl small{opacity:.6}
.sw{appearance:none;width:34px;height:20px;border-radius:999px;border:0;background:var(--stop);position:relative;cursor:pointer;flex:none}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
.sw[aria-checked=true]{background:var(--send)}.sw[aria-checked=true]::after{transform:translateX(14px)}.sw:disabled{opacity:.55;cursor:not-allowed}
.bt:focus-visible,.item:focus-visible,.sw:focus-visible,.no:focus-visible,.aba:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.palco{display:grid;grid-template-rows:auto 1fr;min-width:0;min-height:0;background:var(--canvas)}
.palco-cab{display:flex;gap:12px;align-items:center;padding:10px 14px;background:var(--side);border-bottom:1px solid var(--line);flex-wrap:wrap}
.palco-cab .nome{font:600 16px var(--f-head);flex:1 1 200px;min-width:0}
.abas{display:inline-flex;background:var(--app);border-radius:9px;padding:3px;gap:2px}
.aba{appearance:none;border:0;background:transparent;color:var(--ink-2);font:600 13px var(--f-ui);padding:6px 12px;border-radius:7px;cursor:pointer}
.aba[aria-selected=true]{background:var(--node);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.ativo{display:inline-flex;gap:8px;align-items:center;font:600 13px var(--f-ui);color:var(--ink-2)}
.tela{position:relative;min-height:0;overflow:auto;background-color:var(--canvas);background-image:radial-gradient(var(--dot) 1.3px,transparent 1.3px);background-size:20px 20px}
.mundo{position:relative;width:1180px;height:520px}
svg.fios{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
svg.fios path{fill:none;stroke:var(--wire);stroke-width:2}svg.fios path.nao{stroke-dasharray:6 6}
svg.fios text{font:600 11px var(--f-ui);fill:var(--ink-2)}
.no{position:absolute;width:112px;display:grid;justify-items:center;gap:8px;cursor:pointer;background:none;border:0;padding:0;color:var(--ink);font:inherit}
.no .caixa{width:92px;height:92px;background:var(--node);border:2px solid var(--line);border-radius:14px;display:grid;place-items:center;box-shadow:var(--shadow);position:relative;transition:border-color .15s,transform .15s}
.no.trig .caixa{border-radius:46px 14px 14px 46px}.no:hover .caixa{border-color:var(--cor);transform:translateY(-2px)}
.no .caixa svg{width:40px;height:40px;color:var(--cor)}
.no .caixa::after,.no .caixa::before{content:"";position:absolute;top:50%;width:10px;height:10px;border-radius:50%;background:var(--node);border:2px solid var(--wire);transform:translateY(-50%)}
.no .caixa::after{right:-7px}.no .caixa::before{left:-7px}.no.trig .caixa::before{display:none}.no.fim .caixa::after{display:none}
.no .rot{font:600 12.5px var(--f-ui);text-align:center;line-height:1.25}
.no .det{font:500 11.5px var(--f-ui);color:var(--ink-2);text-align:center;line-height:1.3;max-width:150px}
.no.trig{--cor:var(--trig)}.no.wait{--cor:var(--wait)}.no.cond{--cor:var(--cond)}.no.send{--cor:var(--send)}.no.stop{--cor:var(--stop)}
.no.desl .caixa{opacity:.5}
.selo{position:absolute;top:-8px;right:-8px;background:var(--send);color:#fff;border-radius:999px;font:700 10.5px var(--f-mono);padding:1px 6px}
.post{position:absolute;width:270px;background:var(--sticky);color:var(--sticky-ink);border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.45;box-shadow:var(--shadow)}
.post b{display:block;font:700 13px var(--f-head);margin-bottom:4px}
.alerta{position:absolute;left:24px;top:18px;max-width:520px;background:var(--node);border:1px solid var(--trig);color:var(--trig);border-radius:9px;padding:6px 10px;font:600 12.5px var(--f-ui);box-shadow:var(--shadow)}
.dica{position:absolute;left:24px;bottom:16px;color:var(--ink-2);font-size:12.5px}
.ndv-veu{position:fixed;inset:0;background:rgba(9,13,25,.45);z-index:40;display:grid;place-items:center;padding:16px}
.ndv{width:min(900px,100%);max-height:min(640px,100%);background:var(--side);border-radius:14px;box-shadow:var(--shadow);display:grid;grid-template-rows:auto 1fr auto;overflow:hidden}
.ndv-cab{display:flex;gap:10px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line)}
.ndv-cab .ic{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:#fff;background:var(--cor)}.ndv-cab .ic svg{width:18px;height:18px}
.ndv-cab h2{margin:0;font:600 16px var(--f-head);flex:1}
.ndv-corpo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);min-height:0;overflow:auto}
@media (max-width:720px){.ndv-corpo{grid-template-columns:1fr}}
.col{padding:16px;display:grid;gap:12px;align-content:start}.col+.col{border-left:1px solid var(--line);background:var(--app)}
.col h3{margin:0;font:600 11px var(--f-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)}
.col p{margin:0}
.campo{display:grid;gap:5px}.campo label{font:600 12.5px var(--f-ui)}
.campo select,.campo input{font:500 13px var(--f-ui);color:var(--ink);background:var(--node);border:1px solid var(--line);border-radius:8px;padding:7px 9px;width:100%}
.campo .junto{display:flex;gap:6px;align-items:center}.campo .junto input{width:90px;font-family:var(--f-mono)}.campo .junto select{width:auto}
.campo .junto .dir{font:600 13px var(--f-ui);white-space:nowrap}
.campo .ajuda{font-size:12px;color:var(--ink-2)}
.campo .so-leitura{padding:8px 10px;border:1px dashed var(--line);border-radius:8px;background:var(--app);font-size:13px}
.chat{background:var(--chat);border-radius:10px;padding:14px;display:flex;justify-content:flex-end}
.balao{background:var(--bubble);color:var(--bubble-ink);border-radius:10px 2px 10px 10px;padding:8px 10px 5px;max-width:40ch;white-space:pre-line;font-size:13.5px}
.balao .hora{display:block;text-align:right;font-size:11px;opacity:.65}
.ndv-pe{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--line)}
.ndv-pe .fim{display:flex;gap:8px}.ndv-pe small{color:var(--ink-2)}
.exec{padding:16px;display:grid;gap:10px;align-content:start}
.exec-l{display:grid;grid-template-columns:auto 128px minmax(0,1fr) minmax(0,1.2fr) auto;gap:12px;align-items:center;background:var(--node);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
@media (max-width:700px){.exec-l{grid-template-columns:auto minmax(0,1fr)}.exec-l .q,.exec-l .m,.exec-l .a{grid-column:2}}
.exec-l .st{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;color:#fff;font:700 12px var(--f-ui)}
.st.ok{background:var(--send)}.st.nota{background:var(--cond)}.st.nao{background:var(--trig)}.st.seco{background:var(--stop)}
.exec-l .q{font:500 12.5px var(--f-mono);color:var(--ink-2)}.exec-l b{font-weight:600}.exec-l .m{color:var(--ink-2);font-size:12.5px}
.exec-l .a{color:var(--brand);font-weight:600;background:none;border:0;cursor:pointer;font-size:12.5px}
.exec-fil{display:flex;gap:6px;flex-wrap:wrap}
.fil{appearance:none;border:1px solid var(--line);background:var(--node);color:var(--ink-2);font:500 13px var(--f-ui);padding:5px 12px;border-radius:999px;cursor:pointer}
.fil[aria-pressed=true]{border-color:var(--brand);color:var(--brand);background:var(--brand-soft)}
.modos{display:flex;gap:4px;margin:0 14px 10px;background:var(--app);border-radius:9px;padding:3px}
.modo{flex:1;appearance:none;border:0;background:transparent;color:var(--ink-2);font:600 12.5px var(--f-ui);padding:7px 8px;border-radius:7px;cursor:pointer}
.modo[aria-pressed=true]{background:var(--node);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.modo:focus-visible,.tri button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.est{font:600 11px var(--f-ui);padding:2px 8px;border-radius:999px;white-space:nowrap}
.est.ligada{background:color-mix(in srgb,var(--send) 16%,transparent);color:var(--send)}
.est.papel{background:color-mix(in srgb,var(--wait) 18%,transparent);color:var(--wait)}
.est.desligada{background:color-mix(in srgb,var(--stop) 18%,transparent);color:var(--stop)}
.est.sempre{background:color-mix(in srgb,var(--cond) 14%,transparent);color:var(--cond)}
.auto{padding:22px;display:grid;gap:16px;align-content:start;max-width:860px}
.auto-card{background:var(--node);border:1px solid var(--line);border-radius:14px;padding:18px;display:grid;gap:12px;box-shadow:var(--shadow)}
.auto-card h2{margin:0;font:700 20px var(--f-head);display:flex;gap:10px;align-items:center}
.auto-card h2 .ic{width:36px;height:36px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center;flex:none}.auto-card h2 .ic svg{width:20px;height:20px}
.auto-card p{margin:0;color:var(--ink-2);max-width:70ch}
.cuidado{background:color-mix(in srgb,var(--wait) 12%,transparent);border-radius:10px;padding:10px 12px;font-size:13px;color:var(--ink)}
.cuidado b{display:block;font:600 11px var(--f-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--wait);margin-bottom:3px}
.tri{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;width:fit-content;max-width:100%;flex-wrap:wrap}
.tri button{appearance:none;border:0;background:var(--node);color:var(--ink-2);font:600 13px var(--f-ui);padding:9px 14px;cursor:pointer}
.tri button+button{border-left:1px solid var(--line)}.tri button:disabled{opacity:.6;cursor:not-allowed}
.tri button[aria-pressed=true].ligada{background:var(--send);color:#fff}.tri button[aria-pressed=true].papel{background:var(--wait);color:#fff}.tri button[aria-pressed=true].desligada{background:var(--stop);color:#fff}
.tri-ajuda{font-size:12.5px;color:var(--ink-2)}
.acoes24{display:grid;gap:8px}.acoes24 h3{margin:0;font:600 11px var(--f-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)}
.acao{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;font-size:13px;padding:8px 10px;background:var(--app);border-radius:8px}
.acao span:first-child{font:500 12px var(--f-mono);color:var(--ink-2)}.acao small{display:block;color:var(--ink-2)}
.toast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--app);padding:9px 16px;border-radius:10px;font-size:13px;z-index:50;max-width:calc(100% - 32px)}
.toast.erro{background:#ca244d;color:#fff}
.vazio{padding:24px;color:var(--ink-2)}
@media (prefers-reduced-motion:reduce){.sw::after,.no .caixa{transition:none}}
</style></head><body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-bot" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 17h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="3.5" r="1.5" fill="currentColor"/></symbol>
  <symbol id="i-trig" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></symbol>
  <symbol id="i-wait" viewBox="0 0 24 24"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 9v4l3 2M9 2h6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>
  <symbol id="i-cond" viewBox="0 0 24 24"><path d="M6 4v6a4 4 0 0 0 4 4h8M18 14l-3-3M18 14l-3 3M6 20v-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-send" viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 7.5c-.6 1.6.4 4 2.3 5.8 1.9 1.8 4.3 2.7 5.7 2 .5-.3.9-.9.7-1.4l-1.2-1.2c-.4-.3-1-.2-1.3.2l-.4.4c-1.3-.6-2.4-1.7-3-3l.4-.4c.4-.3.5-.9.2-1.3L10.7 7.4c-.5-.3-1.4 0-2.2.1z" fill="currentColor"/></symbol>
  <symbol id="i-stop" viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10h8M8 14h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
</svg>
<div class="topo"><span class="logo">D</span><span class="mig">Doutor Digital Atende ›</span><b>Robôs</b>
  <span class="un"><span id="papel" class="pill so-ver" hidden></span><select id="unidadeSel" hidden aria-label="Unidade"></select><span id="unidadeNome"></span></span></div>
<div id="avisos"></div>
<div class="app" id="corpo" hidden>
  <aside class="lado" aria-label="Lista de robôs">
    <div class="lado-cab"><h1>Robôs</h1><button class="bt pri" type="button" id="btNovo" disabled title="Em breve: criar robôs novos (próxima versão)">+ Novo</button></div>
    <div class="modos" role="group" aria-label="O que ver"><button class="modo" type="button" id="mRobos" aria-pressed="true">Robôs de mensagem</button><button class="modo" type="button" id="mAuto" aria-pressed="false">Automações</button></div>
    <input class="busca" id="busca" type="search" placeholder="Procurar robô…" aria-label="Procurar robô">
    <nav class="lista" id="lista"></nav>
  </aside>
  <main class="palco">
    <div class="palco-cab">
      <span class="nome" id="nome"></span>
      <div class="abas" id="abasBox" role="tablist"><button class="aba" role="tab" id="abEd" aria-selected="true" type="button">Editor</button><button class="aba" role="tab" id="abEx" aria-selected="false" type="button">Execuções</button></div>
      <span class="ativo" id="ativoBox"><span id="ativoTxt">Ativo</span><button class="sw" type="button" role="switch" id="swAtivo" aria-checked="true" aria-label="Ligar ou desligar o robô"></button></span>
    </div>
    <div class="tela" id="tela"></div>
  </main>
</div>
<div id="raiz"></div>
<div id="toast" class="toast" role="status" hidden></div>
<script>
(function(){
  var CW = __ORIGEM_CW__, S = null, U = null, UNIDADES = [], DADOS = null, PODE = false, ENV = null, atual = null, aba = 'ed', busca = '', MODO = 'robos', AUTO = null, autoAtual = null;
  var $ = function(id){ return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function guardar(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function lerGuardado(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }
  function ic(id){ var s = document.createElementNS(NS, 'svg'), u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; }
  var tToast = null;
  function toast(txt, erro){ var t = $('toast'); t.textContent = txt; t.className = 'toast' + (erro ? ' erro' : ''); t.hidden = false; clearTimeout(tToast); tToast = setTimeout(function(){ t.hidden = true; }, 4200); }
  function aviso(txt, erro){ var a = $('avisos'); a.textContent = ''; if (txt) a.appendChild(el('div', 'aviso' + (erro ? ' erro' : ''), txt)); }

  // ── servidor (com o login do Chatwoot de quem está usando) ──
  function cab(){ var h = { 'Content-Type': 'application/json' }; if (S) { h['X-CW-Token'] = S.token; h['X-CW-Client'] = S.client; h['X-CW-Uid'] = S.uid; } return h; }
  function pedirSessao(){ try { window.parent.postMessage({ event: 'funil:pede-sessao' }, CW); } catch (e) {} }
  async function api(method, path, body){
    var r = await fetch(path, { method: method, headers: cab(), body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { var er = new Error(j.error || ('erro ' + r.status)); if (r.status === 401) { S = null; pedirSessao(); } throw er; }
    return j;
  }
  function enc(x){ return encodeURIComponent(x); }
  function abrirConversa(id){ try { window.parent.postMessage({ event: 'funil:abrir-conversa', id: id }, CW); } catch (e) {} }

  // ── datas ──
  function quando(iso){
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Belem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', ''); } catch (e) { return d.toISOString().slice(5, 16); }
  }

  // ── a lista à esquerda ──
  function robosFiltrados(){ return (DADOS ? DADOS.robos : []).filter(function(r){ return !busca || (r.nome + ' ' + r.etapa).toLowerCase().indexOf(busca) >= 0; }); }
  function um(n, u){ return n === 1 ? ({ dias: 'dia', horas: 'hora', minutos: 'minuto' }[u] || u) : u; }
  function resumoTempo(r){ return r.tempo ? r.tempo.atual.numero + ' ' + um(r.tempo.atual.numero, r.tempo.atual.unidade) + ' ' + r.tempo.direcao : (r.marca || 'na hora'); }
  function desenharLista(){
    var L = $('lista'); L.textContent = '';
    var lista = robosFiltrados(), vistos = {};
    lista.forEach(function(r){ vistos[r.grupoRotulo] = true; });
    Object.keys(vistos).forEach(function(g){
      var rs = lista.filter(function(r){ return r.grupoRotulo === g; });
      var h = el('div', 'grupo'); h.appendChild(el('span', null, g)); h.appendChild(el('span', null, rs.filter(function(r){ return r.ligado; }).length + '/' + rs.length + ' ativos')); L.appendChild(h);
      rs.forEach(function(r){
        var it = el('div', 'item' + (r.ligado ? '' : ' desl')); it.tabIndex = 0; it.setAttribute('role', 'button'); it.setAttribute('aria-current', String(atual && atual.regra === r.regra));
        var m = el('span', 'mini'); m.appendChild(ic(r.interna ? 'i-stop' : 'i-send')); it.appendChild(m);
        var tx = el('div'); tx.appendChild(el('b', null, r.nome)); tx.appendChild(el('small', null, r.etapa + ' · ' + resumoTempo(r))); it.appendChild(tx);
        var s = el('button', 'sw'); s.type = 'button'; s.setAttribute('role', 'switch'); s.setAttribute('aria-checked', String(r.ligado)); s.disabled = !PODE;
        s.setAttribute('aria-label', (r.ligado ? 'Desligar ' : 'Ligar ') + r.nome); if (!PODE) s.title = 'Só quem administra o CRM liga e desliga os robôs';
        s.addEventListener('click', function(ev){ ev.stopPropagation(); ligarDesligar(r); });
        it.appendChild(s);
        var abre = function(){ atual = r; aba = 'ed'; guardar('robos:robo', r.regra); tudo(); };
        it.addEventListener('click', abre); it.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') abre(); });
        L.appendChild(it);
      });
    });
    if (!lista.length) L.appendChild(el('div', 'vazio', 'Nenhum robô encontrado.'));
  }

  // ── a prancheta ──
  function no(tipo, ico, rot, det, x, y, onclick, extra){
    var b = el('button', 'no ' + tipo + (atual.ligado ? '' : ' desl')); b.type = 'button'; b.style.left = x + 'px'; b.style.top = y + 'px';
    var c = el('span', 'caixa'); c.appendChild(ic(ico)); if (extra) c.appendChild(extra); b.appendChild(c);
    b.appendChild(el('span', 'rot', rot)); if (det) b.appendChild(el('span', 'det', det));
    b.setAttribute('aria-label', rot + (det ? ': ' + det : '')); b.addEventListener('click', onclick); return b;
  }
  function fio(svg, x1, y1, x2, y2, cls, rotulo){
    var p = document.createElementNS(NS, 'path'), dx = Math.max(40, (x2 - x1) / 2);
    p.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2); if (cls) p.setAttribute('class', cls); svg.appendChild(p);
    if (rotulo) { var t = document.createElementNS(NS, 'text'); t.setAttribute('x', (x1 + x2) / 2 - 12); t.setAttribute('y', (y1 + y2) / 2 - 8); t.textContent = rotulo; svg.appendChild(t); }
  }
  function esperaDet(r){ return r.tempo ? r.tempo.atual.numero + ' ' + um(r.tempo.atual.numero, r.tempo.atual.unidade) + ' ' + r.tempo.direcao + (r.tempo.personalizado ? ' (mudado)' : '') : (r.marca || 'na hora'); }
  function editor(){
    var tela = $('tela'); tela.textContent = '';
    if (!atual) { tela.appendChild(el('div', 'vazio', 'Escolha um robô na lista.')); return; }
    var mundo = el('div', 'mundo'); tela.appendChild(mundo);
    var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'fios'); mundo.appendChild(svg);
    var r = atual, Y = 150, W = 92, cx = function(x){ return x + 10; }, mid = function(y){ return y + W / 2; };
    var temCond = r.condicoes.length > 0;
    var xs = { t: 60, w: 270, c: 480, s: temCond ? 700 : 480, n: 700 };
    mundo.appendChild(no('trig', 'i-trig', 'Gatilho', r.etapa, xs.t, Y, function(){ painel('trig'); }));
    mundo.appendChild(no('wait', 'i-wait', 'Esperar', esperaDet(r), xs.w, Y, function(){ painel('wait'); }));
    fio(svg, cx(xs.t) + W + 7, mid(Y), cx(xs.w) - 7, mid(Y));
    var fimTipo = r.interna ? 'Avisar a equipe' : 'Enviar WhatsApp';
    var fimDet = r.interna ? 'nota para quem atende' : (r.modelosDaTela.length ? r.modelosDaTela[0].atual : '');
    var selo = el('span', 'selo', String(r.enviados7d + r.notas7d));
    if (temCond) {
      mundo.appendChild(no('cond', 'i-cond', 'Só se', r.condicoes.join(' · '), xs.c, Y, function(){ painel('cond'); }));
      fio(svg, cx(xs.w) + W + 7, mid(Y), cx(xs.c) - 7, mid(Y));
      mundo.appendChild(no('send fim', 'i-send', fimTipo, fimDet, xs.s, Y - 70, function(){ painel('send'); }, selo));
      fio(svg, cx(xs.c) + W + 7, mid(Y), cx(xs.s) - 7, mid(Y - 70), '', 'sim');
      mundo.appendChild(no('stop fim', 'i-stop', 'Não envia', 'deixa nota para a equipe', xs.n, Y + 110, function(){ painel('stop'); }));
      fio(svg, cx(xs.c) + W + 7, mid(Y), cx(xs.n) - 7, mid(Y + 110), 'nao', 'não');
    } else {
      mundo.appendChild(no('send fim', 'i-send', fimTipo, fimDet, xs.s, Y, function(){ painel('send'); }, selo));
      fio(svg, cx(xs.w) + W + 7, mid(Y), cx(xs.s) - 7, mid(Y));
    }
    var post = el('div', 'post'); post.style.left = '920px'; post.style.top = '40px';
    post.appendChild(el('b', null, 'Proteções de todo robô'));
    post.appendChild(document.createTextNode('Só manda das 8h às 20h, de segunda a sábado. Nunca manda a mesma mensagem duas vezes ao mesmo paciente. Se o paciente tem cartão ativo no CRM antigo, deixa só uma nota. Só usa modelos aprovados pela Meta. Estas proteções não mudam por robô.'));
    mundo.appendChild(post);
    if (!r.ligado) mundo.appendChild(el('div', 'alerta', 'Robô desligado: não envia e não deixa nota.'));
    mundo.appendChild(el('div', 'dica', PODE ? 'Clique num bloco para ver ou configurar.' : 'Você pode ver os blocos; só quem administra o CRM configura.'));
  }

  // ── execuções ──
  var FIL = 'todos';
  function execucoes(){
    var tela = $('tela'); tela.textContent = '';
    var box = el('div', 'exec'); tela.appendChild(box);
    if (ENV === null) { box.appendChild(el('p', null, 'Carregando…')); carregarEnviados(); return; }
    var meus = ENV.itens.filter(function(e){ return atual && e.regra === atual.regra; });
    var fil = el('div', 'exec-fil');
    [['todos', 'Todas'], ['enviado', 'Enviadas'], ['nota', 'Só nota'], ['nao', 'Não enviadas']].forEach(function(f){
      var b = el('button', 'fil', f[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(FIL === f[0])); b.addEventListener('click', function(){ FIL = f[0]; execucoes(); }); fil.appendChild(b);
    });
    box.appendChild(fil);
    var p = el('p', null, meus.length ? 'Execuções deste robô nos últimos ' + ENV.dias + ' dias.' + (ENV.cortado ? ' (mostrando as mais recentes)' : '') : 'Este robô ainda não rodou nos últimos ' + ENV.dias + ' dias.'); p.style.margin = '0'; box.appendChild(p);
    meus.filter(function(e){ return FIL === 'todos' || (FIL === 'enviado' && e.enviado) || (FIL === 'nota' && !e.enviado && (e.situacao === 'kommo' || e.situacao === 'interna' || e.situacao === 'seco')) || (FIL === 'nao' && !e.enviado && ['faltou-campo', 'sem-template', 'perdida'].indexOf(e.situacao) >= 0); }).forEach(function(e){
      var l = el('div', 'exec-l'), cls = e.enviado ? 'ok' : (e.situacao === 'kommo' || e.situacao === 'interna') ? 'nota' : e.situacao === 'seco' ? 'seco' : 'nao';
      l.appendChild(el('span', 'st ' + cls, e.enviado ? '✓' : cls === 'nao' ? '!' : 'i'));
      l.appendChild(el('span', 'q', quando(e.quando)));
      var pr = el('span'); pr.appendChild(el('b', null, e.paciente || ('Conversa ' + e.conversa))); l.appendChild(pr);
      l.appendChild(el('span', 'm', e.rotulo));
      var a = el('button', 'a', 'Abrir conversa →'); a.type = 'button'; a.addEventListener('click', function(){ abrirConversa(e.conversa); }); l.appendChild(a);
      box.appendChild(l);
    });
  }
  async function carregarEnviados(){
    try { ENV = await api('GET', '/api/public/robos/enviados?slug=' + enc(U.slug)); if (aba === 'ex') execucoes(); }
    catch (e) { ENV = { itens: [], dias: 7, cortado: false, total: 0 }; aviso(e.message, true); if (aba === 'ex') execucoes(); }
  }

  // ── o painel de cada bloco ──
  function campo(rotulo){ var c = el('div', 'campo'); if (rotulo) c.appendChild(el('label', null, rotulo)); for (var i = 1; i < arguments.length; i++) if (arguments[i]) c.appendChild(arguments[i]); return c; }
  function sel(opcoes, valor){ var s = el('select'); opcoes.forEach(function(o){ var op = el('option', null, o.rotulo || o.valor); op.value = o.valor; if (o.valor === valor) op.selected = true; s.appendChild(op); }); return s; }
  function bolha(txt){ var chat = el('div', 'chat'), b = el('div', 'balao', txt || 'Sem exemplo de texto para este modelo.'); b.appendChild(el('span', 'hora', '09:00 ✓✓')); chat.appendChild(b); return chat; }
  function mudou(r){ return r.mudou ? 'Última alteração: ' + (r.mudou.por || 'alguém') + ', ' + quando(r.mudou.em) : 'Tudo de fábrica (ninguém mudou este robô).'; }
  var TITULOS = { trig: 'Gatilho', wait: 'Esperar', cond: 'Só se', send: 'Enviar WhatsApp', stop: 'Não envia' };
  var ICONES = { trig: 'i-trig', wait: 'i-wait', cond: 'i-cond', send: 'i-send', stop: 'i-stop' };
  var CORES = { trig: 'var(--trig)', wait: 'var(--wait)', cond: 'var(--cond)', send: 'var(--send)', stop: 'var(--stop)' };
  function painel(tipo){
    var r = atual, raiz = $('raiz'); raiz.textContent = '';
    var veu = el('div', 'ndv-veu'), nd = el('div', 'ndv'); nd.setAttribute('role', 'dialog'); nd.setAttribute('aria-label', TITULOS[tipo]); nd.style.setProperty('--cor', CORES[tipo]);
    var cb = el('div', 'ndv-cab'), i = el('span', 'ic'); i.appendChild(ic(ICONES[tipo])); cb.appendChild(i);
    cb.appendChild(el('h2', null, (tipo === 'send' && r.interna ? 'Avisar a equipe' : TITULOS[tipo]) + ' · ' + r.nome));
    var x = el('button', 'bt sec', 'Fechar'); x.type = 'button'; cb.appendChild(x); nd.appendChild(cb);
    var corpo = el('div', 'ndv-corpo'), a = el('div', 'col'), b = el('div', 'col');
    a.appendChild(el('h3', null, 'Parâmetros')); b.appendChild(el('h3', null, tipo === 'send' ? 'Como o paciente recebe' : 'Como funciona'));
    var aplicar = null, voltar = null, editavel = false;
    if (tipo === 'trig') {
      a.appendChild(campo('Quando', el('div', 'so-leitura', r.quando)));
      a.appendChild(campo('Etapa / tipo', el('div', 'so-leitura', r.etapa)));
      a.appendChild(el('p', 'ajuda', 'Somente leitura: o gatilho é a regra do robô no código. Na próxima versão dá para trocar por aqui.'));
      b.appendChild(el('p', null, 'O robô olha as conversas a cada 10 minutos. Quando a conversa bate com o gatilho, ele começa a contar o tempo do próximo bloco.'));
    } else if (tipo === 'wait') {
      if (!r.tempo) {
        a.appendChild(campo('Quando manda', el('div', 'so-leitura', r.marca || 'na hora')));
        a.appendChild(el('p', 'ajuda', 'Este robô age na hora do evento (ou num horário fixo do dia): não tem tempo para mudar.'));
      } else {
        var t = r.tempo, n = el('input'); n.type = 'number'; n.min = '0'; n.value = String(t.atual.numero); n.disabled = !PODE; n.setAttribute('aria-label', 'Quanto tempo');
        var u = sel(t.unidades.map(function(v){ return { valor: v }; }), t.atual.unidade); u.disabled = !PODE;
        var j = el('div', 'junto'); j.appendChild(n); j.appendChild(u); j.appendChild(el('span', 'dir', t.direcao + ' ' + t.ancora));
        a.appendChild(campo('Esperar', j, el('span', 'ajuda', 'A direção (' + t.direcao + ') e a âncora são do robô e não mudam. Vai de ' + t.minRotulo + ' a ' + t.maxRotulo + '. De fábrica: ' + t.rotuloPadrao + '.' + (t.nota ? ' ' + t.nota : ''))));
        editavel = PODE;
        aplicar = function(){ return [{ tempo: { numero: Number(n.value), unidade: u.value, direcao: t.direcao } }]; };
        if (t.personalizado) voltar = function(){ return [{ tempo: null }]; };
      }
      // o que acontece quando o horário do robô cai fora das 8h–20h (seg–sáb): depende da direção
      b.appendChild(el('p', null, r.tempo && r.tempo.direcao === 'antes'
        ? 'Só sai das 8h às 20h, de segunda a sábado. Se o horário do lembrete cair fora disso, ele ainda sai quando a janela abrir, mas só se for em até 2 horas depois do horário; passou disso, esse lembrete se perde.'
        : 'Só sai das 8h às 20h, de segunda a sábado. Se o horário cair fora disso, sai quando a janela abrir, desde que seja em até 12 horas depois do horário; passou disso, essa mensagem se perde.'));
    } else if (tipo === 'cond') {
      r.condicoes.forEach(function(c){ a.appendChild(el('div', 'so-leitura', '✓ ' + c)); });
      a.appendChild(el('p', 'ajuda', 'Somente leitura: as condições são a regra do robô no código. Na próxima versão dá para editar por aqui.'));
      b.appendChild(el('p', null, 'Todas as condições precisam ser verdade. Se alguma não for, o robô não envia.'));
    } else if (tipo === 'send') {
      if (r.interna) {
        a.appendChild(el('p', null, r.modelos.length && r.modelos[0].texto ? r.modelos[0].texto : 'Deixa uma nota para quem atende.'));
        b.appendChild(el('p', null, 'Este robô não manda nada ao paciente: só avisa a equipe.'));
      } else {
        var seletores = [];
        var previa = el('div');
        r.modelosDaTela.forEach(function(m){
          var s = sel(m.opcoes.map(function(o){ return { valor: o.modelo }; }), m.atual); var temAlternativa = m.opcoes.length > 1; s.disabled = !PODE || !DADOS.aprovadosLidos || !temAlternativa;
          var dica = !temAlternativa ? 'Sem alternativa aprovada para este modelo' : (m.padrao !== m.atual ? 'De fábrica: ' + m.padrao : (r.modelosDaTela.length > 1 ? 'De fábrica: ' + m.padrao : ''));
          a.appendChild(campo(r.modelosDaTela.length > 1 ? 'Modelo (' + m.padrao + ')' : 'Modelo aprovado pela Meta', s, dica ? el('span', 'ajuda', dica) : null));
          var pv = el('div'); pv.appendChild(bolha(m.texto)); previa.appendChild(pv);
          s.addEventListener('change', function(){ var o = m.opcoes.filter(function(y){ return y.modelo === s.value; })[0]; pv.textContent = ''; pv.appendChild(bolha(o ? o.texto : '')); });
          seletores.push({ m: m, s: s });
        });
        a.appendChild(el('p', 'ajuda', DADOS.aprovadosLidos ? 'Só aparecem as alternativas que a equipe técnica liberou para este modelo e que já estão aprovadas nesta caixa. Texto novo: peça à Doutor Digital (a Meta aprova em até 48 h).' : 'Não consegui ler os modelos aprovados no Chatwoot agora; a troca de modelo está indisponível.'));
        b.appendChild(previa);
        editavel = PODE && DADOS.aprovadosLidos && seletores.some(function(z){ return z.m.opcoes.length > 1; });
        // TODOS os seletores que mudaram (um pedido por modelo de fábrica); «voltar ao de fábrica» desfaz todos os trocados
        aplicar = function(){ var mud = seletores.filter(function(z){ return z.s.value !== z.m.atual; }); return mud.length ? mud.map(function(z){ return { modelo: { padrao: z.m.padrao, novo: z.s.value } }; }) : null; };
        if (r.modelosDaTela.some(function(m){ return m.personalizado; })) voltar = function(){ return r.modelosDaTela.filter(function(m){ return m.personalizado; }).map(function(m){ return { modelo: { padrao: m.padrao, novo: m.padrao } }; }); };
      }
    } else {
      a.appendChild(el('p', null, 'Quando uma condição não bate, ou o paciente tem cartão ativo no CRM antigo, nada vai para o paciente. Fica uma nota privada na conversa dizendo por quê, por exemplo: «Não enviado: o paciente tem cartão ativo no CRM antigo».'));
      b.appendChild(el('p', null, 'Assim a equipe sempre sabe por que um paciente não recebeu.'));
    }
    corpo.appendChild(a); corpo.appendChild(b); nd.appendChild(corpo);
    var pe = el('div', 'ndv-pe'); pe.appendChild(el('small', null, mudou(r)));
    var fim = el('div', 'fim');
    var fecha = function(){ raiz.textContent = ''; document.removeEventListener('keydown', esc); };
    function esc(ev){ if (ev.key === 'Escape') fecha(); }
    document.addEventListener('keydown', esc);
    if (editavel && voltar) { var vb = el('button', 'bt link', 'Voltar ao de fábrica'); vb.type = 'button'; vb.addEventListener('click', function(){ enviar(voltar(), vb, fecha); }); fim.appendChild(vb); }
    var can = el('button', 'bt sec', editavel ? 'Cancelar' : 'Fechar'); can.type = 'button'; can.addEventListener('click', fecha); fim.appendChild(can);
    if (editavel && aplicar) { var ok = el('button', 'bt pri', 'Aplicar'); ok.type = 'button'; ok.addEventListener('click', function(){ var p = aplicar(); if (!p) { fecha(); return; } enviar(p, ok, fecha); }); fim.appendChild(ok); }
    pe.appendChild(fim); nd.appendChild(pe); veu.appendChild(nd); raiz.appendChild(veu);
    x.addEventListener('click', fecha); veu.addEventListener('click', function(ev){ if (ev.target === veu) fecha(); });
  }
  // grava cada parte (um pedido por vez) e SÓ diz «Salvo» depois que o servidor confirmou todas; se uma falhar, o painel fica aberto com o erro
  async function enviar(partes, botao, fecha){
    botao.disabled = true;
    var gravou = 0;
    try {
      for (var i = 0; i < partes.length; i++) {
        var corpo = { slug: U.slug }; Object.keys(partes[i]).forEach(function(k){ corpo[k] = partes[i][k]; });
        await api('POST', '/api/public/robos/' + enc(atual.regra), corpo);
        gravou++;
      }
    } catch (e) {
      botao.disabled = false;
      if (gravou) { try { await carregar(); } catch (x) {} }
      toast((gravou ? gravou + ' de ' + partes.length + ' alterações foram salvas; a próxima não: ' : 'Não salvou: ') + e.message, true);
      return;
    }
    fecha();
    try { await carregar(); toast('Salvo. Vale na próxima volta do robô (até 10 minutos).'); }
    catch (e) { toast('Salvo no servidor, mas não consegui recarregar a tela: atualize a página.', true); }
    botao.disabled = false;
  }
  async function ligarDesligar(r){
    if (!PODE) return;
    var alvo = !r.ligado;
    try { await api('POST', '/api/public/robos/' + enc(r.regra), { slug: U.slug, ligado: alvo }); }
    catch (e) { toast(e.message, true); return; }
    try { await carregar(); toast('«' + r.nome + '» ' + (alvo ? 'ligado' : 'desligado') + '. Vale na próxima volta do robô (até 10 minutos).'); }
    catch (e) { toast('Salvo no servidor, mas não consegui recarregar a tela: atualize a página.', true); }
  }


  // ── aba «Automações»: tudo que roda no CRM, por grupo; o estado da unidade; o seletor de 3 estados só para o administrador ──
  var ROT_ESTADO = { ligado: 'Ligada', seco: 'Só no papel', desligado: 'Desligada', sempre: 'Sempre ligada' };
  var CLS_ESTADO = { ligado: 'ligada', seco: 'papel', desligado: 'desligada', sempre: 'sempre' };
  var ORDEM_GRUPOS = ['Sofia', 'Agenda', 'Mensagens', 'Rastreio', 'Organização', 'Avisos para a equipe', 'Regras nativas do Chatwoot'];
  function itensDeAuto(){
    if (!AUTO) return [];
    var itens = AUTO.automacoes.slice();
    var nat = AUTO.nativas || { regras: [], lidas: false, link: null };
    if (nat.lidas && nat.regras.length) nat.regras.forEach(function(r){ itens.push({ id: 'nativa-' + r.id, grupoRotulo: 'Regras nativas do Chatwoot', nome: r.nome || ('Regra ' + r.id), oQueFaz: r.descricao || 'Regra criada em Configurações > Automação do Chatwoot.', estado: r.ativa ? 'ligado' : 'desligado', editavel: false, estados: [], origem: 'nativa', evento: r.evento, cuidado: null, ultimas: [], semRegistro: true, mudou: null, semVolta: false, nota: null }); });
    else itens.push({ id: 'nativa-link', grupoRotulo: 'Regras nativas do Chatwoot', nome: 'Regras nativas do Chatwoot', oQueFaz: nat.lidas ? 'Nenhuma regra nativa criada.' : 'Não consegui ler as regras nativas agora. Elas ficam em Configurações > Automação do Chatwoot.', estado: 'sempre', editavel: false, estados: [], origem: 'nativa', cuidado: null, ultimas: [], semRegistro: true, mudou: null, semVolta: false, nota: null });
    return itens.filter(function(a){ return !busca || (a.nome + ' ' + a.grupoRotulo).toLowerCase().indexOf(busca) >= 0; });
  }
  function listaAuto(){
    var L = $('lista'); L.textContent = '';
    var itens = itensDeAuto();
    ORDEM_GRUPOS.forEach(function(g){
      var rs = itens.filter(function(a){ return a.grupoRotulo === g; });
      if (!rs.length) return;
      var h = el('div', 'grupo'); h.appendChild(el('span', null, g)); h.appendChild(el('span', null, String(rs.length))); L.appendChild(h);
      rs.forEach(function(a){
        var it = el('div', 'item' + (a.estado === 'desligado' ? ' desl' : '')); it.tabIndex = 0; it.setAttribute('role', 'button'); it.setAttribute('aria-current', String(autoAtual && autoAtual.id === a.id));
        var m = el('span', 'mini'); m.appendChild(ic('i-bot')); it.appendChild(m);
        var tx = el('div'); tx.appendChild(el('b', null, a.nome)); tx.appendChild(el('small', null, a.origem === 'catalogo' ? (a.vemDoAmbiente ? 'padrão do servidor' : 'escolhida na tela') : a.origem === 'nativa' ? 'nativa do Chatwoot' : 'somente leitura')); it.appendChild(tx);
        it.appendChild(el('span', 'est ' + CLS_ESTADO[a.estado], ROT_ESTADO[a.estado]));
        var abre = function(){ autoAtual = a; guardar('robos:auto', a.id); tudoAuto(); };
        it.addEventListener('click', abre); it.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') abre(); });
        L.appendChild(it);
      });
    });
    if (!itens.length) L.appendChild(el('div', 'vazio', 'Nada encontrado.'));
  }
  function acaoDe(a){ var d = el('div', 'acao'); d.appendChild(el('span', null, quando(a.em))); var t = el('span'); t.appendChild(document.createTextNode(a.texto)); if (a.resumo) t.appendChild(el('small', null, a.resumo)); d.appendChild(t); return d; }
  function viewAuto(){
    var tela = $('tela'); tela.textContent = '';
    var a = autoAtual;
    if (!a) { tela.appendChild(el('div', 'vazio', 'Escolha uma automação na lista.')); return; }
    var box = el('div', 'auto'), card = el('div', 'auto-card');
    var h = el('h2'); var i = el('span', 'ic'); i.appendChild(ic('i-bot')); h.appendChild(i); h.appendChild(document.createTextNode(a.nome)); h.appendChild(el('span', 'est ' + CLS_ESTADO[a.estado], ROT_ESTADO[a.estado])); card.appendChild(h);
    card.appendChild(el('p', null, a.oQueFaz));
    if (a.cuidado) { var c = el('div', 'cuidado'); c.appendChild(el('b', null, 'Cuidado')); c.appendChild(document.createTextNode(a.cuidado)); card.appendChild(c); }
    if (a.semVolta) { var sv = el('div', 'cuidado'); sv.appendChild(el('b', null, 'Não tem volta')); sv.appendChild(document.createTextNode('Depois de ligada, o que ela faz não se desfaz. A tela pede a sua confirmação antes de ligar.')); card.appendChild(sv); }
    if (a.editavel) {
      var tri = el('div', 'tri'); tri.setAttribute('role', 'group'); tri.setAttribute('aria-label', 'Estado');
      a.estados.forEach(function(e){
        var b = el('button', CLS_ESTADO[e], ROT_ESTADO[e]); b.type = 'button'; b.setAttribute('aria-pressed', String(a.estado === e)); b.disabled = !PODE;
        if (!PODE) b.title = 'Só quem administra o CRM muda as automações';
        b.addEventListener('click', function(){ if (a.estado !== e) mudarAuto(a, e); });
        tri.appendChild(b);
      });
      card.appendChild(tri);
      card.appendChild(el('div', 'tri-ajuda', 'Ligada: faz de verdade. Só no papel: decide e deixa registro, sem mexer em nada. Desligada: não faz nada.' + (a.exigeSecoAntes ? ' Para ligar, ela precisa ter rodado antes em «Só no papel».' : '') + (PODE ? '' : ' Você pode ver; só quem administra o CRM muda.')));
      card.appendChild(el('div', 'tri-ajuda', a.mudou ? 'Última alteração pela tela: ' + (a.mudou.por || 'alguém') + ', ' + quando(a.mudou.em) + '.' : 'Ninguém mexeu pela tela: vale o padrão do servidor.'));
    } else if (a.origem === 'nativa') {
      card.appendChild(el('div', 'tri-ajuda', 'Regra do próprio Chatwoot' + (a.evento ? ' (evento: ' + a.evento + ')' : '') + '. Para mudar, use Configurações > Automação do Chatwoot.'));
      if (AUTO.nativas && AUTO.nativas.link) { var ab = el('button', 'bt sec', 'Abrir a tela nativa do Chatwoot'); ab.type = 'button'; ab.addEventListener('click', function(){ window.open(AUTO.nativas.link, '_blank', 'noopener'); }); card.appendChild(ab); }
    } else {
      card.appendChild(el('div', 'tri-ajuda', a.nota || 'Somente leitura.'));
    }
    var ac = el('div', 'acoes24'); ac.appendChild(el('h3', null, 'Últimas ações'));
    if (a.origem === 'catalogo' && a.ultimas.length) a.ultimas.forEach(function(x){ ac.appendChild(acaoDe(x)); });
    else ac.appendChild(el('div', 'tri-ajuda', a.origem === 'catalogo' ? 'Sem registro: o log do servidor não guardou nada desta automação para esta unidade.' : 'Sem registro nesta tela.'));
    card.appendChild(ac);
    box.appendChild(card); tela.appendChild(box);
  }
  function tudoAuto(){
    $('abasBox').hidden = true; $('ativoBox').hidden = true; $('btNovo').hidden = true; $('busca').placeholder = 'Procurar automação…';
    $('mRobos').setAttribute('aria-pressed', 'false'); $('mAuto').setAttribute('aria-pressed', 'true');
    if (!AUTO) { $('tela').textContent = ''; $('tela').appendChild(el('div', 'vazio', 'Carregando…')); return; }
    $('nome').textContent = autoAtual ? autoAtual.nome : 'Automações';
    listaAuto(); viewAuto();
  }
  async function carregarAuto(){
    try {
      AUTO = await api('GET', '/api/public/robos/automacoes?slug=' + enc(U.slug)); PODE = !!AUTO.pode;
      var itens = itensDeAuto(), ant = autoAtual ? autoAtual.id : lerGuardado('robos:auto');
      autoAtual = itens.filter(function(a){ return a.id === ant; })[0] || itens[0] || null;
    } catch (e) { aviso(e.message, true); AUTO = { automacoes: [], nativas: { regras: [], lidas: false, link: null }, pode: false }; }
    if (MODO === 'auto') tudoAuto();
  }
  function confirmar(a, alvo){
    var raiz = $('raiz'); raiz.textContent = '';
    var veu = el('div', 'ndv-veu'), nd = el('div', 'ndv'); nd.style.setProperty('--cor', 'var(--trig)'); nd.style.maxWidth = '520px'; nd.setAttribute('role', 'alertdialog'); nd.setAttribute('aria-label', 'Confirmar');
    var cb = el('div', 'ndv-cab'); cb.appendChild(el('h2', null, 'Ligar «' + a.nome + '»?')); nd.appendChild(cb);
    var col = el('div', 'col'); col.appendChild(el('p', null, 'Esta automação NÃO TEM VOLTA: o que ela fizer não se desfaz.')); if (a.cuidado) col.appendChild(el('div', 'cuidado', a.cuidado)); col.appendChild(el('p', null, 'Ligue só se você tem certeza. O mais seguro é deixar antes em «Só no papel» e conferir o registro.')); nd.appendChild(col);
    var pe = el('div', 'ndv-pe'); pe.appendChild(el('small', null, ''));
    var fim = el('div', 'fim'), can = el('button', 'bt sec', 'Cancelar'), ok = el('button', 'bt pri', 'Entendi, ligar mesmo'); can.type = 'button'; ok.type = 'button';
    var fecha = function(){ raiz.textContent = ''; };
    can.addEventListener('click', fecha); veu.addEventListener('click', function(ev){ if (ev.target === veu) fecha(); });
    ok.addEventListener('click', function(){ fecha(); gravarAuto(a, alvo, true); });
    fim.appendChild(can); fim.appendChild(ok); pe.appendChild(fim); nd.appendChild(pe); veu.appendChild(nd); raiz.appendChild(veu);
  }
  async function gravarAuto(a, alvo, confirmado){
    try { await api('POST', '/api/public/robos/automacoes/' + enc(a.id), { slug: U.slug, estado: alvo, confirmar: confirmado === true }); await carregarAuto(); toast('«' + a.nome + '»: ' + ROT_ESTADO[alvo] + '.'); }
    catch (e) { toast(e.message, true); if (/NÃO TEM VOLTA/.test(e.message)) confirmar(a, alvo); }
  }
  function mudarAuto(a, alvo){ if (!PODE) return; if (a.semVolta && alvo === 'ligado') { confirmar(a, alvo); return; } gravarAuto(a, alvo, false); }
  function trocarModo(m){
    MODO = m; busca = ''; $('busca').value = '';
    $('mRobos').setAttribute('aria-pressed', String(m === 'robos')); $('mAuto').setAttribute('aria-pressed', String(m === 'auto'));
    if (m === 'auto') { if (!AUTO) carregarAuto(); tudoAuto(); } else tudo();
  }
  $('mRobos').addEventListener('click', function(){ trocarModo('robos'); });
  $('mAuto').addEventListener('click', function(){ trocarModo('auto'); });

  // ── tudo junto ──
  function tudo(){
    if (MODO === 'auto') { tudoAuto(); return; }
    $('abasBox').hidden = false; $('ativoBox').hidden = false; $('btNovo').hidden = false; $('busca').placeholder = 'Procurar robô…';
    desenharLista();
    if (atual) { $('nome').textContent = atual.nome; var sw = $('swAtivo'); sw.setAttribute('aria-checked', String(atual.ligado)); sw.disabled = !PODE; $('ativoTxt').textContent = atual.ligado ? 'Ativo' : 'Desligado'; }
    $('abEd').setAttribute('aria-selected', String(aba === 'ed')); $('abEx').setAttribute('aria-selected', String(aba === 'ex'));
    if (aba === 'ed') editor(); else execucoes();
  }
  async function carregar(){
    DADOS = await api('GET', '/api/public/robos?slug=' + enc(U.slug));
    PODE = !!DADOS.pode; ENV = null;
    var p = $('papel'); p.hidden = false; p.className = 'pill' + (PODE ? '' : ' so-ver'); p.textContent = PODE ? 'Gestora: você configura' : 'Só ver';
    var ant = atual ? atual.regra : lerGuardado('robos:robo');
    atual = DADOS.robos.filter(function(r){ return r.regra === ant; })[0] || DADOS.robos[0] || null;
    tudo();
  }
  $('swAtivo').addEventListener('click', function(){ if (atual) ligarDesligar(atual); });
  $('abEd').addEventListener('click', function(){ aba = 'ed'; tudo(); });
  $('abEx').addEventListener('click', function(){ aba = 'ex'; tudo(); });
  $('busca').addEventListener('input', function(ev){ busca = ev.target.value.toLowerCase(); if (MODO === 'auto') listaAuto(); else desenharLista(); });

  // ── entrada: sessão do Chatwoot pelo menu, unidade pelas caixas da pessoa ──
  function escolherUnidade(u){ U = u; guardar('robos:unidade', u.slug); $('unidadeNome').textContent = u.nome; atual = null; ENV = null; AUTO = null; autoAtual = null; if (MODO === 'auto') carregarAuto(); return carregar().then(function(){ aviso(''); }).catch(function(e){ aviso(e.message, true); }); }
  async function entrar(){
    try {
      var r = await api('GET', '/api/public/testar-ia/unidades');
      UNIDADES = r.unidades || [];
      if (!UNIDADES.length) { aviso('Você não atende nenhuma caixa com robôs. Peça para a Suzanne liberar a caixa da sua unidade.', true); $('unidadeNome').textContent = 'Sem unidade'; return; }
      var guardada = lerGuardado('robos:unidade'), u = UNIDADES.filter(function(x){ return x.slug === guardada; })[0] || UNIDADES[0];
      if (UNIDADES.length > 1) {
        var s = $('unidadeSel'); s.hidden = false; s.textContent = '';
        UNIDADES.forEach(function(x){ var o = el('option', null, x.nome); o.value = x.slug; s.appendChild(o); });
        s.value = u.slug; s.onchange = function(){ var x = UNIDADES.filter(function(y){ return y.slug === s.value; })[0]; if (x) escolherUnidade(x); };
        $('unidadeNome').textContent = '';
      }
      $('corpo').hidden = false;
      await escolherUnidade(u);
    } catch (e) { aviso(e.message, true); }
  }
  window.addEventListener('message', function(ev){
    if (ev.origin !== CW || ev.source !== window.parent) return;
    var d = ev.data; if (!d || d.event !== 'funil-sessao') return;
    var novo = d.sessao && d.sessao.token ? d.sessao : null, primeira = !S && novo && !U; S = novo;
    if (primeira) entrar();
  });
  pedirSessao(); setTimeout(function(){ if (!S) pedirSessao(); }, 1500);
  setTimeout(function(){ if (!S) aviso('Abra esta tela pelo menu do CRM (Robôs), já logada.', true); }, 6000);
})();
</script></body></html>`;

/** A página. `origemChatwoot` = a origem do Chatwoot (só ela fala com a página por postMessage). */
export function paginaDosRobos(origemChatwoot: string): string {
  return PAGINA.split('__ORIGEM_CW__').join(JSON.stringify(origemChatwoot));
}
