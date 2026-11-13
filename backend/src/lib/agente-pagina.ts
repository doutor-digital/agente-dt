/**
 * A tela "Agente" do menu do Chatwoot (pedido do João, 13/11/2026): a equipe da clínica cuida da própria Sofia, sem depender da
 * Doutor Digital — e o que precisa de código vira pedido para a gente.
 *
 *   Início    → como a Sofia está indo (👍/👎 da semana) e as respostas marcadas 👎 esperando alguém (ensinar, pedir, dar ok)
 *   Ensinar   → escrever o que ela deve fazer diferente, testar (antes × depois) e salvar; ligar/desligar as regras da unidade
 *   Testar    → conversar com a Sofia como se fosse o paciente (nada vai a paciente)
 *   Pausadas  → conversas em que a equipe assumiu; reativar a Sofia
 *   Pedir     → pedido à Doutor Digital (valor, horário, erro…): vira demanda no painel do suporte e avisa o bot de chamados
 *
 * Visual: o mesmo da tela "Minha IA" do agente.doutordigitalconsultoria.com (`frontend/src/components/unidade/estilos.ts`): noite
 * azul, cartões com fio de luz, Bricolage Grotesque nos números e títulos, Public Sans no texto.
 *
 * A sessão chega do menu do Chatwoot por postMessage (`funil:pede-sessao` → `funil-sessao`, com checagem de origem), igual às
 * outras telas do menu. Todo texto que vem do servidor entra por textContent (nunca innerHTML). O JavaScript não usa crase nem
 * `${`: o texto inteiro é um String.raw e só `__ORIGEM_CW__` é trocado.
 */

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agente · Sofia</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--noite:#070D18;--placa:#0E1728;--linha:rgba(255,255,255,.08);--linha2:rgba(255,255,255,.14);--osso:#EAF0F9;--nevoa:#B7C4D9;--bruma:#7E93B4;--vida:#4C9EFF;--carne:#2FBF71;--alerta:#FF6B3D;--sol:#F5B544}
*{box-sizing:border-box}html,body{margin:0}
body{min-height:100vh;color:var(--osso);font:14.5px/1.5 "Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
  background:radial-gradient(1100px 520px at 12% -12%,rgba(76,158,255,.13),transparent 62%),radial-gradient(760px 420px at 96% 4%,rgba(47,191,113,.08),transparent 60%),var(--noite);background-attachment:fixed}
[hidden]{display:none!important}
.display{font-family:"Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.025em}
main{max-width:1180px;margin:0 auto;padding:22px 28px 56px}
button{font:inherit}
:focus-visible{outline:2px solid var(--vida);outline-offset:2px}
.cartao{position:relative;overflow:hidden;border-radius:16px;border:1px solid var(--linha);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.018))}
.cartao::before{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent);pointer-events:none}
.viva{transition:transform .25s cubic-bezier(.16,1,.3,1),border-color .25s,box-shadow .25s}
.viva:hover{transform:translateY(-2px);border-color:rgba(76,158,255,.35);box-shadow:0 10px 34px -18px rgba(76,158,255,.55)}

/* topo */
.topo{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;padding:16px 20px}
.marca{display:flex;align-items:center;gap:14px}
.pulso{position:relative;width:12px;height:12px;border-radius:50%;background:var(--vida);flex:none;margin:0 6px}
.pulso::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--vida);opacity:0;animation:onda 2.4s cubic-bezier(.16,1,.3,1) infinite}
@keyframes onda{0%{transform:scale(.4);opacity:.7}100%{transform:scale(1.6);opacity:0}}
.sobre{font-size:10.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--bruma)}
.topo h1{margin:0;font-size:24px;font-weight:700;line-height:1.1}
.topo h1 small{font:500 14px "Public Sans",sans-serif;color:var(--bruma);letter-spacing:0;margin-left:6px}
.eu{display:flex;align-items:center;gap:10px;color:var(--bruma);font-size:12.5px}
.eu select{width:auto;padding:7px 10px;border-radius:10px}
.av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:700;font-size:13px;background:rgba(76,158,255,.16);color:var(--vida)}

/* abas */
.abas{display:flex;gap:4px;padding:6px;margin:14px 0 18px;overflow-x:auto;scrollbar-width:none}
.aba{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:11px;border:0;background:transparent;color:var(--bruma);font-weight:600;font-size:13.5px;cursor:pointer;white-space:nowrap;transition:color .18s,background .18s}
.aba svg{width:16px;height:16px;flex:none}
.aba:hover{color:var(--osso);background:rgba(255,255,255,.045)}
.aba[aria-selected="true"]{color:var(--osso);background:rgba(76,158,255,.14);box-shadow:inset 0 0 0 1px rgba(76,158,255,.38)}
.conta{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--alerta);color:#1d0b04;font-size:11px;font-weight:800}
.conta.azul{background:var(--vida);color:#06101f}

/* números */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.kpi{padding:18px 20px}
.kpi .num{display:block;font-size:44px;font-weight:700;line-height:.95}
.kpi .rot{margin-top:8px;font-size:12.5px;line-height:1.35;color:var(--bruma)}
.kpi .rod{margin-top:6px;font-size:11.5px;font-weight:700}
.bom{color:var(--carne)}.ruim{color:var(--alerta)}.calmo{color:var(--bruma)}
.duas{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);gap:14px;margin-top:14px;align-items:start}
.sec{padding:18px 20px}
.sec h2{margin:0;font-family:"Bricolage Grotesque",system-ui,sans-serif;font-size:17px;font-weight:700;letter-spacing:-.02em}
.sec .sub{margin:4px 0 14px;color:var(--bruma);font-size:12.5px;line-height:1.45}
.vazio{padding:22px 4px;color:var(--bruma);font-size:13.5px;line-height:1.5}
.vazio b{color:var(--osso)}

