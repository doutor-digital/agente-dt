/**
 * A tela "Agente" do menu do Chatwoot (pedido do João, 13/11/2026): a equipe da clínica cuida da própria Sofia sem depender da
 * Doutor Digital — e o que precisa de código vira pedido para a gente.
 *
 *   Painel    → quantas pessoas a Sofia respondeu, quantas consultas marcou, conversão, quantas passou para a equipe, Pix, à noite
 *               e no fim de semana, avaliações; por dia; as consultas que ela marcou; as respostas marcadas como ruins
 *   Ensinar   → escrever o que ela deve fazer diferente, testar (hoje × com a regra) e salvar; ligar/desligar as regras da unidade
 *   Testar    → conversar com a Sofia como se fosse o paciente (nada vai a paciente)
 *   Pausadas  → conversas em que a equipe assumiu; devolver para a Sofia
 *   Pedir     → pedido à Doutor Digital (valor, horário, erro…): vira demanda no painel do suporte e avisa o bot de chamados
 *
 * Desenho: o MESMO das telas Oportunidades/Marketing/Gestor (`chatwoot-telas-ui.ts`), que o João aprovou depois de reclamar de «cara
 * de IA»: cores, bordas e fonte do próprio Chatwoot (escala slate, azul #2781f6 como única cor de destaque; verde/vermelho só para
 * bom/ruim), números numa faixa com divisórias finas e a variação contra o período anterior, abas sublinhadas, listas densas, um
 * gráfico só, sem sombra, sem gradiente, sem emoji nos controles. A definição de cada número fica no `title` do rótulo e em «Como
 * cada número é contado», nunca embaixo do número.
 *
 * A sessão chega do menu do Chatwoot por postMessage (`funil:pede-sessao` → `funil-sessao`, com checagem de origem). Todo texto que
 * vem do servidor entra por textContent (nunca innerHTML). O JavaScript não usa crase nem `${`: o texto é um String.raw e só
 * `__ORIGEM_CW__` é trocado.
 */

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agente · Sofia</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--txt:#1c2024;--sec:#60646c;--mut:#8b8d98;--b:#e8e8ec;--b2:#d9d9e0;--suave:#f9f9fb;--azul:#2781f6;--azul-txt:#086de0;--azul-claro:#cfe3fd;--bom:#218358;--ruim:#ca244d;--amarelo:#c77700}
*{box-sizing:border-box}html,body{margin:0}
body{background:#fff;color:var(--txt);font:14px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
button,select,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--azul);outline-offset:2px}
main{max-width:1120px;margin:0 auto;padding:20px 24px 56px}
h1{margin:0;font-size:16px;font-weight:600}
h3{margin:0 0 4px;font-size:14px;font-weight:600;display:flex;align-items:baseline;gap:8px}
h3 .c{color:var(--mut);font-weight:500;font-variant-numeric:tabular-nums}
.meta{color:var(--sec);font-size:13px}
.mut{color:var(--mut)}
.cab{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;margin-bottom:12px}
.cab .eu{display:flex;align-items:center;gap:10px;color:var(--sec);font-size:13px}
.topo{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px 16px;border-bottom:1px solid var(--b)}
.abas{display:flex;gap:4px;flex-wrap:wrap}
.abas button{position:relative;min-height:40px;padding:0 12px;border:0;background:transparent;color:var(--sec);font-weight:500;font-size:14px;cursor:pointer;border-radius:6px 6px 0 0}
.abas button:hover{color:var(--txt)}
.abas button[aria-selected=true]{color:var(--azul-txt);font-weight:600}
.abas button[aria-selected=true]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--azul);border-radius:2px}
.abas .c{margin-left:6px;color:var(--mut);font-weight:500;font-variant-numeric:tabular-nums}
.abas button[aria-selected=true] .c{color:var(--azul-txt)}
.lado{display:flex;align-items:center;gap:10px;padding-bottom:6px}
.sel{min-height:32px;padding:0 8px;border:1px solid var(--b2);border-radius:6px;background:#fff;font-size:13px;cursor:pointer}
.bt{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border-radius:6px;border:1px solid var(--b2);background:#fff;color:var(--txt);font-weight:500;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}
.bt:hover{background:var(--suave);border-color:#cdced6}
.bt.pri{background:var(--azul);border-color:var(--azul);color:#fff}
.bt.pri:hover{background:#1073e9}
.bt.link{border-color:transparent;background:transparent;color:var(--azul-txt);padding:0 6px}
.bt.link:hover{background:#f5f9ff}
.bt.leve{border-color:transparent;background:transparent;color:var(--sec)}
.bt.leve:hover{background:var(--suave);color:var(--txt)}
.bt:disabled{opacity:.5;cursor:default}
.pane{padding-top:20px}
.pane>*+*{margin-top:28px}
.aviso{padding:9px 12px;border:1px solid #f0e2b6;border-radius:8px;background:#fffbeb;color:#6b4e00;font-size:13px;white-space:pre-wrap}
.aviso.erro{border-color:#f4d0d8;background:#fff5f7;color:#8f1d3a}
.vinculo{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;padding:7px 10px;border:1px solid #d5e2fb;border-radius:6px;background:#f5f9ff;color:#1d3f87;font-size:13px}

/* números: uma faixa com divisórias finas */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--b);border-radius:8px;overflow:hidden}
.kpi{padding:14px 16px 12px;min-width:0;box-shadow:1px 0 0 var(--b),0 1px 0 var(--b)}
.kpi .r{display:block;font-size:13px;color:var(--sec);cursor:help}
.kpi .v{display:block;margin:4px 0 2px;font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.kpi .v.nulo{color:var(--mut)}
.kpi .d{display:block;min-height:18px;font-size:12.5px;color:var(--mut);font-variant-numeric:tabular-nums}
.kpi .d.bom{color:var(--bom)}.kpi .d.ruim{color:var(--ruim)}

/* gráfico */
.graf svg{display:block;width:100%;height:auto;overflow:visible;margin-top:8px}
.graf text{font-family:inherit;font-size:11px;fill:var(--sec)}
.leg{display:flex;flex-wrap:wrap;gap:4px 18px;margin:6px 0 0;padding:0;list-style:none;font-size:13px;color:var(--sec)}
.leg li{display:flex;align-items:center;gap:6px}
.leg i{width:10px;height:10px;border-radius:2px;flex:none}
details.def{font-size:13px;color:var(--sec)}
details.def summary{cursor:pointer;min-height:28px;display:inline-flex;align-items:center;gap:6px;list-style:none}
details.def summary::-webkit-details-marker{display:none}
details.def summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}
details.def[open]>summary::before{transform:rotate(45deg)}
details.def summary:hover{color:var(--txt)}
details.def ul{margin:6px 0 0;padding-left:18px}
details.def li{margin:3px 0}
.tabdia{width:100%;max-width:520px;margin-top:6px;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px}
.tabdia th,.tabdia td{padding:5px 8px;border-bottom:1px solid var(--b);text-align:right}
.tabdia th{color:var(--sec);font-weight:500}
.tabdia th:first-child,.tabdia td:first-child{text-align:left;padding-left:0}

/* duas colunas */
.duas{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;align-items:start}
.duas.larga{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}

/* listas densas */
.lin{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:10px 0;border-top:1px solid var(--b)}
.lin .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lin .det{display:block;margin-top:1px;font-size:13px;color:var(--sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.lin .btns{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.vazio{margin:0;padding:12px 0;border-top:1px solid var(--b);color:var(--sec)}
.vazio b{color:var(--txt);font-weight:600}

/* resposta para revisar */
.caso{padding:12px 0;border-top:1px solid var(--b)}
.caso .q{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--sec)}
.caso .q b{color:var(--txt);font-weight:600}
.caso dl{display:grid;grid-template-columns:62px minmax(0,1fr);gap:4px 10px;margin:8px 0 0;font-size:13.5px}
.caso dt{color:var(--mut);font-size:12.5px;padding-top:1px}
.caso dd{margin:0;white-space:pre-wrap;word-break:break-word}
.caso dd.errado{color:var(--ruim)}
.caso .btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}

/* ensinar */
label.rot{display:flex;justify-content:space-between;gap:10px;font-size:13px;font-weight:500;color:var(--txt);margin:14px 0 6px}
label.rot span{font-weight:400;color:var(--mut);font-variant-numeric:tabular-nums}
textarea,input[type=text]{width:100%;border:1px solid var(--b2);border-radius:6px;background:#fff;padding:9px 11px;line-height:1.45;transition:border-color .12s,box-shadow .12s}
textarea{min-height:96px;resize:vertical}
textarea:focus,input[type=text]:focus{outline:none;border-color:var(--azul);box-shadow:0 0 0 3px rgba(39,129,246,.15)}
textarea::placeholder,input::placeholder{color:var(--mut)}
.exemplos{list-style:none;padding:0!important}
.exemplos button{border:0;background:transparent;padding:2px 0;color:var(--azul-txt);cursor:pointer;text-align:left}
.exemplos button:hover{text-decoration:underline}
.falas input{margin-top:6px}
.acoes{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
.antes-depois{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
.antes-depois>div{border:1px solid var(--b);border-radius:8px;padding:9px 11px;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
.antes-depois>div.nova{border-color:#a9cdfb;background:#f5f9ff}
.antes-depois small{display:block;margin-bottom:3px;color:var(--sec);font-size:12px;font-weight:500}
.previa-item{padding:12px 0;border-top:1px solid var(--b)}
.previa-item .fala{font-size:13px;color:var(--sec)}
.previa-item .fala b{color:var(--txt);font-weight:500}
.regra{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--b)}
.regra p{margin:0;flex:1;min-width:0;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
.regra small{display:block;margin-top:2px;color:var(--mut);font-size:12px}
.regra.off p{color:var(--mut)}
.sw{position:relative;width:32px;height:18px;margin-top:2px;border-radius:999px;border:0;background:#d9d9e0;cursor:pointer;flex:none;transition:background .15s}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}
.sw[aria-checked=true]{background:var(--azul)}
.sw[aria-checked=true]::after{transform:translateX(14px)}
details.equipe{margin-top:12px}

/* testar: a conversa com o desenho do Chatwoot (paciente à esquerda, Sofia à direita) */
.chatbox{border:1px solid var(--b);border-radius:8px;overflow:hidden}
.chatbox .cabc{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--b);font-size:13px;color:var(--sec)}
.chatbox .cabc b{color:var(--txt);font-weight:600;font-size:14px}
.chat{display:flex;flex-direction:column;gap:6px;height:min(56vh,520px);overflow-y:auto;padding:14px;background:#fcfcfd}
.msg{max-width:76%;padding:8px 12px;border-radius:12px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.msg.pac{align-self:flex-start;background:#f0f0f3}
.msg.sofia{align-self:flex-end;background:#dbe8fe}
.msg.acao{align-self:flex-end;background:transparent;color:var(--amarelo);font-size:12px;padding:0 4px}
.msg.dica{align-self:center;background:transparent;color:var(--sec);font-size:13px;text-align:center}
.msg.dig{color:var(--sec)}
.escrever{display:flex;gap:8px;padding:10px;border-top:1px solid var(--b)}
.escrever textarea{min-height:40px;height:40px;resize:none}
.lista-falas{margin:6px 0 0;padding:0;list-style:none}
.lista-falas li{border-top:1px solid var(--b)}
.lista-falas button{width:100%;border:0;background:transparent;text-align:left;padding:8px 0;cursor:pointer;color:var(--txt)}
.lista-falas button:hover{color:var(--azul-txt)}

/* tabela */
.rolar{overflow-x:auto}
table.tab{width:100%;border-collapse:collapse;font-size:14px}
.tab th{padding:8px 12px;text-align:left;font-size:12px;font-weight:500;color:var(--sec);white-space:nowrap;border-bottom:1px solid var(--b2)}
.tab td{padding:10px 12px;border-bottom:1px solid var(--b);vertical-align:middle}
.tab th:first-child,.tab td:first-child{padding-left:0}
.tab th:last-child,.tab td:last-child{padding-right:0;text-align:right;white-space:nowrap}
.sem{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--sec);white-space:nowrap}
.sem::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ponto,#b9bbc6)}
.sem.a{--ponto:#e5a100}.sem.g{--ponto:#30a46c}.sem.v{--ponto:#d9304f}

/* pedir */
.tipos{display:flex;flex-direction:column;gap:2px;margin-top:10px}
.tipos label{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;font-size:14px}
.tipos input{width:16px;height:16px;margin:0;accent-color:var(--azul)}
.pedido{padding:10px 0;border-top:1px solid var(--b)}
.pedido .l1{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pedido .l1 b{font-weight:600}
.pedido p{margin:4px 0 0;font-size:13.5px;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.pedido .det{margin-top:2px;font-size:12.5px;color:var(--sec)}
.pedido .resp{margin-top:6px;padding-left:10px;border-left:2px solid #a9d9bd;color:#185c3c;font-size:13px;white-space:pre-wrap}

/* esqueleto e aviso flutuante */
.sk{display:block;border-radius:6px;background:linear-gradient(90deg,#f0f0f3 0,#f9f9fb 40%,#f0f0f3 80%);background-size:300% 100%;animation:brilho 1.2s ease-in-out infinite}
@keyframes brilho{from{background-position:100% 0}to{background-position:0 0}}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));padding:10px 14px;border-radius:8px;background:#1c2024;color:#fff;font-size:13.5px;z-index:20}
.toast.erro{background:#8f1d3a}
.rodape{margin-top:32px;color:var(--mut);font-size:12.5px}
@media (max-width:900px){.duas,.duas.larga{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){main{padding:16px 16px 40px}.antes-depois{grid-template-columns:1fr}.lin{grid-template-columns:1fr}.lin .btns{justify-content:flex-start}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body><main>
<div class="cab">
  <div><h1>Agente</h1><div class="meta" id="unidadeNome">Carregando…</div></div>
  <div class="eu"><select class="sel" id="unidadeSel" aria-label="Unidade" hidden></select><span id="euNome"></span></div>
</div>
<div id="erroTopo" class="aviso erro" hidden></div>

<div id="corpo" hidden>
<div class="topo">
  <nav class="abas" role="tablist" aria-label="Seções">
    <button role="tab" id="aba-painel" data-aba="painel" aria-selected="true">Painel</button>
    <button role="tab" id="aba-ensinar" data-aba="ensinar" aria-selected="false">Ensinar</button>
    <button role="tab" id="aba-testar" data-aba="testar" aria-selected="false">Testar</button>
    <button role="tab" id="aba-pausadas" data-aba="pausadas" aria-selected="false">Pausadas<span class="c" id="contaPausadas"></span></button>
    <button role="tab" id="aba-pedir" data-aba="pedir" aria-selected="false">Pedir à Doutor Digital<span class="c" id="contaPedidos"></span></button>
  </nav>
  <div class="lado" id="ladoPainel"><select class="sel" id="periodo" aria-label="Período"><option value="hoje">Hoje</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option></select></div>
</div>

<!-- PAINEL -->
<section class="pane" id="pane-painel" role="tabpanel" aria-labelledby="aba-painel">
  <div class="kpis" id="kpis"><span class="sk" style="height:84px"></span></div>
  <section class="graf">
    <h3>Por dia <span class="c">últimos 14 dias</span></h3>
    <div id="grafico"><span class="sk" style="height:150px;margin-top:8px"></span></div>
    <ul class="leg"><li><i style="background:var(--azul-claro)"></i>Pessoas respondidas</li><li><i style="background:var(--azul)"></i>Consultas marcadas</li></ul>
    <details class="def" style="margin-top:4px"><summary>Ver como tabela</summary><div class="rolar"><table class="tabdia" id="tabDia"></table></div></details>
  </section>
  <div class="duas larga">
    <section>
      <h3>Respostas marcadas como ruins <span class="c" id="cRevisar"></span></h3>
      <div class="meta">Ficam aqui até alguém ensinar a Sofia, pedir ajuste ou dar ok.</div>
      <div id="listaRevisar" style="margin-top:8px"><span class="sk" style="height:60px"></span></div>
    </section>
    <section>
      <h3>Consultas que a Sofia marcou <span class="c" id="cMarcadas"></span></h3>
      <div class="meta">No período escolhido.</div>
      <div id="listaMarcadas" style="margin-top:8px"><span class="sk" style="height:60px"></span></div>
    </section>
  </div>
  <details class="def"><summary>Como cada número é contado</summary><ul>
    <li><b>Pessoas respondidas</b>: conversas em que a Sofia mandou pelo menos uma resposta no período.</li>
    <li><b>Consultas marcadas</b>: consultas que a Sofia marcou na agenda da franquia por uma conversa do Chatwoot.</li>
    <li><b>Marcaram</b>: consultas marcadas ÷ pessoas respondidas.</li>
    <li><b>Passou para a equipe</b>: conversas em que ela chamou alguém da equipe (paciente pediu uma pessoa, assunto que ela não resolve).</li>
    <li><b>Pix do sinal gerado</b>: conversas em que ela gerou o Pix do sinal.</li>
    <li><b>Para revisar</b>: respostas marcadas como ruins que ninguém revisou ainda.</li>
    <li><b>À noite ou no fim de semana</b>: respostas antes das 8h, a partir das 18h, sábado e domingo.</li>
    <li><b>Avaliadas como boas</b>: das avaliações que a equipe deu nos balões da Sofia, quantas foram positivas.</li>
    <li>Cada número compara com o período anterior do mesmo tamanho (hoje com ontem até a mesma hora).</li>
  </ul></details>
</section>

<!-- ENSINAR -->
<section class="pane" id="pane-ensinar" role="tabpanel" aria-labelledby="aba-ensinar" hidden>
  <div class="duas">
    <section>
      <h3>Ensinar a Sofia</h3>
      <div class="meta">Uma regra por vez, curta e direta. Antes de salvar você vê como ela responde hoje e como vai responder com a regra.</div>
      <div class="vinculo" id="vinculo-ensinar" hidden><span>Esta regra resolve a resposta marcada por <b class="vinculoQuem"></b>.</span><button class="bt link" type="button" data-desvincular>Desvincular</button></div>
      <label class="rot" for="regra">O que a Sofia deve fazer diferente? <span id="cnt">0/400</span></label>
      <textarea id="regra" maxlength="800" placeholder="Quando o paciente perguntar o valor, diga o valor da consulta antes de perguntar sobre a dor."></textarea>
      <details class="def" style="margin-top:6px"><summary>Exemplos</summary><ul class="exemplos" id="exemplos"></ul></details>
      <details class="def falas"><summary>Falas de paciente usadas no teste</summary>
        <input type="text" id="f0" maxlength="500" aria-label="Fala 1"><input type="text" id="f1" maxlength="500" aria-label="Fala 2"><input type="text" id="f2" maxlength="500" aria-label="Fala 3">
      </details>
      <div class="acoes"><span class="meta" id="previasNota"></span><button class="bt pri" id="btPrevia" type="button">Testar antes de salvar</button></div>
      <div id="avisoPrevia" class="aviso erro" hidden style="margin-top:10px"></div>
      <div id="cardPrevia" hidden style="margin-top:20px">
        <h3>Como a Sofia responde</h3>
        <div class="meta">Nada foi salvo ainda.</div>
        <div id="previa" style="margin-top:6px"></div>
        <div class="acoes"><button class="bt leve" id="btAjustar" type="button">Ajustar o texto</button><button class="bt pri" id="btSalvar" type="button">Salvar regra</button></div>
        <div id="avisoSalvar" class="aviso erro" hidden style="margin-top:10px"></div>
      </div>
    </section>
    <section>
      <h3>Regras de vocês <span class="c" id="cRegras"></span></h3>
      <div class="meta">A Sofia segue as ligadas em toda conversa desta unidade.</div>
      <div id="listaRegras" style="margin-top:8px"><span class="sk" style="height:60px"></span></div>
      <details class="def equipe" id="equipe" hidden><summary id="equipeResumo"></summary>
        <div class="meta" style="margin-top:4px">Quem cuida destas é a Doutor Digital. Se alguma atrapalha, faça um pedido.</div>
        <ul id="listaEquipe"></ul>
      </details>
    </section>
  </div>
</section>

<!-- TESTAR -->
<section class="pane" id="pane-testar" role="tabpanel" aria-labelledby="aba-testar" hidden>
  <div class="duas larga">
    <div class="chatbox">
      <div class="cabc"><b>Conversa de teste</b><span>nada é enviado ao paciente</span></div>
      <div class="chat" id="chat" aria-live="polite"></div>
      <div class="escrever"><textarea id="fala" maxlength="600" aria-label="Fala do paciente" placeholder="Escreva como o paciente (Ctrl+Enter envia)"></textarea><button class="bt pri" id="btEnviar" type="button">Enviar</button></div>
    </div>
    <section>
      <h3>Falas para testar</h3>
      <ul class="lista-falas" id="sugestoes"></ul>
      <div class="acoes"><span class="meta" id="restam"></span></div>
      <div class="acoes" style="justify-content:flex-start"><button class="bt" id="btRegraDaqui" type="button">Ela errou? Ensinar</button><button class="bt leve" id="btRecomecar" type="button">Recomeçar</button></div>
      <div id="avisoChat" class="aviso erro" hidden style="margin-top:10px"></div>
      <p class="meta" style="margin-top:16px">Agenda e Pix aqui são de mentira: nada vai para a franquia, o Kommo ou o WhatsApp. A conversa fica só neste computador.</p>
    </section>
  </div>
</section>

<!-- PAUSADAS -->
<section class="pane" id="pane-pausadas" role="tabpanel" aria-labelledby="aba-pausadas" hidden>
  <section>
    <h3>Conversas com a Sofia pausada <span class="c" id="cPausadas"></span></h3>
    <div class="meta">A Sofia sai da frente quando alguém da equipe responde (pelo Chatwoot ou pelo celular) e volta quando a conversa é resolvida. Aqui dá para devolver antes.</div>
    <div class="rolar" style="margin-top:8px"><table class="tab"><thead><tr><th>Paciente</th><th>Pausada por</th><th>Desde</th><th>Com</th><th></th></tr></thead><tbody id="listaPausadas"></tbody></table></div>
  </section>
</section>

<!-- PEDIR -->
<section class="pane" id="pane-pedir" role="tabpanel" aria-labelledby="aba-pedir" hidden>
  <div class="duas">
    <section>
      <h3>Pedir à Doutor Digital</h3>
      <div class="meta">Valor, horários, médicos, informação da clínica ou um erro da Sofia: isso a nossa equipe ajusta. A resposta aparece na lista ao lado.</div>
      <div class="vinculo" id="vinculo-pedir" hidden><span>Este pedido resolve a resposta marcada por <b class="vinculoQuem"></b>.</span><button class="bt link" type="button" data-desvincular>Desvincular</button></div>
      <div class="tipos" id="tipos" role="radiogroup" aria-label="Tipo do pedido"></div>
      <label class="rot" for="pedidoTexto">O que precisa? <span id="cntPedido">0/1500</span></label>
      <textarea id="pedidoTexto" maxlength="1500" placeholder="A partir de 1º de dezembro a consulta passa a custar R$ 380 (com sinal, R$ 280)."></textarea>
      <div class="acoes"><span class="meta">Em nome de <b id="pedidoQuem"></b></span><button class="bt pri" id="btPedir" type="button">Enviar pedido</button></div>
      <div id="avisoPedido" class="aviso erro" hidden style="margin-top:10px"></div>
    </section>
    <section>
      <h3>Pedidos da unidade <span class="c">últimos 60 dias</span></h3>
      <div id="listaPedidos" style="margin-top:4px"><span class="sk" style="height:60px"></span></div>
    </section>
  </div>
</section>
<p class="rodape">Vale só para a unidade escolhida. A Doutor Digital é avisada de cada regra nova e de cada pedido.</p>
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
  var tToast = null;
  function toast(txt, erro){ var t = $('toast'); t.textContent = txt; t.className = 'toast' + (erro ? ' erro' : ''); t.hidden = false; clearTimeout(tToast); tToast = setTimeout(function(){ t.hidden = true; }, 4000); }
  function aviso(id, txt){ var a = $(id); a.textContent = txt; a.hidden = false; }
  function some(id){ $(id).hidden = true; }
  function erroEm(box, msg){ box.textContent = ''; box.appendChild(el('div', 'aviso erro', msg)); }

  // ── servidor (com o login do Chatwoot de quem está usando) ──
  function cab(){ var h = { 'Content-Type': 'application/json' }; if (S) { h['X-CW-Token'] = S.token; h['X-CW-Client'] = S.client; h['X-CW-Uid'] = S.uid; } return h; }
  async function api(method, path, body){
    var r = await fetch(path, { method: method, headers: cab(), body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { var er = new Error(j.error || ('erro ' + r.status)); er.dados = j; if (r.status === 401) { S = null; pedirSessao(); } throw er; }
    return j;
  }
  function enc(x){ return encodeURIComponent(x); }
  function apiUnidade(){ return '/api/public/aprendizados/' + enc(U.slug); }

  // ── datas e números ──
  function ha(iso){
    var d = new Date(iso), s = (Date.now() - d.getTime()) / 1000; if (isNaN(s)) return '';
    if (s < 60) return 'agora'; if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min'; if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
    var dias = Math.floor(s / 86400); if (dias === 1) return 'ontem'; if (dias < 7) return 'há ' + dias + ' dias';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }
  function diaMes(d){ var p = String(d).split('-'); return p.length === 3 ? p[2] + '/' + p[1] : d; }
  function consultaEm(s){ var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? (m[3] + '/' + m[2] + ' às ' + m[4] + 'h' + (m[5] !== '00' ? m[5] : '')) : ''; }
  function plural(n, um, varios){ return n + ' ' + (n === 1 ? um : varios); }

  // ── abas ──
  var ABAS = ['painel', 'ensinar', 'testar', 'pausadas', 'pedir'], abaAtual = 'painel';
  function ir(qual){
    if (ABAS.indexOf(qual) < 0 || $('aba-' + qual).hidden) qual = 'painel';
    abaAtual = qual;
    // saiu da aba onde o caso foi aberto: desiste do vínculo (uma regra ou pedido qualquer não pode dar o caso por revisado)
    if (revisando && revisando.aba !== qual) desvincular();
    ABAS.forEach(function(a){ $('pane-' + a).hidden = a !== qual; $('aba-' + a).setAttribute('aria-selected', a === qual ? 'true' : 'false'); });
    $('ladoPainel').hidden = qual !== 'painel';
    guardar('agente:aba', qual);
    if (qual === 'painel') carregarPainel();
    if (qual === 'ensinar') carregarRegras();
    if (qual === 'testar') { desenharChat(false); setTimeout(function(){ $('fala').focus(); }, 50); }
    if (qual === 'pausadas') carregarPausadas();
    if (qual === 'pedir') carregarPedidos();
  }
  ABAS.forEach(function(a){ $('aba-' + a).addEventListener('click', function(){ ir(a); }); });

  // ── estado da unidade (regras, testes de regra, conversa de teste) ──
  var EST = null, MAX = 400, falasPadrao = [];
  async function lerEstado(){
    EST = await api('GET', apiUnidade());
    MAX = EST.maxCaracteres || 400; falasPadrao = EST.falasDeExemplo || [];
    ['f0', 'f1', 'f2'].forEach(function(id, i){ if (!$(id).value) $(id).value = falasPadrao[i] || ''; });
    $('aba-testar').hidden = !!(EST.conversa && EST.conversa.maximo === 0);
    $('previasNota').textContent = EST.previasRestantes != null ? ('Restam ' + EST.previasRestantes + ' testes de regra hoje') : '';
    contar();
    return EST;
  }

  // ── PAINEL ──
  var PERIODO = lerGuardado('agente:periodo') || '7';
  $('periodo').value = PERIODO;
  $('periodo').addEventListener('change', function(){ PERIODO = $('periodo').value; guardar('agente:periodo', PERIODO); carregarPainel(); });
  var COMPARA = { hoje: 'ontem', '7': '7 dias antes', '30': '30 dias antes' };
  function variacao(agora, antes, pontos){
    if (agora == null || antes == null) return { t: '', c: '' };
    var d = agora - antes;
    if (d === 0) return { t: PERIODO === 'hoje' ? 'igual a ontem' : 'igual ao período anterior', c: '' };
    return { t: (d > 0 ? '+' : '−') + Math.abs(d) + (pontos ? ' pts' : '') + ' vs. ' + COMPARA[PERIODO], c: d > 0 ? 'bom' : 'ruim' };
  }
  function kpi(rotulo, definicao, valor, v){
    var k = el('div', 'kpi'), r = el('span', 'r', rotulo); r.title = definicao; k.appendChild(r);
    k.appendChild(el('span', 'v' + (valor === '—' ? ' nulo' : ''), valor));
    k.appendChild(el('span', 'd' + (v && v.c ? ' ' + v.c : ''), v ? v.t : ''));
    return k;
  }
  // o caso (👎) que a pessoa abriu em «Ensinar a Sofia» ou «Pedir ajuste»: só a regra/o pedido feito DALI o dá por revisado
  var revisando = null, pedidoConversa = null;
  function mostrarVinculo(){
    ['ensinar', 'pedir'].forEach(function(a){
      var v = $('vinculo-' + a), ativo = !!revisando && revisando.aba === a; v.hidden = !ativo;
      if (ativo) v.querySelector('.vinculoQuem').textContent = revisando.quem;
    });
  }
  function desvincular(){ revisando = null; pedidoConversa = null; mostrarVinculo(); }
  Array.prototype.forEach.call(document.querySelectorAll('[data-desvincular]'), function(b){ b.addEventListener('click', desvincular); });
  async function carregarPainel(){
    try {
      var p = await api('GET', '/api/public/agente/painel?slug=' + enc(U.slug) + '&periodo=' + enc(PERIODO));
      var k = $('kpis'); k.textContent = '';
      k.appendChild(kpi('Pessoas respondidas', 'Conversas em que a Sofia mandou pelo menos uma resposta no período', String(p.respondidas.agora), variacao(p.respondidas.agora, p.respondidas.antes)));
      k.appendChild(kpi('Consultas marcadas', 'Consultas que a Sofia marcou na agenda da franquia por uma conversa do Chatwoot', String(p.marcadas.agora), variacao(p.marcadas.agora, p.marcadas.antes)));
      k.appendChild(kpi('Marcaram', 'Consultas marcadas ÷ pessoas respondidas', p.conversao.agora == null ? '—' : p.conversao.agora + '%', variacao(p.conversao.agora, p.conversao.antes, true)));
      k.appendChild(kpi('Pix do sinal gerado', 'Conversas em que ela gerou o Pix do sinal', String(p.pix.agora), variacao(p.pix.agora, p.pix.antes)));
      var eq = variacao(p.equipe.agora, p.equipe.antes); eq.c = '';
      k.appendChild(kpi('Passou para a equipe', 'Conversas em que ela chamou alguém da equipe', String(p.equipe.agora), eq));
      k.appendChild(kpi('À noite ou fim de semana', 'Respostas antes das 8h, a partir das 18h, sábado e domingo', p.foraDoHorario.pct == null ? '—' : p.foraDoHorario.pct + '%', { t: p.respostas ? (p.foraDoHorario.respostas + ' de ' + plural(p.respostas, 'resposta', 'respostas')) : '', c: '' }));
      k.appendChild(kpi('Avaliadas como boas', 'Das avaliações que a equipe deu nos balões da Sofia, quantas foram positivas', p.avaliacoes.pct == null ? '—' : p.avaliacoes.pct + '%', p.avaliacoes.pct == null ? { t: 'ninguém avaliou', c: '' } : variacao(p.avaliacoes.pct, p.avaliacoes.pctAntes, true)));
      var nr = p.totalParaRevisar != null ? p.totalParaRevisar : (p.paraRevisar || []).length;
      k.appendChild(kpi('Para revisar', 'Respostas marcadas como ruins que ninguém revisou ainda', String(nr), { t: nr ? 'veja abaixo' : 'nada pendente', c: '' }));
      desenharGrafico(p.porDia || []);
      desenharMarcadas(p.ultimasMarcadas || []);
      desenharRevisar(p.paraRevisar || [], nr);
    } catch (e) { erroEm($('kpis'), e.message); }
    contarPausadas();
  }
  var NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs){ var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  var diasDoGrafico = null, tRedesenho = null;
  window.addEventListener('resize', function(){ clearTimeout(tRedesenho); tRedesenho = setTimeout(function(){ if (diasDoGrafico && abaAtual === 'painel') desenharGrafico(diasDoGrafico); }, 150); });
  function desenharGrafico(dias){
    diasDoGrafico = dias;
    var box = $('grafico'); box.textContent = '';
    var W = Math.max(320, Math.round(box.clientWidth || 720)), H = 166, base = 140, topo = 14, n = dias.length || 1, passo = W / n, larg = Math.min(28, passo * 0.56);
    var max = 1; dias.forEach(function(d){ max = Math.max(max, d.respondidas, d.marcadas); });
    var g = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Pessoas respondidas e consultas marcadas por dia' });
    g.appendChild(svg('line', { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, stroke: '#d9d9e0' }));
    g.appendChild(svg('line', { x1: 0, x2: W, y1: topo + 0.5, y2: topo + 0.5, stroke: '#f0f0f3' }));
    var tm = svg('text', { x: 0, y: topo - 3 }); tm.textContent = String(max); g.appendChild(tm);
    dias.forEach(function(d, i){
      var x = i * passo + (passo - larg) / 2, alt = function(v){ return v > 0 ? Math.max(2, (base - topo) * v / max) : 0; };
      var gr = svg('g', {}), t = svg('title', {}); t.textContent = diaMes(d.dia) + ': ' + plural(d.respondidas, 'pessoa respondida', 'pessoas respondidas') + ', ' + plural(d.marcadas, 'consulta marcada', 'consultas marcadas'); gr.appendChild(t);
      gr.appendChild(svg('rect', { x: i * passo, y: 0, width: passo, height: H, fill: 'transparent' }));
      gr.appendChild(svg('rect', { x: x, y: base - alt(d.respondidas), width: larg, height: alt(d.respondidas), rx: 2, fill: '#cfe3fd' }));
      if (d.marcadas) gr.appendChild(svg('rect', { x: x + larg * 0.22, y: base - alt(d.marcadas), width: larg * 0.56, height: alt(d.marcadas), rx: 2, fill: '#2781f6' }));
      if (i % 2 === (n - 1) % 2) { var tx = svg('text', { x: x + larg / 2, y: base + 16, 'text-anchor': 'middle' }); tx.textContent = diaMes(d.dia); gr.appendChild(tx); }
      g.appendChild(gr);
    });
    box.appendChild(g);
    var tab = $('tabDia'); tab.textContent = '';
    var cabT = el('tr'); ['Dia', 'Pessoas respondidas', 'Consultas marcadas'].forEach(function(t){ cabT.appendChild(el('th', null, t)); }); tab.appendChild(cabT);
    dias.slice().reverse().forEach(function(d){ var tr = el('tr'); tr.appendChild(el('td', null, diaMes(d.dia))); tr.appendChild(el('td', null, String(d.respondidas))); tr.appendChild(el('td', null, String(d.marcadas))); tab.appendChild(tr); });
  }
  function desenharMarcadas(l){
    var box = $('listaMarcadas'); box.textContent = ''; $('cMarcadas').textContent = l.length ? String(l.length) : '';
    if (!l.length) { var v = el('p', 'vazio'); v.appendChild(el('b', null, 'Nenhuma no período. ')); v.appendChild(document.createTextNode('Quando a Sofia marcar uma consulta, ela aparece aqui com o dia e a hora.')); box.appendChild(v); return; }
    l.forEach(function(m){
      var row = el('div', 'lin'), q = el('div');
      q.appendChild(el('div', 'nm', m.nome || ('Conversa ' + m.conversa)));
      q.appendChild(el('span', 'det', (m.agendadoPara ? 'Consulta ' + consultaEm(m.agendadoPara) : 'Consulta marcada') + ' · marcada ' + ha(m.criadoEm)));
      var bs = el('div', 'btns'), ab = el('button', 'bt', 'Abrir conversa'); ab.type = 'button'; ab.onclick = function(){ abrirConversa(m.conversa); }; bs.appendChild(ab);
      row.appendChild(q); row.appendChild(bs); box.appendChild(row);
    });
  }
  function desenharRevisar(l, total){
    var box = $('listaRevisar'); box.textContent = ''; $('cRevisar').textContent = total ? (total > l.length ? (l.length + ' de ' + total) : String(total)) : '';
    if (!l.length) { var v = el('p', 'vazio'); v.appendChild(el('b', null, 'Nada para revisar. ')); v.appendChild(document.createTextNode('Para marcar uma resposta ruim, passe o mouse no balão da Sofia dentro da conversa.')); box.appendChild(v); return; }
    l.forEach(function(a){
      var c = el('div', 'caso'), q = el('div', 'q'), quem = el('span'); quem.appendChild(el('b', null, a.quemNome)); quem.appendChild(document.createTextNode(' marcou como ruim'));
      q.appendChild(quem); q.appendChild(el('span', null, ha(a.criadoEm))); c.appendChild(q);
      var dl = el('dl');
      if (a.fala) { dl.appendChild(el('dt', null, 'Paciente')); dl.appendChild(el('dd', null, a.fala)); }
      if (a.resposta) { dl.appendChild(el('dt', null, 'Sofia')); dl.appendChild(el('dd', null, a.resposta)); }
      if (a.texto) { dl.appendChild(el('dt', null, 'Errado')); dl.appendChild(el('dd', 'errado', a.texto)); }
      c.appendChild(dl);
      var bs = el('div', 'btns');
      var b1 = el('button', 'bt pri', 'Ensinar a Sofia'); b1.type = 'button';
      b1.onclick = function(){ revisando = { id: a.id, quem: a.quemNome, aba: 'ensinar' }; $('regra').value = (a.texto || '').slice(0, MAX); if (a.fala) $('f0').value = a.fala.slice(0, 500); ir('ensinar'); mostrarVinculo(); contar(); $('regra').focus(); };
      var b2 = el('button', 'bt', 'Pedir ajuste'); b2.type = 'button';
      b2.onclick = function(){
        revisando = { id: a.id, quem: a.quemNome, aba: 'pedir' }; escolherTipo('erro');
        var txt = (a.fala ? 'O paciente disse: "' + a.fala.slice(0, 300) + '"\n' : '') + (a.resposta ? 'A Sofia respondeu: "' + a.resposta.slice(0, 500) + '"\n' : '') + (a.texto ? 'O que estava errado: ' + a.texto : '');
        $('pedidoTexto').value = txt.slice(0, 1500); ir('pedir'); pedidoConversa = a.conversa; mostrarVinculo(); contarPedido(); $('pedidoTexto').focus();
      };
      var b3 = el('button', 'bt', 'Abrir conversa'); b3.type = 'button'; b3.onclick = function(){ abrirConversa(a.conversa); };
      var b4 = el('button', 'bt leve', 'Já resolvido'); b4.type = 'button';
      b4.onclick = async function(){ b4.disabled = true; try { await revisar(a.id, 'ok'); toast('Marcado como resolvido.'); carregarPainel(); } catch (er) { b4.disabled = false; toast(er.message, true); } };
      bs.appendChild(b1); bs.appendChild(b2); bs.appendChild(b3); bs.appendChild(b4); c.appendChild(bs);
      box.appendChild(c);
    });
  }
  function revisar(id, como){ return api('POST', '/api/public/agente/avaliacoes/' + enc(id) + '/revisar', { slug: U.slug, como: como }); }
  function abrirConversa(id){ try { window.parent.postMessage({ event: 'funil:abrir-conversa', id: id }, CW); } catch (e) {} }

  // ── ENSINAR ──
  var EXEMPLOS = [
    'Quando o paciente perguntar o valor, diga o valor da consulta antes de perguntar sobre a dor.',
    'Se o paciente disser que vai pensar ou falar com a família, ofereça mandar o endereço e o valor por escrito.',
    'Quando o paciente mandar exame, agradeça e diga que o doutor vai olhar na consulta.'
  ];
  EXEMPLOS.forEach(function(t){ var li = el('li'), b = el('button', null, t); b.type = 'button'; b.onclick = function(){ $('regra').value = t; contar(); $('regra').focus(); }; li.appendChild(b); $('exemplos').appendChild(li); });
  var previaDe = null;
  function contar(){
    var n = $('regra').value.trim().length; $('cnt').textContent = n + '/' + MAX; $('cnt').style.color = n > MAX ? 'var(--ruim)' : '';
    if (previaDe !== null && $('regra').value.trim() !== previaDe) { $('cardPrevia').hidden = true; previaDe = null; }
  }
  $('regra').addEventListener('input', contar);
  function primeiraFrase(t){ var m = String(t).match(/^[\s\S]*?[.!?](\s|$)/); return (m ? m[0] : String(t)).trim(); }
  async function carregarRegras(){
    var l = $('listaRegras');
    try { await lerEstado(); } catch (e) { erroEm(l, e.message); return; }
    l.textContent = '';
    var minhas = EST.regras.filter(function(r){ return r.daUnidade; });
    $('cRegras').textContent = minhas.length ? (minhas.filter(function(r){ return r.enabled; }).length + ' ligadas') : '';
    if (!minhas.length) l.appendChild(el('p', 'vazio', 'Nenhuma regra de vocês ainda. A primeira que você salvar aparece aqui.'));
    minhas.forEach(function(r){
      var row = el('div', 'regra' + (r.enabled ? '' : ' off'));
      var sw = el('button', 'sw'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', r.enabled ? 'true' : 'false'); sw.setAttribute('aria-label', r.enabled ? 'Desligar regra' : 'Ligar regra');
      sw.onclick = async function(){ sw.disabled = true; try { await api('POST', apiUnidade() + '/regra/' + enc(r.id), { enabled: !r.enabled }); toast(r.enabled ? 'Regra desligada.' : 'Regra ligada.'); carregarRegras(); } catch (e) { sw.disabled = false; toast(e.message, true); } };
      var p = el('p', null, r.content); p.appendChild(el('small', null, (r.enabled ? 'Ligada' : 'Desligada') + ' · ' + ha(r.createdAt)));
      row.appendChild(sw); row.appendChild(p); l.appendChild(row);
    });
    // as da Doutor Digital (painel e reflexão semanal): só leitura, sem repetição
    var vistas = {}, unicas = [];
    EST.regras.filter(function(r){ return !r.daUnidade && r.enabled; }).forEach(function(r){ var t = primeiraFrase(r.content), k = t.toLowerCase(); if (vistas[k]) return; vistas[k] = 1; unicas.push(t); });
    $('equipe').hidden = !unicas.length;
    $('equipeResumo').textContent = 'Regras da Doutor Digital (' + unicas.length + ')';
    var ul = $('listaEquipe'); ul.textContent = '';
    unicas.forEach(function(t){ ul.appendChild(el('li', null, t)); });
  }
  $('btPrevia').addEventListener('click', async function(){
    var b = this, regra = $('regra').value.trim(); some('avisoPrevia');
    if (regra.length < 10) { aviso('avisoPrevia', 'Escreva a regra primeiro (uma frase).'); $('regra').focus(); return; }
    if (regra.length > MAX) { aviso('avisoPrevia', 'A regra passou de ' + MAX + ' letras. Resuma um pouco.'); return; }
    b.disabled = true; var txt = b.textContent; b.textContent = 'A Sofia está respondendo…';
    try {
      var falas = ['f0', 'f1', 'f2'].map(function(id){ return $(id).value.trim(); }).filter(Boolean);
      var r = await api('POST', apiUnidade() + '/previa', { regra: regra, falas: falas });
      var box = $('previa'); box.textContent = '';
      r.resultados.forEach(function(x){
        var d = el('div', 'previa-item'), f = el('div', 'fala'); f.appendChild(document.createTextNode('Paciente: ')); f.appendChild(el('b', null, x.fala)); d.appendChild(f);
        var ad = el('div', 'antes-depois'), a = el('div'), n = el('div', 'nova');
        a.appendChild(el('small', null, 'Hoje')); a.appendChild(document.createTextNode(x.antes));
        n.appendChild(el('small', null, 'Com a regra')); n.appendChild(document.createTextNode(x.depois));
        ad.appendChild(a); ad.appendChild(n); d.appendChild(ad); box.appendChild(d);
      });
      previaDe = regra; $('cardPrevia').hidden = false; some('avisoSalvar'); $('btSalvar').disabled = false;
      $('previasNota').textContent = 'Restam ' + r.previasRestantes + ' testes de regra hoje';
      $('cardPrevia').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { aviso('avisoPrevia', e.message); }
    finally { b.disabled = false; b.textContent = txt; }
  });
  $('btAjustar').addEventListener('click', function(){ $('regra').focus(); });
  $('btSalvar').addEventListener('click', async function(){
    var b = this; some('avisoSalvar');
    if (previaDe === null || $('regra').value.trim() !== previaDe) { aviso('avisoSalvar', 'O texto mudou: teste de novo antes de salvar.'); return; }
    b.disabled = true;
    try {
      await api('POST', apiUnidade(), { regra: previaDe });
      if (revisando && revisando.aba === 'ensinar') await revisar(revisando.id, 'regra').catch(function(){});
      desvincular();
      $('regra').value = ''; previaDe = null; $('cardPrevia').hidden = true; contar();
      toast('Regra salva. A Sofia já segue nas próximas conversas.');
      carregarRegras();
    } catch (e) { aviso('avisoSalvar', e.message); b.disabled = false; }
  });

  // ── TESTAR (o histórico fica neste navegador) ──
  var SUGESTOES = ['Oi, quanto custa a consulta?', 'Tenho hérnia de disco, tem cura?', 'Vocês atendem por convênio?', 'Qual o endereço da clínica?', 'Tem horário amanhã de manhã?', 'Vou pensar e te aviso'];
  SUGESTOES.forEach(function(t){ var li = el('li'), b = el('button', null, t); b.type = 'button'; b.onclick = function(){ $('fala').value = t; $('fala').focus(); }; li.appendChild(b); $('sugestoes').appendChild(li); });
  var historico = [], aguardando = false, restam = null;
  function chaveChat(){ return 'agente:conversa:' + (U ? U.slug : ''); }
  function lerChat(){ try { var h = JSON.parse(lerGuardado(chaveChat()) || '[]'); historico = Array.isArray(h) ? h.filter(function(m){ return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; }).slice(-40) : []; } catch (e) { historico = []; } }
  function salvarChat(){ historico = historico.slice(-40); while (historico.length && historico[0].role !== 'user') historico.shift(); guardar(chaveChat(), JSON.stringify(historico)); }
  function desenharChat(digitando){
    var c = $('chat'); c.textContent = '';
    if (!historico.length && !digitando) c.appendChild(el('div', 'msg dica', 'Escreva uma fala de paciente e veja o que a Sofia responde.'));
    historico.forEach(function(m){ c.appendChild(el('div', 'msg ' + (m.role === 'user' ? 'pac' : 'sofia'), m.content)); (m.a || []).forEach(function(t){ c.appendChild(el('div', 'msg acao', 'no teste: ' + t)); }); });
    if (digitando) c.appendChild(el('div', 'msg sofia dig', 'Sofia está escrevendo…'));
    c.scrollTop = c.scrollHeight;
    $('restam').textContent = restam != null ? ('Restam ' + restam + ' respostas de teste hoje') : '';
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
    $('regra').value = ('Quando o paciente disser algo como "' + fala.slice(0, 120) + '", a Sofia deve ').slice(0, MAX);
    $('f0').value = fala.slice(0, 500); ir('ensinar'); contar(); var r = $('regra'); r.focus(); r.setSelectionRange(r.value.length, r.value.length);
  });

  // ── PAUSADAS ──
  function mostrarContaPausadas(n){ $('contaPausadas').textContent = n ? String(n) : ''; $('cPausadas').textContent = n ? String(n) : ''; }
  async function contarPausadas(){ try { var r = await api('GET', '/api/public/testar-ia/pausadas'); mostrarContaPausadas(r.conversas.length); } catch (e) {} }
  function linhaUnica(tb, conteudo){ var tr = el('tr'), td = el('td'); td.colSpan = 5; td.style.textAlign = 'left'; td.appendChild(conteudo); tr.appendChild(td); tb.appendChild(tr); }
  async function carregarPausadas(){
    var tb = $('listaPausadas'); tb.textContent = '';
    var sk = el('span', 'sk'); sk.style.height = '40px'; linhaUnica(tb, sk);
    try {
      var r = await api('GET', '/api/public/testar-ia/pausadas'); mostrarContaPausadas(r.conversas.length); tb.textContent = '';
      if (!r.conversas.length) { linhaUnica(tb, el('span', 'mut', 'Nenhuma conversa com a Sofia pausada agora.')); return; }
      r.conversas.forEach(function(c){
        var tr = el('tr');
        tr.appendChild(el('td', null, c.nome));
        tr.appendChild(el('td', null, c.por || '—'));
        tr.appendChild(el('td', null, c.em ? ha(c.em) : '—'));
        tr.appendChild(el('td', null, c.atendente || '—'));
        var td = el('td'), ab = el('button', 'bt link', 'Abrir'), re = el('button', 'bt', 'Devolver para a Sofia');
        ab.type = re.type = 'button'; ab.onclick = function(){ abrirConversa(c.id); };
        re.onclick = async function(){ re.disabled = true; try { await api('POST', '/api/public/assistente/pausa', { conversa: c.id, acao: 'reativar' }); toast('A Sofia voltou a responder nesta conversa.'); carregarPausadas(); } catch (e) { re.disabled = false; toast(e.message, true); } };
        td.appendChild(ab); td.appendChild(re); tr.appendChild(td); tb.appendChild(tr);
      });
    } catch (e) { tb.textContent = ''; linhaUnica(tb, el('div', 'aviso erro', e.message)); }
  }

  // ── PEDIR ──
  var tipoPedido = null, TIPOS = [];
  function escolherTipo(id){ tipoPedido = id; Array.prototype.forEach.call(document.querySelectorAll('#tipos input'), function(i){ i.checked = i.value === id; }); }
  function contarPedido(){ $('cntPedido').textContent = $('pedidoTexto').value.trim().length + '/1500'; }
  $('pedidoTexto').addEventListener('input', contarPedido);
  function desenharTipos(){
    var box = $('tipos'); if (box.children.length || !TIPOS.length) return;
    TIPOS.forEach(function(t){ var l = el('label'), i = el('input'); i.type = 'radio'; i.name = 'tipo'; i.value = t.id; i.onchange = function(){ tipoPedido = t.id; }; l.appendChild(i); l.appendChild(document.createTextNode(t.rotulo)); box.appendChild(l); });
    if (tipoPedido) escolherTipo(tipoPedido);
  }
  var SITUACAO = { 'na-fila': ['a', 'Na fila'], resolvido: ['g', 'Resolvido'], reaberto: ['v', 'Reaberto'] };
  function desenharPedidos(lista){
    var l = $('listaPedidos'); l.textContent = '';
    var abertos = lista.filter(function(p){ return p.situacao !== 'resolvido'; }).length; $('contaPedidos').textContent = abertos ? String(abertos) : '';
    if (!lista.length) { l.appendChild(el('p', 'vazio', 'Nenhum pedido ainda. O que vocês pedirem aparece aqui, com a resposta da Doutor Digital.')); return; }
    lista.forEach(function(p){
      var d = el('div', 'pedido'), l1 = el('div', 'l1'), s = SITUACAO[p.situacao] || SITUACAO['na-fila'];
      l1.appendChild(el('b', null, '#' + p.protocolo + ' · ' + p.tipo)); l1.appendChild(el('span', 'sem ' + s[0], s[1]));
      d.appendChild(l1); d.appendChild(el('p', null, p.texto)); d.appendChild(el('div', 'det', (p.nome || '') + ' · ' + ha(p.criadoEm)));
      if (p.resposta) d.appendChild(el('div', 'resp', p.resposta));
      l.appendChild(d);
    });
  }
  async function carregarPedidos(){
    try { var r = await api('GET', '/api/public/agente/pedidos?slug=' + enc(U.slug)); TIPOS = r.tipos || []; desenharTipos(); desenharPedidos(r.pedidos || []); }
    catch (e) { erroEm($('listaPedidos'), e.message); }
  }
  $('btPedir').addEventListener('click', async function(){
    var b = this, texto = $('pedidoTexto').value.trim(); some('avisoPedido');
    if (!tipoPedido) { aviso('avisoPedido', 'Escolha o tipo do pedido.'); return; }
    if (texto.length < 10) { aviso('avisoPedido', 'Explique o que precisa (pelo menos uma frase).'); $('pedidoTexto').focus(); return; }
    b.disabled = true;
    try {
      var r = await api('POST', '/api/public/agente/pedidos', { slug: U.slug, tipo: tipoPedido, texto: texto, conversa: pedidoConversa });
      if (revisando && revisando.aba === 'pedir') await revisar(revisando.id, 'pedido').catch(function(){});
      desvincular();
      $('pedidoTexto').value = ''; contarPedido(); desenharPedidos(r.pedidos || []);
      toast('Pedido #' + r.protocolo + ' enviado. A Doutor Digital já foi avisada.');
    } catch (e) { aviso('avisoPedido', e.message); }
    b.disabled = false;
  });

  // ── entrada: sessão do Chatwoot pelo menu, unidade pelas caixas da pessoa ──
  function pedirSessao(){ try { window.parent.postMessage({ event: 'funil:pede-sessao' }, CW); } catch (e) {} }
  function escolherUnidade(u){
    U = u; guardar('agente:unidade', u.slug); $('unidadeNome').textContent = u.nome; desvincular();
    EST = null; previaDe = null; $('cardPrevia').hidden = true; lerChat(); restam = null;
    lerEstado().then(function(){ restam = EST && EST.conversa ? EST.conversa.restantes : null; if (abaAtual === 'testar') desenharChat(false); }).catch(function(e){ aviso('erroTopo', e.message); });
  }
  async function entrar(){
    try {
      var r = await api('GET', '/api/public/testar-ia/unidades');
      UNIDADES = r.unidades || []; EU = r.eu || '';
      $('euNome').textContent = EU; $('pedidoQuem').textContent = EU || 'você';
      if (!UNIDADES.length) { aviso('erroTopo', 'Você não atende nenhuma caixa com a Sofia. Peça para a Suzanne liberar a caixa da sua unidade.'); $('unidadeNome').textContent = 'Sem unidade'; return; }
      var guardada = lerGuardado('agente:unidade'), u = UNIDADES.filter(function(x){ return x.slug === guardada; })[0] || UNIDADES[0];
      if (UNIDADES.length > 1) {
        var sel = $('unidadeSel'); sel.hidden = false; sel.textContent = '';
        UNIDADES.forEach(function(x){ var o = el('option', null, x.nome); o.value = x.slug; sel.appendChild(o); });
        sel.value = u.slug; sel.onchange = function(){ var x = UNIDADES.filter(function(y){ return y.slug === sel.value; })[0]; if (x) { escolherUnidade(x); ir(abaAtual); } };
      }
      escolherUnidade(u); some('erroTopo'); $('corpo').hidden = false;
      // veio do polegar para baixo do painel da assistente: o texto já vira a regra nova (o teste continua obrigatório antes de salvar)
      var rasc = lerGuardado('testar-ia-rascunho'); guardar('testar-ia-rascunho', null);
      if (rasc) { $('regra').value = rasc.slice(0, 800); ir('ensinar'); contar(); $('regra').focus(); }
      else ir(lerGuardado('agente:aba') || 'painel');
      // os números das abas aparecem já na entrada, qualquer que seja a aba
      if (abaAtual !== 'pausadas' && abaAtual !== 'painel') contarPausadas();
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