/* casos para revisar */
.caso{border:1px solid var(--linha);border-radius:14px;padding:14px;background:rgba(255,255,255,.025);margin-top:10px}
.caso:first-child{margin-top:0}
.caso-topo{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--bruma);margin-bottom:8px}
.caso-topo b{color:var(--osso)}
.bolha{border-radius:14px;padding:9px 12px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;margin-top:6px}
.bolha small{display:block;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--bruma);margin-bottom:3px}
.bolha.pac{background:rgba(255,255,255,.06)}
.bolha.sofia{background:rgba(76,158,255,.15)}
.bolha.nova{background:rgba(47,191,113,.13);box-shadow:inset 0 0 0 1px rgba(47,191,113,.38)}
.errado{margin:10px 0 0;padding:9px 12px;border-radius:12px;background:rgba(255,107,61,.09);color:#FFD2C2;font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.errado b{color:var(--alerta)}
.acoes{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}

/* botões e campos */
.bt{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:8px 13px;border-radius:10px;border:1px solid var(--linha2);background:rgba(255,255,255,.04);color:var(--osso);font-weight:600;font-size:13px;line-height:1.1;cursor:pointer;transition:border-color .18s,background .18s,filter .18s;white-space:nowrap}
.bt svg{width:15px;height:15px;flex:none}
.bt:hover{border-color:rgba(76,158,255,.5);background:rgba(76,158,255,.08)}
.bt.primario{background:var(--vida);border-color:var(--vida);color:#06101f}
.bt.verde{background:var(--carne);border-color:var(--carne);color:#04140b}
.bt.primario:hover,.bt.verde:hover{filter:brightness(1.08)}
.bt.fantasma{border-color:transparent;background:transparent;color:var(--bruma)}
.bt.fantasma:hover{color:var(--osso);background:rgba(255,255,255,.05)}
.bt.grande{min-height:44px;padding:11px 18px;font-size:14px;border-radius:12px}
.bt:disabled{opacity:.5;cursor:default;filter:none}
textarea,input,select{width:100%;background:rgba(5,10,20,.55);border:1px solid var(--linha2);border-radius:12px;color:var(--osso);font:inherit;padding:12px 14px;transition:border-color .18s,box-shadow .18s}
textarea{min-height:112px;resize:vertical;line-height:1.5}
textarea::placeholder,input::placeholder{color:#5E7193}
textarea:focus,input:focus,select:focus{outline:none;border-color:var(--vida);box-shadow:0 0 0 3px rgba(76,158,255,.18)}
label.rot{display:flex;justify-content:space-between;gap:10px;font-size:13px;font-weight:600;color:var(--nevoa);margin:0 0 8px}
label.rot span{font-weight:500;color:var(--bruma);font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{display:inline-flex;align-items:center;padding:6px 11px;border-radius:999px;border:1px dashed var(--linha2);background:transparent;color:var(--nevoa);font-size:12.5px;cursor:pointer;text-align:left;transition:border-color .18s,color .18s}
.chip:hover{border-style:solid;border-color:var(--vida);color:var(--osso)}
details.falas{margin-top:12px}
details.falas summary{cursor:pointer;color:var(--bruma);font-size:12.5px;list-style:none}
details.falas summary::before{content:"▸ ";}
details.falas[open] summary::before{content:"▾ ";}
details.falas input{margin-top:8px}
.rodape-form{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-top:14px}
.nota{color:var(--bruma);font-size:12px}
.aviso{padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.45;margin-top:12px;white-space:pre-wrap}
.aviso.erro{background:rgba(255,107,61,.1);color:#FFD2C2}
.aviso.ok{background:rgba(47,191,113,.1);color:#BDF2D4}

/* prévia antes × depois */
.previa-item{border-top:1px solid var(--linha);padding-top:14px;margin-top:14px}
.previa-item:first-child{border-top:0;padding-top:0;margin-top:0}
.lado{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}

/* regras */
.regra{display:flex;gap:12px;align-items:flex-start;padding:12px 2px;border-top:1px solid var(--linha)}
.regra:first-child{border-top:0}
.regra p{margin:0;flex:1;min-width:0;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.regra small{display:block;margin-top:3px;color:var(--bruma);font-size:11.5px}
.regra.off p{color:var(--bruma)}
.sw{position:relative;width:38px;height:22px;border-radius:999px;border:0;background:rgba(255,255,255,.14);cursor:pointer;flex:none;margin-top:1px;transition:background .2s}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s cubic-bezier(.16,1,.3,1)}
.sw[aria-checked="true"]{background:var(--carne)}
.sw[aria-checked="true"]::after{transform:translateX(16px)}
details.equipe{margin-top:14px;border-top:1px solid var(--linha);padding-top:12px}
details.equipe summary{cursor:pointer;color:var(--nevoa);font-size:13px;font-weight:600}
details.equipe ul{margin:10px 0 0;padding-left:18px;color:var(--bruma);font-size:12.5px;line-height:1.55}
details.equipe li{margin:3px 0}
details.equipe li span{color:#5E7193}

/* passos */
.passos{list-style:none;margin:0;padding:0}
.passos li{display:flex;gap:12px;padding:11px 8px;border-radius:12px;cursor:pointer;transition:background .18s}
.passos li:hover{background:rgba(255,255,255,.045)}
.passos .n{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;flex:none;font:700 12.5px "Bricolage Grotesque",sans-serif;background:rgba(76,158,255,.16);color:var(--vida)}
.passos b{display:block;font-size:13.5px}
.passos span{display:block;color:var(--bruma);font-size:12.5px;line-height:1.4;margin-top:1px}

/* conversa de teste */
.teste{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:14px;align-items:start}
.chat-topo{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--linha)}
.chat-topo b{display:block;font-size:14px}
.chat-topo span{font-size:12px;color:var(--bruma)}
.selo{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:rgba(245,181,68,.12);color:var(--sol);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.chat{display:flex;flex-direction:column;gap:8px;height:min(54vh,520px);overflow-y:auto;padding:18px}
.msg{max-width:78%;padding:9px 13px;border-radius:16px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word;animation:entra .35s cubic-bezier(.16,1,.3,1) both}
.msg.pac{align-self:flex-end;background:var(--vida);color:#06101f;border-bottom-right-radius:5px}
.msg.sofia{align-self:flex-start;background:rgba(255,255,255,.075);border-bottom-left-radius:5px}
.msg.acao{align-self:flex-start;font-size:11.5px;color:var(--sol);background:rgba(245,181,68,.1);border-radius:999px;padding:3px 10px}
.msg.dica{align-self:center;color:var(--bruma);background:transparent;font-size:13px;text-align:center;max-width:90%}
.pontos{display:inline-flex;gap:4px}.pontos i{width:6px;height:6px;border-radius:50%;background:var(--bruma);animation:pula 1.2s infinite}
.pontos i:nth-child(2){animation-delay:.15s}.pontos i:nth-child(3){animation-delay:.3s}
@keyframes pula{0%,60%,100%{opacity:.3;transform:none}30%{opacity:1;transform:translateY(-3px)}}
.escrever{display:flex;gap:8px;padding:12px;border-top:1px solid var(--linha)}
.escrever textarea{min-height:46px;height:46px;resize:none;border-radius:12px;padding:12px 14px}

/* listas (pausadas e pedidos) */
.item{display:flex;align-items:center;gap:12px;padding:12px 2px;border-top:1px solid var(--linha)}
.item:first-child{border-top:0}
.item .meio{flex:1;min-width:0}
.item .meio b{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item .meio small{display:block;color:var(--bruma);font-size:12px;margin-top:1px}
.item .botoes{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.pedido{padding:12px 2px;border-top:1px solid var(--linha)}
.pedido:first-child{border-top:0}
.pedido .cab{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--bruma)}
.pedido .cab b{color:var(--osso);font-size:13px}
.pedido p{margin:6px 0 0;font-size:13px;line-height:1.45;color:var(--nevoa);white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.pedido .resp{margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(47,191,113,.08);color:#BDF2D4;font-size:12.5px;white-space:pre-wrap}
.pil{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.pil.fila{background:rgba(245,181,68,.14);color:var(--sol)}
.pil.ok{background:rgba(47,191,113,.14);color:var(--carne)}
.pil.reaberto{background:rgba(255,107,61,.14);color:var(--alerta)}
.tipos{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;margin-bottom:14px}
.tipo{display:flex;gap:10px;align-items:center;padding:12px 13px;border-radius:12px;border:1px solid var(--linha2);background:rgba(255,255,255,.03);cursor:pointer;text-align:left;color:var(--osso);font-weight:600;font-size:13px;line-height:1.3;transition:border-color .18s,background .18s}
.tipo:hover{border-color:rgba(76,158,255,.5)}
.tipo[aria-checked="true"]{border-color:var(--vida);background:rgba(76,158,255,.11)}
.tipo i{width:9px;height:9px;border-radius:50%;border:2px solid var(--bruma);flex:none}
.tipo[aria-checked="true"] i{border-color:var(--vida);background:var(--vida);box-shadow:0 0 0 3px rgba(76,158,255,.2)}

/* esqueleto, entrada, aviso flutuante */
.osso{background:linear-gradient(90deg,rgba(255,255,255,.05) 25%,rgba(255,255,255,.1) 37%,rgba(255,255,255,.05) 63%);background-size:400% 100%;animation:brilha 1.5s ease infinite;border-radius:10px}
@keyframes brilha{from{background-position:100% 0}to{background-position:-100% 0}}
.entra{animation:entra .55s cubic-bezier(.16,1,.3,1) both}
@keyframes entra{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));padding:11px 16px;border-radius:12px;background:#0F1B31;border:1px solid var(--linha2);box-shadow:0 18px 40px -12px rgba(0,0,0,.7);font-weight:600;font-size:13.5px;z-index:20;animation:entra .3s cubic-bezier(.16,1,.3,1) both}
.toast.ok{box-shadow:inset 3px 0 0 var(--carne),0 18px 40px -12px rgba(0,0,0,.7)}
.toast.erro{box-shadow:inset 3px 0 0 var(--alerta),0 18px 40px -12px rgba(0,0,0,.7)}
.fim{margin-top:22px;color:#5E7193;font-size:12px;line-height:1.5;text-align:center}
@media (max-width:980px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.duas,.teste{grid-template-columns:1fr}}
@media (max-width:560px){main{padding:16px 16px 40px}.kpis{grid-template-columns:1fr}.lado{grid-template-columns:1fr}.kpi .num{font-size:38px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style></head>
<body><main>
<header class="cartao topo entra">
  <div class="marca">
    <span class="pulso" aria-hidden="true"></span>
    <div><div class="sobre" id="unidadeNome">Carregando…</div><h1 class="display">Sofia <small>a agente de vocês</small></h1></div>
  </div>
  <div class="eu"><select id="unidadeSel" aria-label="Unidade" hidden></select><span id="euNome"></span><span class="av" id="euAv" aria-hidden="true">·</span></div>
</header>

<div id="erroTopo" class="aviso erro" hidden></div>

<div id="corpo" hidden>
<nav class="cartao abas" role="tablist" aria-label="Seções">
  <button class="aba" role="tab" id="aba-inicio" data-aba="inicio" aria-selected="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>Início<span class="conta" id="contaRevisar" hidden></span></button>
  <button class="aba" role="tab" id="aba-ensinar" data-aba="ensinar" aria-selected="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>Ensinar</button>
  <button class="aba" role="tab" id="aba-testar" data-aba="testar" aria-selected="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>Testar</button>
  <button class="aba" role="tab" id="aba-pausadas" data-aba="pausadas" aria-selected="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/></svg>Pausadas<span class="conta azul" id="contaPausadas" hidden></span></button>
  <button class="aba" role="tab" id="aba-pedir" data-aba="pedir" aria-selected="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/></svg>Pedir à Doutor Digital<span class="conta azul" id="contaPedidos" hidden></span></button>
</nav>

<!-- INÍCIO -->
<section id="pane-inicio" role="tabpanel" aria-labelledby="aba-inicio">
  <div class="kpis">
    <div class="cartao kpi viva entra"><span class="num display" id="kBoas">—</span><div class="rot">das respostas avaliadas foram boas, nos últimos 7 dias</div><div class="rod" id="kBoasRod"></div></div>
    <div class="cartao kpi viva entra" style="animation-delay:60ms"><span class="num display" id="kRevisar">—</span><div class="rot">respostas marcadas 👎 esperando alguém olhar</div></div>
    <div class="cartao kpi viva entra" style="animation-delay:120ms"><span class="num display" id="kPausadas">—</span><div class="rot">conversas abertas em que a equipe assumiu (Sofia calada)</div></div>
    <div class="cartao kpi viva entra" style="animation-delay:180ms"><span class="num display" id="kRegras">—</span><div class="rot">regras que vocês ensinaram, ligadas agora</div></div>
  </div>
  <div class="duas">
    <section class="cartao sec entra" style="animation-delay:220ms">
      <h2>Para revisar</h2>
      <p class="sub">Respostas da Sofia que alguém da equipe marcou 👎. Ensine o jeito certo, peça para a gente ajustar ou dê ok.</p>
      <div id="listaRevisar"><div class="osso" style="height:120px"></div></div>
    </section>
    <section class="cartao sec entra" style="animation-delay:280ms">
      <h2>Como cuidar da Sofia</h2>
      <p class="sub">Vocês mesmas deixam a Sofia do jeito da clínica.</p>
      <ol class="passos">
        <li data-ir="inicio"><span class="n">1</span><div><b>Marque 👍 ou 👎 nas respostas dela</b><span>Na conversa, passe o mouse no balão da Sofia. O 👎 aparece aqui em “Para revisar”.</span></div></li>
        <li data-ir="ensinar"><span class="n">2</span><div><b>Ensine o que fazer diferente</b><span>Escreva a regra, veja a Sofia antes e depois, e salve. Vale na hora.</span></div></li>
        <li data-ir="testar"><span class="n">3</span><div><b>Teste como se fosse paciente</b><span>Converse com ela aqui. Nada vai para paciente.</span></div></li>
        <li data-ir="pedir"><span class="n">4</span><div><b>O resto, peça para a gente</b><span>Valor, horários, médicos, informação da clínica ou um erro: a Doutor Digital ajusta.</span></div></li>
      </ol>
    </section>
  </div>
</section>

<!-- ENSINAR -->
<section id="pane-ensinar" role="tabpanel" aria-labelledby="aba-ensinar" hidden>
  <div class="duas">
    <div>
      <section class="cartao sec">
        <h2>Ensinar a Sofia</h2>
        <p class="sub" id="ensinarSub">Uma regra por vez, curta e direta. Antes de salvar, você vê como ela responde hoje e como vai responder com a regra.</p>
        <label class="rot" for="regra">O que a Sofia deve fazer diferente? <span id="cnt">0/400</span></label>
        <textarea id="regra" maxlength="800" placeholder="Ex.: Quando o paciente perguntar o valor, diga o valor da consulta antes de perguntar sobre a dor."></textarea>
        <p class="nota" style="margin:12px 0 0">Ideias para começar:</p>
        <div class="chips" id="ideias" aria-label="Ideias de regra" style="margin-top:6px"></div>
        <details class="falas"><summary>Falas de paciente usadas no teste (pode trocar)</summary>
          <input id="f0" maxlength="500" aria-label="Fala 1"><input id="f1" maxlength="500" aria-label="Fala 2"><input id="f2" maxlength="500" aria-label="Fala 3">
        </details>
        <div class="rodape-form"><span class="nota" id="previasNota"></span><button class="bt primario grande" id="btPrevia" type="button">Testar antes de salvar</button></div>
        <div id="avisoPrevia" class="aviso erro" hidden></div>
      </section>
      <section class="cartao sec" id="cardPrevia" hidden style="margin-top:14px">
        <h2>Como a Sofia responde</h2>
        <p class="sub">Nada foi salvo ainda. Gostou da coluna verde? Salve.</p>
        <div id="previa"></div>
        <div class="rodape-form"><button class="bt fantasma" id="btAjustar" type="button">Ajustar o texto</button><button class="bt verde grande" id="btSalvar" type="button">Salvar regra</button></div>
        <div id="avisoSalvar" class="aviso erro" hidden></div>
      </section>
    </div>
    <section class="cartao sec">
      <h2>Regras de vocês</h2>
      <p class="sub">A Sofia segue as ligadas em toda conversa desta unidade. Desligue a que não vale mais.</p>
      <div id="listaRegras"><div class="osso" style="height:80px"></div></div>
      <details class="equipe" id="equipe" hidden><summary id="equipeResumo"></summary>
        <p class="nota" style="margin:8px 0 0">Quem cuida destas é a equipe da Doutor Digital. Se alguma estiver atrapalhando, peça para a gente.</p>
        <ul id="listaEquipe"></ul>
      </details>
    </section>
  </div>
</section>

<!-- TESTAR -->
<section id="pane-testar" role="tabpanel" aria-labelledby="aba-testar" hidden>
  <div class="teste">
    <section class="cartao">
      <div class="chat-topo"><div><b>Conversa de teste com a Sofia</b><span>Escreva como se fosse o paciente</span></div><span class="selo">nada vai para paciente</span></div>
      <div class="chat" id="chat" aria-live="polite"></div>
      <div class="escrever"><textarea id="fala" maxlength="600" aria-label="Fala do paciente" placeholder="Escreva como o paciente… (Ctrl+Enter envia)"></textarea><button class="bt primario" id="btEnviar" type="button">Enviar</button></div>
    </section>
    <section class="cartao sec">
      <h2>Experimente perguntar</h2>
      <p class="sub">Toque numa fala para usar.</p>
      <div class="chips" id="sugestoes" style="margin-top:0"></div>
      <p class="nota" id="restam" style="margin:14px 0 0"></p>
      <div class="acoes"><button class="bt" id="btRegraDaqui" type="button">A Sofia errou aqui? Ensinar</button><button class="bt fantasma" id="btRecomecar" type="button">Recomeçar</button></div>
      <div id="avisoChat" class="aviso erro" hidden></div>
      <p class="nota" style="margin-top:14px">Agenda e Pix aqui são de mentira: nada vai para a franquia, o Kommo ou o WhatsApp. A conversa fica só neste computador.</p>
    </section>
  </div>
</section>

<!-- PAUSADAS -->
<section id="pane-pausadas" role="tabpanel" aria-labelledby="aba-pausadas" hidden>
  <section class="cartao sec">
    <h2>Conversas com a Sofia pausada</h2>
    <p class="sub">A Sofia sai da frente sozinha quando alguém da equipe responde (pelo Chatwoot ou pelo celular) e volta quando a conversa é resolvida. Aqui você devolve a conversa para ela antes, se quiser.</p>
    <div id="listaPausadas"><div class="osso" style="height:80px"></div></div>
  </section>
</section>

<!-- PEDIR -->
<section id="pane-pedir" role="tabpanel" aria-labelledby="aba-pedir" hidden>
  <div class="duas">
    <section class="cartao sec">
      <h2>Pedir à Doutor Digital</h2>
      <p class="sub">O que não dá para mudar por aqui — valor, horários, médicos, informação da clínica ou um erro da Sofia — a nossa equipe ajusta. A gente recebe na hora e a resposta aparece ao lado.</p>
      <div class="tipos" id="tipos" role="radiogroup" aria-label="Tipo do pedido"></div>
      <label class="rot" for="pedidoTexto">Explique o que precisa <span id="cntPedido">0/1500</span></label>
      <textarea id="pedidoTexto" maxlength="1500" placeholder="Ex.: A partir de 1º de dezembro a consulta passa a custar R$ 380 (com sinal, R$ 280)."></textarea>
      <div class="rodape-form"><span class="nota">Quem pede: <b id="pedidoQuem"></b></span><button class="bt primario grande" id="btPedir" type="button">Enviar pedido</button></div>
      <div id="avisoPedido" class="aviso erro" hidden></div>
    </section>
    <section class="cartao sec">
      <h2>Pedidos da unidade</h2>
      <p class="sub">Dos últimos 60 dias.</p>
      <div id="listaPedidos"><div class="osso" style="height:80px"></div></div>
    </section>
  </div>
</section>

<p class="fim" id="fim">Tudo aqui vale só para a unidade escolhida. A equipe da Doutor Digital é avisada de cada regra nova e de cada pedido.</p>
</div>
</main>
<div id="toast" class="toast" role="status" hidden></div>
<script>
(function(){
  var CW = __ORIGEM_CW__, S = null, U = null, EU = '', UNIDADES = [];
  var $ = function(id){ return document.getElementById(id); };
  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function guardar(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function lerGuardado(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }

  // ── aviso flutuante ──
  var tToast = null;
  function toast(txt, ok){ var t = $('toast'); t.textContent = txt; t.className = 'toast ' + (ok === false ? 'erro' : 'ok'); t.hidden = false; clearTimeout(tToast); tToast = setTimeout(function(){ t.hidden = true; }, 4200); }
  function aviso(id, txt){ var a = $(id); a.textContent = txt; a.hidden = false; }
  function some(id){ $(id).hidden = true; }

  // ── servidor (com o login do Chatwoot de quem está usando) ──
  function cab(){ var h = { 'Content-Type': 'application/json' }; if (S) { h['X-CW-Token'] = S.token; h['X-CW-Client'] = S.client; h['X-CW-Uid'] = S.uid; } return h; }
  async function api(method, path, body){
    var r = await fetch(path, { method: method, headers: cab(), body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { var er = new Error(j.error || ('erro ' + r.status)); er.dados = j; er.status = r.status; if (r.status === 401) { S = null; pedirSessao(); } throw er; }
    return j;
  }
  function apiUnidade(){ return '/api/public/aprendizados/' + encodeURIComponent(U.slug); }

  // ── datas ──
  function ha(iso){
    var d = new Date(iso), s = (Date.now() - d.getTime()) / 1000; if (isNaN(s)) return '';
    if (s < 60) return 'agora'; if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min'; if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
    var dias = Math.floor(s / 86400); if (dias === 1) return 'ontem'; if (dias < 7) return 'há ' + dias + ' dias';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }
  function iniciais(nome){ var p = String(nome || '').trim().split(/\s+/); return ((p[0] || '·')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }

  // ── abas ──
  var ABAS = ['inicio', 'ensinar', 'testar', 'pausadas', 'pedir'], abaAtual = 'inicio';
  function ir(qual){
    if (ABAS.indexOf(qual) < 0 || $('aba-' + qual).hidden) qual = 'inicio';
    abaAtual = qual;
    ABAS.forEach(function(a){ $('pane-' + a).hidden = a !== qual; $('aba-' + a).setAttribute('aria-selected', a === qual ? 'true' : 'false'); });
    guardar('agente:aba', qual);
    if (qual === 'inicio') carregarInicio();
    if (qual === 'ensinar') carregarRegras();
    if (qual === 'testar') { desenharChat(false); setTimeout(function(){ $('fala').focus(); }, 50); }
    if (qual === 'pausadas') carregarPausadas();
    if (qual === 'pedir') carregarPedidos();
    window.scrollTo(0, 0);
  }
  ABAS.forEach(function(a){ $('aba-' + a).addEventListener('click', function(){ ir(a); }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-ir]'), function(li){ li.addEventListener('click', function(){ ir(li.getAttribute('data-ir')); }); });

  // ── estado da unidade (regras, prévias, conversa de teste) ──
  var EST = null, MAX = 400, falasPadrao = [];
  async function lerEstado(){
    EST = await api('GET', apiUnidade());
    MAX = EST.maxCaracteres || 400; falasPadrao = EST.falasDeExemplo || [];
    ['f0', 'f1', 'f2'].forEach(function(id, i){ if (!$(id).value) $(id).value = falasPadrao[i] || ''; });
    var minhas = EST.regras.filter(function(r){ return r.daUnidade && r.enabled; }).length;
    $('kRegras').textContent = String(minhas);
    var conv = EST.conversa || {};
    $('aba-testar').hidden = conv.maximo === 0;
    $('previasNota').textContent = EST.previasRestantes != null ? ('Restam ' + EST.previasRestantes + ' testes de regra hoje.') : '';
    contar();
    return EST;
  }

  // ── INÍCIO ──
  var revisando = null; // a 👎 que virou regra/pedido: marcada como revisada quando a regra é salva ou o pedido sai
  async function carregarInicio(){
    lerEstado().catch(function(){});
    contarPausadas();
    var box = $('listaRevisar');
    try {
      var r = await api('GET', '/api/public/agente/avaliacoes?slug=' + encodeURIComponent(U.slug));
      var tot = r.semana.boas + r.semana.ruins, ant = r.anterior.boas + r.anterior.ruins;
      if (tot > 0) {
        var pct = Math.round(100 * r.semana.boas / tot);
        $('kBoas').textContent = pct + '%'; $('kBoas').className = 'num display ' + (pct >= 80 ? 'bom' : pct >= 60 ? '' : 'ruim');
        var rod = tot + (tot === 1 ? ' avaliação' : ' avaliações');
        if (ant > 0) { var d = pct - Math.round(100 * r.anterior.boas / ant); rod += d === 0 ? ' · igual à semana passada' : (' · ' + (d > 0 ? '▲ ' : '▼ ') + Math.abs(d) + ' pts vs. semana passada'); }
        var antes = ant > 0 ? Math.round(100 * r.anterior.boas / ant) : null;
        $('kBoasRod').textContent = rod; $('kBoasRod').className = 'rod ' + (antes == null || antes === pct ? 'calmo' : pct > antes ? 'bom' : 'ruim');
      } else { $('kBoas').textContent = '—'; $('kBoas').className = 'num display calmo'; $('kBoasRod').textContent = 'ninguém avaliou nesta semana'; $('kBoasRod').className = 'rod calmo'; }
      var n = r.paraRevisar.length;
      $('kRevisar').textContent = String(n); $('kRevisar').className = 'num display ' + (n ? 'ruim' : 'bom');
      var c = $('contaRevisar'); c.textContent = String(n); c.hidden = !n;
      box.textContent = '';
      if (!n) {
        var v = el('div', 'vazio'); v.appendChild(el('b', null, 'Nada para revisar. '));
        v.appendChild(document.createTextNode('Quando uma resposta da Sofia não ficar boa, passe o mouse no balão dela dentro da conversa e clique 👎 — ela aparece aqui.'));
        box.appendChild(v); return;
      }
      r.paraRevisar.forEach(function(a){ box.appendChild(cartaoDoCaso(a)); });
    } catch (e) { box.textContent = ''; box.appendChild(el('div', 'aviso erro', e.message)); }
  }
  function cartaoDoCaso(a){
    var c = el('article', 'caso');
    var t = el('div', 'caso-topo'), quem = el('span'); quem.appendChild(document.createTextNode('👎 ')); quem.appendChild(el('b', null, a.quemNome));
    t.appendChild(quem); t.appendChild(el('span', null, ha(a.criadoEm))); c.appendChild(t);
    if (a.fala) { var p = el('div', 'bolha pac'); p.appendChild(el('small', null, 'Paciente')); p.appendChild(document.createTextNode(a.fala)); c.appendChild(p); }
    if (a.resposta) { var s = el('div', 'bolha sofia'); s.appendChild(el('small', null, 'Sofia')); s.appendChild(document.createTextNode(a.resposta)); c.appendChild(s); }
    if (a.texto) { var e = el('p', 'errado'); e.appendChild(el('b', null, 'O que estava errado: ')); e.appendChild(document.createTextNode(a.texto)); c.appendChild(e); }
    var ac = el('div', 'acoes');
    var b1 = el('button', 'bt primario', 'Ensinar a Sofia'); b1.type = 'button';
    b1.onclick = function(){ revisando = a.id; $('regra').value = (a.texto || '').slice(0, MAX); if (a.fala) $('f0').value = a.fala.slice(0, 500); ir('ensinar'); contar(); $('regra').focus(); };
    var b2 = el('button', 'bt', 'Pedir à Doutor Digital'); b2.type = 'button';
    b2.onclick = function(){
      revisando = a.id; escolherTipo('erro');
      var txt = (a.fala ? 'O paciente disse: “' + a.fala.slice(0, 300) + '”\n' : '') + (a.resposta ? 'A Sofia respondeu: “' + a.resposta.slice(0, 500) + '”\n' : '') + (a.texto ? 'O que estava errado: ' + a.texto : '');
      $('pedidoTexto').value = txt.slice(0, 1500); pedidoConversa = a.conversa; ir('pedir'); contarPedido(); $('pedidoTexto').focus();
    };
    var b3 = el('button', 'bt', 'Abrir conversa'); b3.type = 'button'; b3.onclick = function(){ abrirConversa(a.conversa); };
    var b4 = el('button', 'bt fantasma', 'Já resolvido'); b4.type = 'button';
    b4.onclick = async function(){ b4.disabled = true; try { await revisar(a.id, 'ok'); c.remove(); carregarInicio(); toast('Marcado como resolvido.'); } catch (er) { b4.disabled = false; toast(er.message, false); } };
    ac.appendChild(b1); ac.appendChild(b2); ac.appendChild(b3); ac.appendChild(b4); c.appendChild(ac);
    return c;
  }
  function revisar(id, como){ return api('POST', '/api/public/agente/avaliacoes/' + encodeURIComponent(id) + '/revisar', { slug: U.slug, como: como }); }
  function abrirConversa(id){ try { window.parent.postMessage({ event: 'funil:abrir-conversa', id: id }, CW); } catch (e) {} }

  // ── ENSINAR ──
  var IDEIAS = [
    'Quando o paciente perguntar o valor, diga o valor da consulta antes de perguntar sobre a dor.',
    'Se o paciente disser que vai pensar ou falar com a família, ofereça mandar o endereço e o valor por escrito.',
    'Quando o paciente mandar exame, agradeça e diga que o doutor vai olhar na consulta.'
  ];
  IDEIAS.forEach(function(t){ var b = el('button', 'chip', t); b.type = 'button'; b.onclick = function(){ $('regra').value = t; contar(); $('regra').focus(); }; $('ideias').appendChild(b); });
  var previaDe = null;
  function contar(){
    var n = $('regra').value.trim().length; $('cnt').textContent = n + '/' + MAX; $('cnt').className = n > MAX ? 'ruim' : '';
    if (previaDe !== null && $('regra').value.trim() !== previaDe) { $('cardPrevia').hidden = true; previaDe = null; }
  }
  $('regra').addEventListener('input', contar);
  function primeiraFrase(t){ var m = String(t).match(/^[\s\S]*?[.!?](\s|$)/); return (m ? m[0] : String(t)).trim(); }
  async function carregarRegras(){
    var l = $('listaRegras');
    try { await lerEstado(); } catch (e) { l.textContent = ''; l.appendChild(el('div', 'aviso erro', e.message)); return; }
    l.textContent = '';
    var minhas = EST.regras.filter(function(r){ return r.daUnidade; });
    if (!minhas.length) l.appendChild(el('div', 'vazio', 'Nenhuma regra de vocês ainda. A primeira que você salvar aparece aqui.'));
    minhas.forEach(function(r){
      var row = el('div', 'regra' + (r.enabled ? '' : ' off'));
      var sw = el('button', 'sw'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', r.enabled ? 'true' : 'false'); sw.setAttribute('aria-label', r.enabled ? 'Desligar regra' : 'Ligar regra');
      sw.onclick = async function(){ sw.disabled = true; try { await api('POST', apiUnidade() + '/regra/' + encodeURIComponent(r.id), { enabled: !r.enabled }); toast(r.enabled ? 'Regra desligada.' : 'Regra ligada.'); carregarRegras(); } catch (e) { sw.disabled = false; toast(e.message, false); } };
      var p = el('p', null, r.content); p.appendChild(el('small', null, (r.enabled ? 'ligada' : 'desligada') + ' · ' + ha(r.createdAt)));
      row.appendChild(sw); row.appendChild(p); l.appendChild(row);
    });
    // as da Doutor Digital (painel e reflexão semanal): só leitura, sem repetição
    var vistas = {}, unicas = [];
    EST.regras.filter(function(r){ return !r.daUnidade && r.enabled; }).forEach(function(r){ var k = primeiraFrase(r.content).toLowerCase(); if (vistas[k]) { vistas[k].n++; return; } vistas[k] = { t: primeiraFrase(r.content), n: 1 }; unicas.push(vistas[k]); });
    $('equipe').hidden = !unicas.length;
    $('equipeResumo').textContent = 'A Doutor Digital também ensinou ' + unicas.length + (unicas.length === 1 ? ' coisa' : ' coisas') + ' à Sofia';
    var ul = $('listaEquipe'); ul.textContent = '';
    unicas.forEach(function(u){ var li = el('li', null, u.t); if (u.n > 1) li.appendChild(el('span', null, ' ×' + u.n)); ul.appendChild(li); });
  }
  $('btPrevia').addEventListener('click', async function(){
    var b = this, regra = $('regra').value.trim(); some('avisoPrevia');
    if (regra.length < 10) { aviso('avisoPrevia', 'Escreva a regra primeiro (uma frase).'); $('regra').focus(); return; }
    if (regra.length > MAX) { aviso('avisoPrevia', 'A regra passou de ' + MAX + ' letras. Resuma um pouco.'); return; }
    b.disabled = true; var txt = b.textContent; b.textContent = 'A Sofia está respondendo… (até 1 min)';
    try {
      var falas = ['f0', 'f1', 'f2'].map(function(id){ return $(id).value.trim(); }).filter(Boolean);
      var r = await api('POST', apiUnidade() + '/previa', { regra: regra, falas: falas });
      var box = $('previa'); box.textContent = '';
      r.resultados.forEach(function(x){
        var d = el('div', 'previa-item'), p = el('div', 'bolha pac'); p.appendChild(el('small', null, 'Paciente')); p.appendChild(document.createTextNode(x.fala)); d.appendChild(p);
        var lado = el('div', 'lado'), a = el('div', 'bolha sofia'), n = el('div', 'bolha nova');
        a.appendChild(el('small', null, 'Hoje ela responde')); a.appendChild(document.createTextNode(x.antes));
        n.appendChild(el('small', null, 'Com a regra nova')); n.appendChild(document.createTextNode(x.depois));
        lado.appendChild(a); lado.appendChild(n); d.appendChild(lado); box.appendChild(d);
      });
      previaDe = regra; $('cardPrevia').hidden = false; some('avisoSalvar'); $('btSalvar').disabled = false;
      $('previasNota').textContent = 'Restam ' + r.previasRestantes + ' testes de regra hoje.';
      $('cardPrevia').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { aviso('avisoPrevia', e.message); }
    finally { b.disabled = false; b.textContent = txt; }
  });
  $('btAjustar').addEventListener('click', function(){ $('regra').focus(); $('regra').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('btSalvar').addEventListener('click', async function(){
    var b = this; some('avisoSalvar');
    if (previaDe === null || $('regra').value.trim() !== previaDe) { aviso('avisoSalvar', 'O texto mudou: teste de novo antes de salvar.'); return; }
    b.disabled = true;
    try {
      await api('POST', apiUnidade(), { regra: previaDe });
      if (revisando) { await revisar(revisando, 'regra').catch(function(){}); revisando = null; }
      $('regra').value = ''; previaDe = null; $('cardPrevia').hidden = true; contar();
      toast('Pronto! A Sofia já segue essa regra nas próximas conversas.');
      carregarRegras();
    } catch (e) { aviso('avisoSalvar', e.message); b.disabled = false; }
  });

  // ── TESTAR (o histórico fica neste navegador) ──
  var SUGESTOES = ['Oi, quanto custa a consulta?', 'Tenho hérnia de disco, tem cura?', 'Vocês atendem por convênio?', 'Qual o endereço da clínica?', 'Tem horário amanhã de manhã?', 'Vou pensar e te aviso'];
  SUGESTOES.forEach(function(t){ var b = el('button', 'chip', t); b.type = 'button'; b.onclick = function(){ $('fala').value = t; $('fala').focus(); }; $('sugestoes').appendChild(b); });
  var historico = [], aguardando = false, restam = null;
  function chaveChat(){ return 'agente:conversa:' + (U ? U.slug : ''); }
  function lerChat(){ try { var h = JSON.parse(lerGuardado(chaveChat()) || '[]'); historico = Array.isArray(h) ? h.filter(function(m){ return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; }).slice(-40) : []; } catch (e) { historico = []; } }
  function salvarChat(){ historico = historico.slice(-40); while (historico.length && historico[0].role !== 'user') historico.shift(); guardar(chaveChat(), JSON.stringify(historico)); }
  function desenharChat(digitando){
    var c = $('chat'); c.textContent = '';
    if (!historico.length && !digitando) c.appendChild(el('div', 'msg dica', 'Escreva uma fala de paciente — por exemplo, “Oi, quanto custa a consulta?” — e veja o que a Sofia responde.'));
    historico.forEach(function(m){ c.appendChild(el('div', 'msg ' + (m.role === 'user' ? 'pac' : 'sofia'), m.content)); (m.a || []).forEach(function(t){ c.appendChild(el('div', 'msg acao', 'no teste: ' + t)); }); });
    if (digitando) { var d = el('div', 'msg sofia'), p = el('span', 'pontos'); p.appendChild(el('i')); p.appendChild(el('i')); p.appendChild(el('i')); d.appendChild(p); d.setAttribute('aria-label', 'A Sofia está escrevendo'); c.appendChild(d); }
    c.scrollTop = c.scrollHeight;
    $('restam').textContent = restam != null ? ('Restam ' + restam + ' respostas de teste hoje.') : '';
    $('btEnviar').disabled = aguardando || restam === 0;
  }
  function paraEnviar(){
    var l = historico.map(function(m){ return { role: m.role, content: m.role === 'assistant' ? m.content.slice(0, 1500) : m.content }; });
    var tot = 0; l.forEach(function(m){ tot += m.content.length; });
    while (l.length > 1 && tot > 14000) tot -= l.shift().content.length;
    return l;
  }
  async function enviar(){
    var t = $('fala').value.trim(); some('avisoChat');
    if (aguardando || !t) return;
    aguardando = true; historico.push({ role: 'user', content: t }); $('fala').value = ''; desenharChat(true);
    try {
      var r = await api('POST', apiUnidade() + '/conversa', { messages: paraEnviar() });
      historico.push({ role: 'assistant', content: r.reply, a: r.acoes || [] }); restam = r.restantes;
    } catch (e) {
      historico.pop(); $('fala').value = t; aviso('avisoChat', e.message);
      if (e.dados && e.dados.restantes != null) restam = e.dados.restantes;
    }
    aguardando = false; salvarChat(); desenharChat(false);
  }
  $('btEnviar').addEventListener('click', enviar);
  $('fala').addEventListener('keydown', function(ev){ if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); enviar(); } });
  $('btRecomecar').addEventListener('click', function(){ if (aguardando) return; historico = []; salvarChat(); some('avisoChat'); desenharChat(false); });
  $('btRegraDaqui').addEventListener('click', function(){
    var ult = ''; for (var i = historico.length - 1; i >= 0; i--) { if (historico[i].role === 'user') { ult = historico[i].content; break; } }
    if (!ult) { aviso('avisoChat', 'Converse primeiro: a regra parte de uma fala do paciente.'); return; }
    var fala = ult.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    $('regra').value = ('Quando o paciente disser algo como “' + fala.slice(0, 120) + '”, a Sofia deve ').slice(0, MAX);
    $('f0').value = fala.slice(0, 500); ir('ensinar'); contar(); var r = $('regra'); r.focus(); r.setSelectionRange(r.value.length, r.value.length);
  });

  // ── PAUSADAS ──
  async function contarPausadas(){
    try { var r = await api('GET', '/api/public/testar-ia/pausadas'); mostrarContaPausadas(r.conversas.length); return r; } catch (e) { return null; }
  }
  function mostrarContaPausadas(n){ $('kPausadas').textContent = String(n); var c = $('contaPausadas'); c.textContent = String(n); c.hidden = !n; }
  async function carregarPausadas(){
    var l = $('listaPausadas');
    try {
      var r = await api('GET', '/api/public/testar-ia/pausadas'); mostrarContaPausadas(r.conversas.length); l.textContent = '';
      if (!r.conversas.length) { l.appendChild(el('div', 'vazio', 'Nenhuma conversa com a Sofia pausada agora.')); return; }
      r.conversas.forEach(function(c){
        var row = el('div', 'item'), av = el('span', 'av', iniciais(c.nome)), meio = el('div', 'meio');
        meio.appendChild(el('b', null, c.nome));
        meio.appendChild(el('small', null, 'Pausada' + (c.por ? ' por ' + c.por : '') + (c.em ? ' · ' + ha(c.em) : '') + (c.atendente ? ' · com ' + c.atendente : '')));
        var bs = el('div', 'botoes'), ab = el('button', 'bt', 'Abrir conversa'), re = el('button', 'bt primario', 'Devolver para a Sofia');
        ab.type = re.type = 'button'; ab.onclick = function(){ abrirConversa(c.id); };
        re.onclick = async function(){ re.disabled = true; try { await api('POST', '/api/public/assistente/pausa', { conversa: c.id, acao: 'reativar' }); row.remove(); toast('A Sofia voltou a responder nesta conversa.'); carregarPausadas(); } catch (e) { re.disabled = false; toast(e.message, false); } };
        bs.appendChild(ab); bs.appendChild(re); row.appendChild(av); row.appendChild(meio); row.appendChild(bs); l.appendChild(row);
      });
    } catch (e) { l.textContent = ''; l.appendChild(el('div', 'aviso erro', e.message)); }
  }

  // ── PEDIR ──
  var tipoPedido = null, pedidoConversa = null, TIPOS = [];
  function escolherTipo(id){ tipoPedido = id; Array.prototype.forEach.call(document.querySelectorAll('.tipo'), function(b){ b.setAttribute('aria-checked', b.getAttribute('data-tipo') === id ? 'true' : 'false'); }); }
  function contarPedido(){ $('cntPedido').textContent = $('pedidoTexto').value.trim().length + '/1500'; }
  $('pedidoTexto').addEventListener('input', contarPedido);
  function desenharTipos(){
    var box = $('tipos'); if (box.children.length || !TIPOS.length) return;
    TIPOS.forEach(function(t){ var b = el('button', 'tipo'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false'); b.setAttribute('data-tipo', t.id); b.appendChild(el('i')); b.appendChild(document.createTextNode(t.rotulo)); b.onclick = function(){ escolherTipo(t.id); }; box.appendChild(b); });
    if (tipoPedido) escolherTipo(tipoPedido);
  }
  var SITUACAO = { 'na-fila': ['fila', 'Na fila'], resolvido: ['ok', 'Resolvido'], reaberto: ['reaberto', 'Reaberto'] };
  function desenharPedidos(lista){
    var l = $('listaPedidos'); l.textContent = '';
    var abertos = lista.filter(function(p){ return p.situacao !== 'resolvido'; }).length, c = $('contaPedidos'); c.textContent = String(abertos); c.hidden = !abertos;
    if (!lista.length) { l.appendChild(el('div', 'vazio', 'Nenhum pedido ainda. O que vocês pedirem aparece aqui, com a resposta da equipe.')); return; }
    lista.forEach(function(p){
      var d = el('div', 'pedido'), cab = el('div', 'cab'), s = SITUACAO[p.situacao] || SITUACAO['na-fila'];
      cab.appendChild(el('b', null, '#' + p.protocolo)); cab.appendChild(el('span', 'pil ' + s[0], s[1])); cab.appendChild(el('span', null, p.tipo + ' · ' + (p.nome || '') + ' · ' + ha(p.criadoEm)));
      d.appendChild(cab); d.appendChild(el('p', null, p.texto));
      if (p.resposta) d.appendChild(el('div', 'resp', 'Resposta da Doutor Digital: ' + p.resposta));
      l.appendChild(d);
    });
  }
  async function carregarPedidos(){
    try { var r = await api('GET', '/api/public/agente/pedidos?slug=' + encodeURIComponent(U.slug)); TIPOS = r.tipos || []; desenharTipos(); desenharPedidos(r.pedidos || []); }
    catch (e) { var l = $('listaPedidos'); l.textContent = ''; l.appendChild(el('div', 'aviso erro', e.message)); }
  }
  $('btPedir').addEventListener('click', async function(){
    var b = this, texto = $('pedidoTexto').value.trim(); some('avisoPedido');
    if (!tipoPedido) { aviso('avisoPedido', 'Escolha o tipo do pedido.'); return; }
    if (texto.length < 10) { aviso('avisoPedido', 'Explique o que precisa (pelo menos uma frase).'); $('pedidoTexto').focus(); return; }
    b.disabled = true;
    try {
      var r = await api('POST', '/api/public/agente/pedidos', { slug: U.slug, tipo: tipoPedido, texto: texto, conversa: pedidoConversa });
      if (revisando) { await revisar(revisando, 'pedido').catch(function(){}); revisando = null; }
      $('pedidoTexto').value = ''; pedidoConversa = null; contarPedido(); desenharPedidos(r.pedidos || []);
      toast('Pedido #' + r.protocolo + ' enviado. A equipe da Doutor Digital já foi avisada.');
    } catch (e) { aviso('avisoPedido', e.message); }
    b.disabled = false;
  });

  // ── entrada: sessão do Chatwoot pelo menu, unidade pelas caixas da pessoa ──
  function pedirSessao(){ try { window.parent.postMessage({ event: 'funil:pede-sessao' }, CW); } catch (e) {} }
  function escolherUnidade(u){
    U = u; guardar('agente:unidade', u.slug); $('unidadeNome').textContent = u.nome;
    EST = null; previaDe = null; $('cardPrevia').hidden = true; lerChat(); restam = null;
    lerEstado().then(function(){ restam = EST && EST.conversa ? EST.conversa.restantes : null; if (abaAtual === 'testar') desenharChat(false); }).catch(function(e){ aviso('erroTopo', e.message); });
  }
  async function entrar(){
    try {
      var r = await api('GET', '/api/public/testar-ia/unidades');
      UNIDADES = r.unidades || []; EU = r.eu || '';
      $('euNome').textContent = EU; $('euAv').textContent = iniciais(EU); $('pedidoQuem').textContent = EU || 'você';
      if (!UNIDADES.length) { aviso('erroTopo', 'Você não atende nenhuma caixa com a Sofia. Peça para a Suzanne liberar a caixa da sua unidade.'); $('unidadeNome').textContent = 'Sem unidade'; return; }
      var guardada = lerGuardado('agente:unidade'), u = UNIDADES.filter(function(x){ return x.slug === guardada; })[0] || UNIDADES[0];
      if (UNIDADES.length > 1) {
        var sel = $('unidadeSel'); sel.hidden = false; sel.textContent = '';
        UNIDADES.forEach(function(x){ var o = el('option', null, x.nome); o.value = x.slug; sel.appendChild(o); });
        sel.value = u.slug; sel.onchange = function(){ var x = UNIDADES.filter(function(y){ return y.slug === sel.value; })[0]; if (x) { escolherUnidade(x); ir(abaAtual); } };
      }
      escolherUnidade(u); some('erroTopo'); $('corpo').hidden = false;
      // veio do 👎 do painel da assistente: o texto já vira a regra nova (o teste continua obrigatório antes de salvar)
      var rasc = lerGuardado('testar-ia-rascunho'); guardar('testar-ia-rascunho', null);
      if (rasc) { $('regra').value = rasc.slice(0, 800); ir('ensinar'); contar(); $('regra').focus(); }
      else ir(lerGuardado('agente:aba') || 'inicio');
      // os contadores das abas (para revisar, pausadas, pedidos em aberto) aparecem já na entrada, qualquer que seja a aba
      if (abaAtual !== 'inicio') carregarInicio();
      if (abaAtual !== 'pedir') carregarPedidos();
    } catch (e) { aviso('erroTopo', e.message); }
  }
  window.addEventListener('message', function(ev){
    if (ev.origin !== CW || ev.source !== window.parent) return;
    var d = ev.data; if (!d || d.event !== 'funil-sessao') return;
    var novo = d.sessao && d.sessao.token ? d.sessao : null, primeira = !S && novo && !U; S = novo;
    if (primeira) entrar();
  });
  window.addEventListener('storage', function(ev){
    if (ev.key !== 'testar-ia-rascunho' || !ev.newValue || !U) return;
    guardar('testar-ia-rascunho', null); $('regra').value = ev.newValue.slice(0, 800); ir('ensinar'); contar(); $('regra').focus();
  });
  pedirSessao(); setTimeout(function(){ if (!S) pedirSessao(); }, 1500);
  setTimeout(function(){ if (!S) aviso('erroTopo', 'Abra esta tela pelo menu do Chatwoot (Agente), já logada.'); }, 6000);
})();
</script></body></html>`;

/** A página. `origemChatwoot` = a origem do Chatwoot (só ela fala com a página por postMessage). */
export function paginaDoAgente(origemChatwoot: string): string {
  return PAGINA.split('__ORIGEM_CW__').join(JSON.stringify(origemChatwoot));
}
