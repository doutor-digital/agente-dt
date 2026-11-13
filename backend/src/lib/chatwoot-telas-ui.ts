/**
 * O que a pessoa VÊ nas telas «Oportunidades», «Marketing» e «Gestor» do Chatwoot (13/11/2026). Mesma página do funil
 * (`GET /funil?menu=1&tela=oport|mkt|gestor`, num iframe ao lado do menu); aqui só o CSS e o JavaScript que entram nela.
 *
 * Decisões de desenho (as fontes estão no PR). A 1ª versão tinha «cara de IA» (cartões pastel, selos escuros, fórmula embaixo de
 * cada número, caixa com sombra em tudo); o João pediu para parecer parte do Chatwoot. Então:
 *  - As cores, bordas e a fonte são as do próprio Chatwoot (escala slate do Radix: texto #1c2024 / #60646c, borda #e8e8ec, azul #2781f6).
 *    UMA cor de destaque (o azul); verde e vermelho só quando significam bom/ruim (a variação contra o período anterior).
 *  - Os números do topo são UMA faixa com divisórias finas (sem sombra, raio de 8 px); cada um traz a variação contra o período
 *    anterior. A definição de cada número fica no `title` do rótulo e em «Como cada número é contado» (nunca embaixo do número).
 *  - Tabela: nome à esquerda, números à direita em `tabular-nums`, linha de total, «Sem campanha gravada» em cinza no fim.
 *  - No máximo UM gráfico por tela, e só quando responde uma pergunta: no Gestor, investido × faturado por dia (mesma unidade, R$,
 *    um eixo só; vem com legenda, dica ao passar o mouse e «Ver como tabela»). No Marketing, a barra de qualificação.
 *  - Listas densas (nome forte, detalhe em cinza numa linha, ação discreta à direita); semáforo = ponto de cor + a palavra.
 *  - Estados desenhados: carregando (esqueleto), vazio (diz o que fazer), erro (diz como sair), sem permissão, fonte não ligada.
 *  - Tabela vira lista no celular (360 px). Baixar PDF = a janela de impressão do navegador com folha de estilo própria.
 *
 * Os textos usam `String.raw`: é o JavaScript/CSS que o navegador recebe. Nada de crase nem interpolação aqui dentro.
 */

export const TELAS_CSS = String.raw`
/* ── telas novas: Oportunidades · Marketing · Gestor (a aparência do Chatwoot: escala slate, azul #2781f6) ── */
body.tg-pagina{background:#fff}
.tg-pagina .topo{background:#fff;box-shadow:none;border-bottom:1px solid #e8e8ec}
.tg-pagina .topo h1{font-size:16px;font-weight:600;color:#1c2024}
.quadro.tg{display:block;overflow:auto;padding:20px 24px 56px;--tg-txt:#1c2024;--tg-sec:#60646c;--tg-mut:#8b8d98;--tg-b:#e8e8ec;--tg-b2:#d9d9e0;--tg-azul:#2781f6;--tg-azul-txt:#086de0;--tg-bom:#218358;--tg-ruim:#ca244d;--tg-q:#b42318;--tg-m:#c77700;--tg-f:#2f6fd6;--tg-n:#b9bbc6;color:var(--tg-txt)}
.tg>*{max-width:1120px;margin-left:auto;margin-right:auto}
.tg>*+*{margin-top:24px}
.tg-topo{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;border-bottom:1px solid var(--tg-b)}
.tg-abas{display:flex;gap:4px;flex-wrap:wrap}
.tg-abas button{position:relative;min-height:40px;padding:0 12px;border:0;background:transparent;color:var(--tg-sec);font-weight:500;font-size:14px;cursor:pointer;border-radius:6px 6px 0 0}
.tg-abas button:hover{color:var(--tg-txt)}
.tg-abas button[aria-pressed=true]{color:var(--tg-azul-txt);font-weight:600}
.tg-abas button[aria-pressed=true]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--tg-azul);border-radius:2px}
.tg-lado{display:flex;align-items:center;gap:12px;color:var(--tg-sec);font-size:13px;padding-bottom:4px}
.tg-bt{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border-radius:6px;border:1px solid var(--tg-b2);background:#fff;color:var(--tg-txt);font-weight:500;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}
.tg-bt:hover{background:#f9f9fb;border-color:#cdced6}
.tg-bt.pri{background:var(--tg-azul);border-color:var(--tg-azul);color:#fff}
.tg-bt.pri:hover{background:#1073e9}
.tg-bt.azul{color:var(--tg-azul-txt)}
.tg-bt[aria-disabled=true]{color:var(--tg-mut);pointer-events:none;background:#f9f9fb}
.tg-bt svg{flex:none}
.tg-aviso{padding:9px 12px;border:1px solid #f0e2b6;border-radius:8px;background:#fffbeb;color:#6b4e00;font-size:13px}
.tg-aviso.info{border-color:#d5e2fb;background:#f5f9ff;color:#1d3f87}
.tg-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(176px,1fr));background:#fff;border:1px solid var(--tg-b);border-radius:8px;overflow:hidden}
.tg-kpi{background:#fff;padding:14px 16px 12px;min-width:0;box-shadow:1px 0 0 var(--tg-b),0 1px 0 var(--tg-b)}
.tg-kpi .r{display:block;font-size:13px;color:var(--tg-sec)}
.tg-kpi .v{display:block;margin:4px 0 2px;font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.tg-kpi .v.nulo{color:var(--tg-mut)}
.tg-kpi .v.conectar{font-size:15px;font-weight:600;color:var(--tg-azul-txt);line-height:1.4;margin:6px 0 4px}
.tg-kpi .d{display:block;min-height:18px;font-size:12.5px;color:var(--tg-mut);font-variant-numeric:tabular-nums}
.tg-kpi .d.bom{color:var(--tg-bom)}.tg-kpi .d.ruim{color:var(--tg-ruim)}
.tg-kpi .d i{font-style:normal;color:var(--tg-mut);margin-left:3px}
.tg-sec>h3{display:flex;align-items:baseline;gap:8px;margin:0 0 4px;font-size:14px;font-weight:600}
.tg-sec>h3 .c{color:var(--tg-mut);font-weight:500;font-variant-numeric:tabular-nums}
.tg-sec>h3 .dir{margin-left:auto;display:flex;gap:14px;font-weight:500;font-size:12.5px;color:var(--tg-sec)}
.tg-meta{color:var(--tg-sec);font-size:13px}
.tg-lin{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;align-items:center;padding:10px 0;border-top:1px solid var(--tg-b)}
.tg-quem{min-width:0}
.tg-quem .nm{display:flex;align-items:center;gap:10px;font-weight:600;min-width:0}
.tg-quem .nm>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tg-quem .fone{white-space:nowrap}
.tg-quem .det{display:block;margin-top:1px;font-size:13px;color:var(--tg-sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.tg-sem{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:12.5px;font-weight:500;color:var(--tg-sec)}
.tg-sem::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ponto)}
.tg-sem.v{--ponto:#d9304f}.tg-sem.a{--ponto:#e5a100}.tg-sem.g{--ponto:#30a46c}
.tg-btns{display:flex;gap:8px;justify-content:flex-end}
.tg-mais{margin-top:8px}
.tg-vazio{margin:0;padding:12px 0;border-top:1px solid var(--tg-b);color:var(--tg-sec)}
.tg-vazio b{color:var(--tg-txt);font-weight:600}
.tg-erro{padding:4px 0}
.tg-erro b{display:block;font-size:15px;margin-bottom:4px}
.tg-erro p{margin:0 0 12px;color:var(--tg-sec)}
.tg-barra{display:flex;gap:2px;height:10px;margin:8px 0 10px}
.tg-barra i{display:block;min-width:3px;border-radius:3px}
.tg-leg{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0;padding:0;list-style:none;font-size:13px}
.tg-leg li{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.tg-leg i{width:8px;height:8px;border-radius:2px;flex:none}
.tg-leg b{font-weight:600}
.tg-leg small{color:var(--tg-mut);font-size:12.5px}
.tg-rolar{overflow-x:auto}
.tg-tab{width:100%;border-collapse:collapse;font-size:14px}
.tg-tab th{padding:8px 12px;text-align:right;font-size:12px;font-weight:500;color:var(--tg-sec);white-space:nowrap;border-bottom:1px solid var(--tg-b2)}
.tg-tab th:first-child,.tg-tab td:first-child{padding-left:0}
.tg-tab th:last-child,.tg-tab td:last-child{padding-right:0}
.tg-tab th.t,.tg-tab td.t{text-align:left}
.tg-tab td{padding:10px 12px;text-align:right;border-bottom:1px solid var(--tg-b);font-variant-numeric:tabular-nums;vertical-align:baseline}
.tg-tab td.num{width:28px;color:var(--tg-mut);text-align:left}
.tg-tab .cod{margin-left:6px;color:var(--tg-mut);font-size:12.5px}
.tg-tab tr.sem td{color:var(--tg-mut)}
.tg-tab tr.total td{font-weight:600;border-top:1px solid var(--tg-b2);border-bottom:0}
.tg-nulo{color:var(--tg-mut)}
.tg-nota{margin:8px 0 0;font-size:12.5px;color:var(--tg-mut);line-height:1.45}
.tg-lista{margin:0;padding:0;list-style:none}
.tg-lista li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--tg-b);font-variant-numeric:tabular-nums}
.tg-lista li span:last-child{font-weight:600}
.tg-def{font-size:13px;color:var(--tg-sec)}
.tg-def summary{cursor:pointer;min-height:28px;display:flex;align-items:center;gap:6px;color:var(--tg-sec);list-style:none}
.tg-def summary::-webkit-details-marker{display:none}
.tg-def summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}
.tg-def[open]>summary::before{transform:rotate(45deg)}
.tg-def summary:hover{color:var(--tg-txt)}
.tg-def ul{margin:6px 0 0;padding-left:18px}
.tg-def li{margin:3px 0}
.tg-graf{position:relative}
.tg-graf svg{display:block;width:100%;height:auto;overflow:visible}
.tg-graf text{font-family:inherit;font-size:11px;fill:#60646c}
.tg-dica{position:absolute;z-index:2;pointer-events:none;min-width:130px;padding:8px 10px;border:1px solid var(--tg-b2);border-radius:6px;background:#fff;box-shadow:0 2px 8px rgba(28,32,36,.12);font-size:12.5px;line-height:1.5;font-variant-numeric:tabular-nums}
.tg-dica b{display:block;margin-bottom:2px}
.tg-dica span{display:flex;align-items:center;gap:6px}
.tg-dica i{width:8px;height:8px;border-radius:2px;flex:none}
.tg-dica em{font-style:normal;margin-left:auto;padding-left:14px;font-weight:600}
.tg-tabdia{width:100%;margin-top:6px;border-collapse:collapse;font-variant-numeric:tabular-nums}
.tg-tabdia th,.tg-tabdia td{padding:5px 8px;border-bottom:1px solid var(--tg-b);text-align:right}
.tg-tabdia th:first-child,.tg-tabdia td:first-child{text-align:left;padding-left:0}
.tg-sk{display:block;border-radius:6px;background:linear-gradient(90deg,#f0f0f3 0,#f9f9fb 40%,#f0f0f3 80%);background-size:300% 100%;animation:brilho 1.2s ease-in-out infinite}
.tg-sk.k{height:88px;border-radius:8px}.tg-sk.s{height:14px;margin-top:12px}.tg-sk.t{height:40px;width:100%}
.tg-impr{display:none}
.tg :focus-visible{outline:2px solid var(--tg-azul);outline-offset:2px}
@media (max-width:640px){
  .quadro.tg{padding:12px 14px 40px}
  .tg>*+*{margin-top:20px}
  .tg-abas{width:100%;flex-wrap:nowrap;gap:0}
  .tg-abas button{flex:1 1 auto;padding:0 2px;font-size:13px;min-height:44px}
  .tg-abas button[aria-pressed=true]::after{left:2px;right:2px}
  .tg-lado{width:100%;justify-content:space-between;padding-bottom:8px}
  .tg-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .tg-kpi{padding:12px 12px 10px}.tg-kpi .v{font-size:20px}
  .tg-kpi.largo,.tg-kpis .tg-kpi:last-child:nth-child(odd){grid-column:1/-1}
  .tg-lin{grid-template-columns:1fr}
  .tg-quem .det{white-space:normal}
  .tg-btns .tg-bt{flex:1;min-height:40px}
  .tg-bt{min-height:40px}
  .tg-tab thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .tg-tab,.tg-tab tbody{display:block;width:100%}
  .tg-tab tr{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;padding:12px 0;border-bottom:1px solid var(--tg-b)}
  .tg-tab tr.total{border-top:1px solid var(--tg-b2);border-bottom:0}
  .tg-tab td{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:0!important;border:0!important;text-align:left;min-width:0}
  .tg-tab td::before{content:attr(data-r);color:var(--tg-sec);font-size:12px;font-weight:400}
  .tg-tab td.t{grid-column:1/-1;display:block;padding-bottom:2px!important;font-weight:600}
  .tg-tab td.t::before,.tg-tab td.num{display:none}
}
@media print{
  @page{size:A4;margin:12mm}
  html,body{height:auto!important;overflow:visible!important;display:block!important;background:#fff!important}
  .topo,.tg-lado,.tg-abas,.tg-mais,.no-print,#caixa,.tg-def summary{display:none!important}
  .quadro.tg{display:block!important;overflow:visible!important;padding:0!important}
  .tg>*{max-width:none}
  .tg-impr{display:block;margin:0 0 8px;color:#60646c;font-size:12px}
  .tg-sec,.tg-kpis{break-inside:avoid}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
@media (prefers-reduced-motion:reduce){.tg-sk{animation:none}}
`;

export const TELAS_JS = String.raw`
  // ── Oportunidades · Marketing · Gestor (13/11/2026) ───────────────────────────────────────────────────────────
  var TG={periodo:{mkt:'fimdia',gestor:'mes'},n:0,mostrar:{},visto:null};
  var PERIODOS=[['manha','Manhã'],['fimdia','Fim do dia'],['semana','Semana'],['quinzena','Quinzena'],['mes','Mês']];
  try{ var tgp=JSON.parse(localStorage.getItem('tg:periodo')||'{}')||{}; ['mkt','gestor'].forEach(function(k){ if(PERIODOS.some(function(p){ return p[0]===tgp[k]; })) TG.periodo[k]=tgp[k]; }); }catch(e){}
  function tgGuardar(){ try{ localStorage.setItem('tg:periodo',JSON.stringify(TG.periodo)); }catch(e){} }
  function nbr(n){ return Number(n||0).toLocaleString('pt-BR'); }
  // dinheiro: nos números grandes, reais inteiros; na tabela, centavos só quando existem (centavos=true)
  function dinheiro(v,moeda,centavos){
    if(v===null||v===undefined) return '—';
    var cod=(moeda&&/^[A-Z]{3}$/.test(moeda))?moeda:'BRL', inteiro=!centavos||Math.abs(v-Math.round(v))<0.005, f=inteiro?0:2;
    try{ return Number(inteiro?Math.round(v):v).toLocaleString('pt-BR',{style:'currency',currency:cod,minimumFractionDigits:f,maximumFractionDigits:f}); }catch(e){ return 'R$ '+Number(v).toFixed(f); }
  }
  function vezes(v){ return v===null||v===undefined?'—':Number(v).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'x'; }
  function dmBelem(iso){ return iso? iso.slice(8,10)+'/'+iso.slice(5,7) : ''; }
  function fmtTel(t){
    var d=String(t||'').replace(/[^0-9]/g,'');
    if(d.length===13&&d.indexOf('55')===0) return '+55 ('+d.slice(2,4)+') '+d.slice(4,9)+'-'+d.slice(9);
    if(d.length===12&&d.indexOf('55')===0) return '+55 ('+d.slice(2,4)+') '+d.slice(4,8)+'-'+d.slice(8);
    return t||'';
  }
  var NS_TG='http://www.w3.org/2000/svg';
  function icTg(caminhos){ var v=document.createElementNS(NS_TG,'svg'); v.setAttribute('viewBox','0 0 24 24'); v.setAttribute('width','14'); v.setAttribute('height','14'); v.setAttribute('fill','none'); v.setAttribute('stroke','currentColor'); v.setAttribute('stroke-width','2'); v.setAttribute('stroke-linecap','round'); v.setAttribute('stroke-linejoin','round'); v.setAttribute('aria-hidden','true'); caminhos.forEach(function(d){ var p=document.createElementNS(NS_TG,'path'); p.setAttribute('d',d); v.appendChild(p); }); return v; }
  var IC_FONE=['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z'];
  var IC_PDF=['M12 3v12','m7 10 5 5 5-5','M5 21h14'];

  function tgBotao(texto,classe,aoClicar,icone){
    var b=el('button','tg-bt'+(classe?' '+classe:'')); b.type='button';
    if(icone) b.appendChild(icTg(icone));
    b.appendChild(document.createTextNode(texto)); b.onclick=aoClicar; return b;
  }
  // a faixa do topo: as abas de período (estilo das abas do Chatwoot) e, à direita, as datas e o PDF
  function tgTopo(d,comPdf,titulo){
    var t=el('div','tg-topo'), ab=el('div','tg-abas'); ab.setAttribute('role','group'); ab.setAttribute('aria-label','Período');
    PERIODOS.forEach(function(p){ if(p[0]==='manha'&&TELA==='gestor') return; var b=el('button',null,p[1]); b.type='button'; b.setAttribute('aria-pressed',String(TG.periodo[TELA]===p[0])); b.title=p[0]==='manha'?'Da noite de ontem (18h) até agora':p[0]==='fimdia'?'De hoje, 0h, até agora':p[0]==='semana'?'Os últimos 7 dias':p[0]==='quinzena'?'Os últimos 15 dias':'Do dia 1 do mês até hoje';
      b.onclick=function(){ if(TG.periodo[TELA]===p[0]) return; TG.periodo[TELA]=p[0]; tgGuardar(); TG.visto=null; carregar(); }; ab.appendChild(b); });
    t.appendChild(ab);
    var ld=el('div','tg-lado'); ld.appendChild(el('span',null,dmBelem(d.periodo.de)+(d.periodo.de!==d.periodo.ate?' a '+dmBelem(d.periodo.ate):'')));
    if(comPdf) ld.appendChild(tgBotao('Baixar PDF','',function(){ imprimirTela(titulo); },IC_PDF));
    t.appendChild(ld); return t;
  }
  // PDF = a janela de impressão do navegador («Salvar como PDF»), com folha de estilo própria; o nome do arquivo vem do título da página
  function imprimirTela(titulo){
    var antes=document.title, hoje=new Date(), d=hoje.getFullYear()+'-'+doisd(hoje.getMonth()+1)+'-'+doisd(hoje.getDate());
    document.title=titulo+' '+d;
    var volta=function(){ document.title=antes; window.removeEventListener('afterprint',volta); };
    window.addEventListener('afterprint',volta);
    msg('Na janela que abrir, escolha «Salvar como PDF».');
    setTimeout(function(){ try{ window.print(); }catch(e){ msg('Seu navegador não abriu a impressão.'); } setTimeout(function(){ msg(''); },4000); },60);
  }
  function tgImpr(d,titulo){ return el('p','tg-impr',titulo+' · '+d.periodo.rotulo+' ('+dmBelem(d.periodo.de)+' a '+dmBelem(d.periodo.ate)+') · gerado em '+new Date().toLocaleString('pt-BR')); }
  function tgAvisos(lista,tipo){ return (lista||[]).map(function(t){ var a=el('div','tg-aviso'+(tipo?' '+tipo:'')); a.setAttribute('role','status'); a.textContent=t; return a; }); }
  function tgVazio(titulo,texto){ var v=el('p','tg-vazio'); v.appendChild(el('b',null,titulo+' ')); v.appendChild(document.createTextNode(texto||'')); return v; }
  // variação contra o período anterior: seta + % + «vs ontem». boa: 'subir' (subir é bom), 'descer' (descer é bom) ou null (neutro).
  function variacao(atual,ant,boa,rotulo){
    var d=el('span','d');
    if(atual===null||atual===undefined||ant===null||ant===undefined||!isFinite(ant)||ant===0) return d;
    var pct=Math.round((atual-ant)*100/Math.abs(ant)), mod=Math.abs(pct);
    if(mod===0){ d.textContent='= igual'; d.appendChild(el('i',null,rotulo)); return d; }
    d.textContent=(pct>0?'↑ ':'↓ ')+(mod>999?'+999':nbr(mod))+'%'; d.appendChild(el('i',null,rotulo));
    if(boa) d.className='d '+(((pct>0)===(boa==='subir'))?'bom':'ruim');
    return d;
  }
  function tgKpi(rotulo,valor,definicao,extra,opcoes){
    opcoes=opcoes||{};
    var k=el('div','tg-kpi'+(opcoes.largo?' largo':'')), r=el('span','r',rotulo); if(definicao) r.title=definicao; k.appendChild(r);
    k.appendChild(el('span','v'+(opcoes.nulo?' nulo':'')+(opcoes.conectar?' conectar':''),valor));
    k.appendChild(extra||el('span','d')); return k;
  }
  function textoD(t){ return el('span','d',t); }
  function tgBase(){ var qd=$('quadro'); qd.className='quadro tg'; return qd; }
  function tgEsqueleto(){
    var qd=tgBase(); qd.textContent=''; qd.setAttribute('aria-busy','true');
    qd.appendChild(el('span','tg-sk t'));
    var g=el('div','tg-kpis'); for(var i=0;i<(TELA==='oport'?3:5);i++) g.appendChild(el('span','tg-sk k')); qd.appendChild(g);
    var b=el('div'); for(var j=0;j<6;j++) b.appendChild(el('span','tg-sk s')); qd.appendChild(b);
  }
  function desenharErroTela(e){
    var qd=tgBase(); qd.removeAttribute('aria-busy'); qd.textContent='';
    var er=el('div','tg-erro'); er.setAttribute('role','alert');
    if(e&&e.semPermissao){
      er.appendChild(el('b',null,'Esta tela é só para a gestão')); er.appendChild(el('p',null,'Seu usuário não tem acesso a ela. Se você precisa, peça para a Suzanne liberar.')); qd.appendChild(er); return;
    }
    er.appendChild(el('b',null,'Não consegui carregar esta tela')); er.appendChild(el('p',null,(e&&e.message)||'Tente de novo em instantes.'));
    er.appendChild(tgBotao('Tentar de novo','pri',function(){ TG.visto=null; carregar(); })); qd.appendChild(er);
  }
  async function carregarTela(){
    var meu=++TG.n, qd=$('quadro');
    if(TG.visto!==TELA+'|'+(TELA==='oport'?'':TG.periodo[TELA])) tgEsqueleto();
    try{
      var rota=TELA==='oport'?'oportunidades':TELA==='mkt'?'marketing':'gestor';
      var d=await api('GET',rota+(TELA==='oport'?'':'?periodo='+encodeURIComponent(TG.periodo[TELA])));
      if(meu!==TG.n) return;
      var y=qd.scrollTop; qd.removeAttribute('aria-busy');
      atualizadoEm=Date.now(); $('atual').textContent='atualizado agora'; msg('');
      dados=dados||{}; dados.chatwoot=d.chatwoot||dados.chatwoot; dados.conta=d.conta||dados.conta;
      if(TELA==='oport') desenharOport(d); else if(TELA==='mkt') desenharMkt(d); else desenharGestor(d);
      TG.visto=TELA+'|'+(TELA==='oport'?'':TG.periodo[TELA]); TG.ultimo=d; qd.scrollTop=y;
    }catch(e){ if(meu!==TG.n) return; if(TG.visto&&!(e&&e.semPermissao)){ msg(e.message); return; } desenharErroTela(e); }
  }
  // o gráfico é desenhado na largura real da janela: ao girar o celular ou mudar o tamanho, redesenha
  var tgRedim=null;
  window.addEventListener('resize',function(){ if(TELA!=='gestor'||!TG.ultimo) return; clearTimeout(tgRedim); tgRedim=setTimeout(function(){ var y=$('quadro').scrollTop; desenharGestor(TG.ultimo); $('quadro').scrollTop=y; },200); });
  function definicoes(itens,titulo){ var dt=el('details','tg-def no-print'), s=el('summary',null,titulo||'Como cada número é contado'); dt.appendChild(s); var ul=el('ul'); itens.forEach(function(t){ ul.appendChild(el('li',null,t)); }); dt.appendChild(ul); return dt; }

  // ── Oportunidades ─────────────────────────────────────────────────────────
  var SEC_OP=[
    ['naoFecharam','Consultaram e não fecharam','Compareceram à consulta e ainda não fecharam o tratamento. O semáforo vem do contato; sem ele, dos dias desde a consulta (7 ou mais: vermelho; 3 a 6: amarelo).'],
    ['retorno60','Retorno de 2 meses','Alta há 60 dias ou mais: hora de sugerir a reavaliação.'],
    ['verDepois','Ficou de ver depois','Pediram um tempo (etiqueta ficou-de-ver-depois) ou a data de retomar já chegou.'],
    ['pagouAntecipado','Pagou antecipado','Etiqueta pagou-antecipado e consulta por vir.']
  ];
  var PILULA={Vermelho:'v',Amarelo:'a',Verde:'g'}, LIMITE_LISTA=6;
  function linhaOp(i,tipo){
    var l=el('div','tg-lin'), q=el('div','tg-quem'), nm=el('div','nm');
    nm.appendChild(el('span',null,i.nome));
    if(i.semaforo){ var p=el('span','tg-sem '+PILULA[i.semaforo],i.semaforo); p.title='Semáforo: '+i.semaforo; nm.appendChild(p); }
    var det=el('span','det',i.detalhe); if(i.telefone){ det.appendChild(document.createTextNode(' · ')); det.appendChild(el('span','fone',fmtTel(i.telefone))); }
    q.appendChild(nm); q.appendChild(det);
    l.appendChild(q);
    var bs=el('div','tg-btns');
    if(tipo==='naoFecharam'){
      if(i.telefone){ var a=el('a','tg-bt'); a.href='tel:'+i.telefone.replace(/[^0-9+]/g,''); a.appendChild(icTg(IC_FONE)); a.appendChild(document.createTextNode('Ligar')); a.setAttribute('aria-label','Ligar para '+i.nome+', '+fmtTel(i.telefone)); bs.appendChild(a); }
      else { var sa=el('span','tg-bt','Sem telefone'); sa.setAttribute('aria-disabled','true'); bs.appendChild(sa); }
      bs.appendChild(tgBotao('Mensagem','',function(){ abrirConversa(i.id); }));
    } else if(tipo==='retorno60') bs.appendChild(tgBotao('Agendar retorno','azul',function(){ abrirConversa(i.id); }));
    else if(tipo==='verDepois') bs.appendChild(tgBotao('Abrir conversa','',function(){ abrirConversa(i.id); }));
    else bs.appendChild(tgBotao('Confirmar','',function(){ abrirConversa(i.id); }));
    l.appendChild(bs); return l;
  }
  function desenharOport(d){
    var qd=tgBase(); qd.textContent='';
    var total=0; SEC_OP.forEach(function(s){ total+=d.totais[s[0]]; });
    qd.appendChild(el('p','tg-meta',total?nbr(total)+(total===1?' pessoa para contatar hoje':' pessoas para contatar hoje'):'Nenhuma oportunidade na fila agora.'));
    SEC_OP.forEach(function(s){
      var itens=d[s[0]]||[], n=d.totais[s[0]]||0, sec=el('section','tg-sec'), h=el('h3',null,s[1]); h.title=s[2];
      h.appendChild(el('span','c',nbr(n))); sec.appendChild(h);
      if(!itens.length) sec.appendChild(tgVazio('Ninguém nesta lista agora.','Quando alguém entrar nela, aparece aqui.'));
      var aberta=!!TG.mostrar[s[0]];
      itens.forEach(function(i,ix){ if(aberta||ix<LIMITE_LISTA) sec.appendChild(linhaOp(i,s[0])); });
      if(itens.length>LIMITE_LISTA){
        var rotuloMais=aberta?'Mostrar menos':'Mostrar todos ('+nbr(itens.length)+(n>itens.length?', de '+nbr(n):'')+')';
        sec.appendChild(tgBotao(rotuloMais,'tg-mais',function(){ TG.mostrar[s[0]]=!aberta; desenharOport(d); }));
      }
      qd.appendChild(sec);
    });
    qd.appendChild(definicoes(SEC_OP.map(function(s){ return s[1]+': '+s[2]; }).concat(['Só aparecem as conversas das caixas que o seu usuário enxerga. «Ligar» usa o telefone do contato; «Mensagem», «Agendar retorno», «Abrir conversa» e «Confirmar» abrem a conversa no Chatwoot. Nada daqui manda mensagem para paciente.']),'Como cada lista é montada'));
  }

  // ── tabelas ───────────────────────────────────────────────────────────────
  function tabela(colunas,linhas){
    var rol=el('div','tg-rolar'), t=el('table','tg-tab'), th=el('thead'), tr=el('tr');
    colunas.forEach(function(c){ var h=el('th',c.t?'t':null,c.texto); h.scope='col'; tr.appendChild(h); });
    th.appendChild(tr); t.appendChild(th); var tb=el('tbody'); linhas.forEach(function(l){ tb.appendChild(l); }); t.appendChild(tb); rol.appendChild(t); return rol;
  }
  function celula(tr,rotulo,conteudo,classe){ var td=el('td',classe||''); td.setAttribute('data-r',rotulo); if(conteudo&&conteudo.nodeType) td.appendChild(conteudo); else td.textContent=conteudo; tr.appendChild(td); return td; }
  // o nome da campanha é o principal; o código vem depois, pequeno e em cinza
  function nomeLinha(l){ var s=el('span'); s.appendChild(document.createTextNode(l.titulo)); if(l.codigo) s.appendChild(el('span','cod','· '+l.codigo)); return s; }

  // ── Anúncios na Meta (o resultado como a Meta conta; não depende de o lead estar no Chatwoot) ──
  var OBJETIVO={OUTCOME_ENGAGEMENT:'Engajamento',OUTCOME_LEADS:'Leads',OUTCOME_AWARENESS:'Reconhecimento',OUTCOME_TRAFFIC:'Tráfego',OUTCOME_SALES:'Vendas',OUTCOME_APP_PROMOTION:'App',MESSAGES:'Mensagens',LEAD_GENERATION:'Leads'};
  // a Meta guarda o WhatsApp sem o 9 (559484420153): celular do Brasil (local começando em 6–9) ganha o 9 de volta na tela
  function fmtWhats(n){ var d=String(n||'').replace(/[^0-9]/g,''); if(d.length===12&&d.indexOf('55')===0&&/[6-9]/.test(d.charAt(4))) d=d.slice(0,4)+'9'+d.slice(4); return fmtTel(d); }
  function secaoMeta(m,rot){
    var s=el('section','tg-sec'), h=el('h3',null,'Anúncios na Meta'); h.title='Números lidos da conta de anúncios da unidade, como o Gerenciador de Anúncios mostra.'; s.appendChild(h);
    if(m.estado!=='ok'){ s.appendChild(tgVazio(m.estado==='conectar'?'Conta de anúncios não ligada.':'A Meta não respondeu.',m.motivo||'')); return s; }
    var t=m.total, a=m.anterior, mo=m.moeda, k=el('div','tg-kpis');
    k.appendChild(tgKpi('Investido',dinheiro(t.gasto,mo),'Quanto a conta de anúncios gastou no período.',a?variacao(t.gasto,a.gasto,null,rot):null));
    k.appendChild(tgKpi('Conversas iniciadas',nbr(t.conversas),'Conversas no WhatsApp que a Meta atribui aos anúncios (resultado das campanhas de mensagem).',a?variacao(t.conversas,a.conversas,'subir',rot):null));
    k.appendChild(tgKpi('Custo por conversa',dinheiro(t.custoPorConversa,mo,true),'Investido ÷ conversas iniciadas.',a?variacao(t.custoPorConversa,a.custoPorConversa,'descer',rot):null,{nulo:t.custoPorConversa===null}));
    k.appendChild(tgKpi('Leads (Meta)',nbr(t.leads),'O que a Meta conta como lead: cadastro no site pelo pixel, formulário da Meta ou lead marcado na conversa do WhatsApp.',a?variacao(t.leads,a.leads,'subir',rot):null));
    s.appendChild(k);
    if(m.numerosForaDoChatwoot&&m.numerosForaDoChatwoot.length){
      tgAvisos(['Os anúncios levam para o WhatsApp '+m.numerosForaDoChatwoot.map(fmtWhats).join(' e ')+', que não está no Chatwoot. As conversas desses anúncios não entram nos números de cima nem no rastreio abaixo; aqui aparecem como a Meta conta.']).forEach(function(x){ s.appendChild(x); });
    }
    if(!m.campanhas.length){ s.appendChild(tgVazio('Nenhuma campanha gastou neste período.','')); return s; }
    var linhas=m.campanhas.map(function(cp){
      var tr=el('tr'), nm=el('span'); nm.appendChild(document.createTextNode(cp.nome));
      var sub=[OBJETIVO[cp.objetivo]||'', cp.destinos.length?'→ '+cp.destinos.map(fmtWhats).join(', '):''].filter(Boolean).join(' · ');
      if(sub) nm.appendChild(el('span','cod','· '+sub));
      if(cp.foraDoChatwoot){ var f=el('span','cod',' · fora do Chatwoot'); f.title='O número de destino não é uma caixa do Chatwoot.'; nm.appendChild(f); }
      celula(tr,'Campanha',nm,'t'); celula(tr,'Investido',dinheiro(cp.gasto,mo,true)); celula(tr,'Conversas',nbr(cp.conversas)); celula(tr,'Custo/conversa',dinheiro(cp.custoPorConversa,mo,true)); celula(tr,'Leads',nbr(cp.leads));
      return tr;
    });
    var tt=el('tr','total'); celula(tt,'Campanha','Total','t'); celula(tt,'Investido',dinheiro(t.gasto,mo,true)); celula(tt,'Conversas',nbr(t.conversas)); celula(tt,'Custo/conversa',dinheiro(t.custoPorConversa,mo,true)); celula(tt,'Leads',nbr(t.leads)); linhas.push(tt);
    s.appendChild(tabela([{texto:'Campanha',t:1},{texto:'Investido'},{texto:'Conversas'},{texto:'Custo/conversa'},{texto:'Leads'}],linhas));
    if(m.motivo) s.appendChild(el('p','tg-nota',m.motivo));
    return s;
  }

  // ── Marketing ─────────────────────────────────────────────────────────────
  var QUAL=[['quente','Quente','var(--tg-q)'],['morno','Morno','var(--tg-m)'],['frio','Frio','var(--tg-f)'],['semQualificacao','Sem qualificação','var(--tg-n)']];
  function desenharMkt(d){
    var qd=tgBase(); qd.textContent='';
    qd.appendChild(tgTopo(d,true,'Relatório do marketing')); qd.appendChild(tgImpr(d,'Relatório do marketing'));
    tgAvisos(d.avisos).forEach(function(a){ qd.appendChild(a); });
    var c=d.cartoes, an=d.anterior, rot=d.periodo.rotuloAnterior, k=el('div','tg-kpis');
    k.appendChild(tgKpi('Amanheceram',nbr(c.amanheceram),'Conversas criadas dentro do período (horário de Belém).',an?variacao(c.amanheceram,an.amanheceram,null,rot):null));
    k.appendChild(tgKpi('Interagiram',nbr(c.interagiram),'Os que não estão em «Não interagiram».',an?variacao(c.interagiram,an.interagiram,'subir',rot):null));
    k.appendChild(tgKpi('Não interagiram',nbr(c.naoInteragiram),'Sem resposta há mais de 24 h, ou com a etiqueta sem-resposta (a mesma regra da tela Hoje).',an?variacao(c.naoInteragiram,an.naoInteragiram,'descer',rot):null));
    k.appendChild(tgKpi('Agendaram',nbr(c.agendaram),'Conversas que entraram em Agendado dentro do período.',an?variacao(c.agendaram,an.agendaram,'subir',rot):null));
    k.appendChild(tgKpi('Pagaram antecipado',nbr(c.pagaramAntecipado),'Conversas com a etiqueta pagou-antecipado e atividade dentro do período.'));
    qd.appendChild(k);
    if(d.meta) qd.appendChild(secaoMeta(d.meta,rot));

    var q=d.qualificacao, tq=q.quente+q.morno+q.frio+q.semQualificacao, sq=el('section','tg-sec'), hq=el('h3',null,'Qualificação'); hq.appendChild(el('span','c',nbr(tq)+' leads')); sq.appendChild(hq);
    if(!tq) sq.appendChild(tgVazio('Nenhum lead novo neste período.','Escolha um período maior para ver a qualificação.'));
    else{
      var bar=el('div','tg-barra'); bar.setAttribute('role','img');
      bar.setAttribute('aria-label',QUAL.map(function(x){ return x[1]+' '+q[x[0]]; }).join(', '));
      QUAL.forEach(function(x){ if(q[x[0]]){ var s=el('i'); s.style.flex=String(q[x[0]]); s.style.background=x[2]; s.title=x[1]+': '+q[x[0]]; bar.appendChild(s); } });
      sq.appendChild(bar);
      var lg=el('ul','tg-leg'); QUAL.forEach(function(x){ var li=el('li'); var sw=el('i'); sw.style.background=x[2]; li.appendChild(sw); li.appendChild(el('span',null,x[1])); li.appendChild(el('b',null,nbr(q[x[0]]))); li.appendChild(el('small',null,Math.round(q[x[0]]*100/tq)+'%')); lg.appendChild(li); });
      sq.appendChild(lg);
    }
    qd.appendChild(sq);

    var sc=el('section','tg-sec'); sc.appendChild(el('h3',null,'Rastreio das campanhas (numerado)'));
    function linhaMkt(l,i,classe){
      var tr=el('tr',classe||''); celula(tr,'#',i?String(i):'','num'); celula(tr,'Anúncio',i?nomeLinha(l):l.titulo,'t'); celula(tr,'Leads',nbr(l.leads)); celula(tr,'Quentes',nbr(l.quentes)); celula(tr,'Agendou',nbr(l.agendou)); celula(tr,'Fechou',nbr(l.fechou));
      celula(tr,'% frio',l.pctFrio===null?'—':l.pctFrio+'%'); return tr;
    }
    var linhas=d.campanhas.map(function(l,i){ return linhaMkt(l,i+1); });
    linhas.push(linhaMkt(d.semCampanha,0,'sem')); linhas.push(linhaMkt(d.total,0,'total'));
    if(!c.amanheceram) sc.appendChild(tgVazio('Nenhum lead novo neste período.','Quando chegarem conversas, cada anúncio aparece numa linha.'));
    else{
      sc.appendChild(tabela([{texto:'#'},{texto:'Anúncio',t:1},{texto:'Leads'},{texto:'Quentes'},{texto:'Agendou'},{texto:'Fechou'},{texto:'% frio'}],linhas));
      if(!d.campanhas.length) sc.appendChild(el('p','tg-nota','Nenhum lead deste período trouxe a campanha gravada ainda. A campanha vem do anúncio «Clique para o WhatsApp» (referral da Meta na 1ª mensagem) ou do código gravado no contato.'));
      if(d.campanhasOmitidas) sc.appendChild(el('p','tg-nota','Mais '+nbr(d.campanhasOmitidas)+' anúncio(s) com menos leads não aparecem na tabela (o total os inclui).'));
    }
    qd.appendChild(sc);

    var sa=el('section','tg-sec'), ha=el('h3',null,'Quem agendou'); sa.appendChild(ha);
    if(!d.quemAgendou.length) sa.appendChild(tgVazio('Ninguém agendou neste período.','Quando uma conversa entrar em Agendado, aparece aqui.'));
    else{ var ul=el('ul','tg-lista'); d.quemAgendou.forEach(function(x){ var li=el('li'); li.appendChild(el('span',null,x.quem)); li.appendChild(el('span',null,nbr(x.agendamentos))); ul.appendChild(li); }); sa.appendChild(ul); }
    var fl=el('p','tg-nota','Faltaram ontem: '+nbr(d.faltaramOntem)+'.'); sa.appendChild(fl);
    if(d.registroDesde&&d.registroDesde>d.periodo.de) sa.appendChild(el('p','tg-nota','Os agendamentos só são contados desde '+dmBelem(d.registroDesde)+', quando a régua começou a anotar. Antes disso o número fica abaixo do real.'));
    qd.appendChild(sa);
    qd.appendChild(definicoes([
      'Amanheceram: conversas criadas dentro do período (horário de Belém). Não interagiram: mesma regra da tela Hoje.',
      'Agendaram: conversas que entraram em Agendado dentro do período (memória da régua). Pagaram antecipado: etiqueta pagou-antecipado com atividade no período.',
      'Rastreio: a campanha é lida da 1ª mensagem do paciente (referral do anúncio); sem ela, do código gravado no contato. «Agendou» e «Fechou» da tabela são o estado de hoje dos leads que chegaram no período.',
      'Anúncios na Meta: lidos da conta de anúncios da unidade (o mesmo que o Gerenciador de Anúncios mostra). Conversas iniciadas = resultado das campanhas de WhatsApp; Leads (Meta) = o que a Meta conta como lead (cadastro no site pelo pixel, formulário da Meta ou lead marcado na conversa). A Meta separa por dia: na aba Manhã ela soma ontem e hoje inteiros. Vale mesmo quando o anúncio leva para um número que não está no Chatwoot.',
      'A variação compara com o período anterior do mesmo tamanho; não aparece quando a leitura das conversas foi cortada.',
      'Só entram as caixas das unidades que o seu usuário enxerga.'
    ]));
  }

  // ── gráfico: investido × faturado por dia ─────────────────────────────────
  var COR_FAT='#2f6fd6', COR_INV='#c77700';
  function passoBonito(max,alvo){
    var bruto=max/alvo, mag=Math.pow(10,Math.floor(Math.log(bruto)/Math.LN10)), f=bruto/mag, m=f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10; return m*mag;
  }
  function eixo(v){ return v>=1000?'R$ '+(v/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})+' mil':'R$ '+Math.round(v); }
  function svgEl(t,a){ var e=document.createElementNS(NS_TG,t); for(var k in a) e.setAttribute(k,a[k]); return e; }
  function graficoDiario(serie,moeda){
    var temInv=serie.some(function(s){ return s.investido!==null; }), temFat=serie.some(function(s){ return s.faturado!==null; });
    var max=0; serie.forEach(function(s){ max=Math.max(max,s.faturado||0,s.investido||0); });
    if(!max) return null;
    var W=Math.max(300,Math.min(1120,($('quadro').clientWidth||800)-(window.innerWidth<=640?28:48))),H=W<500?190:210,mE=W<500?46:58,mD=6,mT=8,mB=24, passo=passoBonito(max,4), topo=Math.ceil(max/passo)*passo, pw=W-mE-mD, ph=H-mT-mB, n=serie.length, gw=pw/n;
    var wrap=el('div','tg-graf'), svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H,role:'img','aria-label':'Gráfico de barras: investido e faturado por dia'});
    function Y(v){ return mT+ph-(v/topo)*ph; }
    for(var v=0;v<=topo+0.001;v+=passo){
      svg.appendChild(svgEl('line',{x1:mE,x2:W-mD,y1:Y(v),y2:Y(v),stroke:v===0?'#d9d9e0':'#eeeef1','stroke-width':1}));
      var tx=svgEl('text',{x:mE-8,y:Y(v)+4,'text-anchor':'end'}); tx.textContent=eixo(v); svg.appendChild(tx);
    }
    var barras=(temInv?1:0)+(temFat?1:0), bw=Math.max(3,Math.min(16,(gw-6)/barras-2)), cada=Math.ceil(n/10);
    var dica=el('div','tg-dica'); dica.hidden=true;
    serie.forEach(function(s,i){
      var cx=mE+gw*i+gw/2, x0=cx-(barras*bw+(barras-1)*2)/2, k=0;
      [['faturado',COR_FAT,'Faturado'],['investido',COR_INV,'Investido']].forEach(function(sr){
        if(s[sr[0]]===null) return; var h=Math.max(0,(s[sr[0]]/topo)*ph);
        if(h>0) svg.appendChild(svgEl('rect',{x:x0+k*(bw+2),y:mT+ph-h,width:bw,height:h,rx:2,fill:sr[1]}));
        k++;
      });
      if(i%cada===0){ var lb=svgEl('text',{x:cx,y:H-6,'text-anchor':'middle'}); lb.textContent=s.dia.slice(8,10); svg.appendChild(lb); }
      var sob=svgEl('rect',{x:mE+gw*i,y:mT,width:gw,height:ph,fill:'transparent'});
      var tt=svgEl('title',{}); tt.textContent=dmBelem(s.dia)+' · faturado '+dinheiro(s.faturado,'BRL')+(temInv?' · investido '+dinheiro(s.investido,moeda):''); sob.appendChild(tt);
      sob.addEventListener('mouseenter',function(){
        dica.textContent=''; dica.appendChild(el('b',null,dmBelem(s.dia)));
        [['faturado',COR_FAT,'Faturado'],['investido',COR_INV,'Investido']].forEach(function(sr){ if(s[sr[0]]===null) return; var li=el('span'); var sw=el('i'); sw.style.background=sr[1]; li.appendChild(sw); li.appendChild(document.createTextNode(sr[2])); li.appendChild(el('em',null,dinheiro(s[sr[0]],sr[0]==='investido'?moeda:'BRL',true))); dica.appendChild(li); });
        dica.hidden=false; var pos=(cx/W)*100; dica.style.left=pos>60?'auto':'calc('+pos+'% + 10px)'; dica.style.right=pos>60?'calc('+(100-pos)+'% + 10px)':'auto'; dica.style.top='0';
      });
      sob.addEventListener('mouseleave',function(){ dica.hidden=true; });
      svg.appendChild(sob);
    });
    wrap.appendChild(svg); wrap.appendChild(dica); return wrap;
  }
  function legendaGrafico(temInv){
    var lg=el('div','dir'); [['Faturado',COR_FAT],temInv?['Investido',COR_INV]:null].forEach(function(x){ if(!x) return; var s=el('span'); var i=el('i'); i.style.cssText='display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:'+x[1]; s.appendChild(i); s.appendChild(document.createTextNode(x[0])); lg.appendChild(s); }); return lg;
  }
  function tabelaDoGrafico(serie,moeda,temInv){
    var dt=el('details','tg-def no-print'); dt.appendChild(el('summary',null,'Ver como tabela'));
    var t=el('table','tg-tabdia'), th=el('tr'); ['Dia','Faturado'].concat(temInv?['Investido']:[]).forEach(function(x){ th.appendChild(el('th',null,x)); }); t.appendChild(th);
    serie.forEach(function(s){ var tr=el('tr'); tr.appendChild(el('td',null,dmBelem(s.dia))); tr.appendChild(el('td',null,dinheiro(s.faturado,'BRL',true))); if(temInv) tr.appendChild(el('td',null,dinheiro(s.investido,moeda,true))); t.appendChild(tr); });
    dt.appendChild(t); return dt;
  }

  // ── Gestor ────────────────────────────────────────────────────────────────
  function desenharGestor(d){
    var qd=tgBase(); qd.textContent='';
    qd.appendChild(tgTopo(d,true,'Painel do gestor')); qd.appendChild(tgImpr(d,'Painel do gestor'));
    tgAvisos(d.avisos).forEach(function(a){ qd.appendChild(a); });
    var inv=d.investido, fat=d.faturado, ind=d.indicadores, an=d.anterior, ok=inv.estado==='ok', rot=d.periodo.rotuloAnterior, k=el('div','tg-kpis');
    if(ok) k.appendChild(tgKpi('Investido em tráfego',dinheiro(inv.valor,inv.moeda),'Quanto a conta de anúncios da Meta gastou no período.',an?variacao(inv.valor,an.investido,null,rot):null));
    else if(inv.estado==='conectar') k.appendChild(tgKpi('Investido em tráfego','Conectar a conta de anúncios','O investido vem da Meta. Falta ligar a conta de anúncios da unidade.',textoD('Falta ligar a Meta'),{conectar:true}));
    else k.appendChild(tgKpi('Investido em tráfego','—','O investido vem da Meta.',textoD('Meta indisponível agora'),{nulo:true}));
    k.appendChild(tgKpi('Faturado em tratamentos',dinheiro(fat.valor),fat.fonte==='franquia'?'Soma do preço dos tratamentos criados no período na franquia, sem cancelados. Inclui quem não veio de anúncio.':'Soma do valor fechado nas conversas dos leads do período (a franquia não respondeu).',fat.valor===null?textoD('Sem dado da franquia'):(an?variacao(fat.valor,an.faturado,'subir',rot):null),{nulo:fat.valor===null}));
    k.appendChild(tgKpi('Retorno',vezes(ind.retorno),'Faturado dividido pelo investido.',ind.retorno===null?textoD(ok?'Sem faturado':'Precisa do investido'):(an&&an.indicadores?variacao(ind.retorno,an.indicadores.retorno,'subir',rot):null),{nulo:ind.retorno===null}));
    k.appendChild(tgKpi('CAC',dinheiro(ind.cac),'Investido dividido pelos pacientes que fecharam, entre os leads que chegaram no período.',ind.cac===null?textoD(!ok?'Precisa do investido':'Ninguém fechou ainda'):(an&&an.indicadores?variacao(ind.cac,an.indicadores.cac,'descer',rot):null),{nulo:ind.cac===null}));
    k.appendChild(tgKpi('Custo por consulta',dinheiro(ind.custoPorConsulta),'Investido dividido pelas consultas agendadas, entre os leads que chegaram no período.',ind.custoPorConsulta===null?textoD(!ok?'Precisa do investido':'Nenhuma consulta agendada'):(an&&an.indicadores?variacao(ind.custoPorConsulta,an.indicadores.custoPorConsulta,'descer',rot):null),{nulo:ind.custoPorConsulta===null}));
    qd.appendChild(k);
    if(inv.estado==='conectar'||inv.estado==='erro'){
      var info=el('div','tg-aviso info'); info.setAttribute('role','status');
      info.textContent=(inv.motivo||'')+(inv.estado==='conectar'?' Enquanto isso o painel mostra o resto sem esse número.':''); qd.appendChild(info);
    } else if(inv.motivo){ var av=el('div','tg-aviso'); av.textContent='Investido: '+inv.motivo+'.'; qd.appendChild(av); }
    if(fat.motivo&&fat.valor!==null){ var av2=el('div','tg-aviso'); av2.textContent='Faturado: '+fat.motivo+'.'; qd.appendChild(av2); }

    // um gráfico só: investido × faturado por dia (mesma unidade, um eixo só). Só com 2 dias ou mais.
    if(d.serie&&d.serie.length){
      var sg=el('section','tg-sec'), hg=el('h3',null,'Investido e faturado por dia'), temInv=d.serie.some(function(s){ return s.investido!==null; });
      hg.appendChild(legendaGrafico(temInv)); sg.appendChild(hg);
      var gr=graficoDiario(d.serie,inv.moeda);
      if(gr){ sg.appendChild(gr); sg.appendChild(tabelaDoGrafico(d.serie,inv.moeda,temInv)); if(!temInv) sg.appendChild(el('p','tg-nota','O investido entra no gráfico quando a conta de anúncios for ligada.')); }
      else sg.appendChild(tgVazio('Sem faturamento nem investimento no período.','Os valores aparecem aqui por dia.'));
      qd.appendChild(sg);
    }

    var sc=el('section','tg-sec'); sc.appendChild(el('h3',null,'Por campanha'));
    function linhaGestor(l,classe){
      var tr=el('tr',classe||''); celula(tr,'Campanha',classe?l.titulo:nomeLinha(l),'t');
      celula(tr,'Investido',l.investido===null?'—':dinheiro(l.investido,inv.moeda,true)); celula(tr,'Leads',nbr(l.leads)); celula(tr,'Fechou',nbr(l.fechou));
      celula(tr,'Faturado',l.faturado?dinheiro(l.faturado,'BRL',true):'—'); celula(tr,'CAC',l.cac===null?'—':dinheiro(l.cac,inv.moeda,true));
      return tr;
    }
    var linhas=d.campanhas.map(function(l){ return linhaGestor(l); }); linhas.push(linhaGestor(d.semCampanha,'sem')); linhas.push(linhaGestor(d.total,'total'));
    if(!d.leads&&!d.campanhas.length) sc.appendChild(tgVazio('Nenhum lead novo neste período.','Escolha um período maior para ver as campanhas.'));
    else{
      sc.appendChild(tabela([{texto:'Campanha',t:1},{texto:'Investido'},{texto:'Leads'},{texto:'Fechou'},{texto:'Faturado'},{texto:'CAC'}],linhas));
      if(!d.campanhas.length) sc.appendChild(el('p','tg-nota','Nenhum lead deste período trouxe a campanha gravada ainda; todos estão em «Sem campanha gravada».'));
      if(d.campanhasOmitidas) sc.appendChild(el('p','tg-nota','Mais '+nbr(d.campanhasOmitidas)+' campanha(s) menores não aparecem na tabela (o total as inclui).'));
    }
    sc.appendChild(el('p','tg-nota','Investido vem da Meta; faturado vem do caixa do sistema, ligado ao paciente pela campanha gravada na conversa.'));
    qd.appendChild(sc);
    qd.appendChild(definicoes([
      'Investido: gasto da conta de anúncios da Meta no período. Faturado em tratamentos: preço dos tratamentos criados no período na franquia (sem cancelados); inclui quem não veio de anúncio.',
      'Retorno: faturado dividido pelo investido. CAC: investido dividido pelos pacientes que fecharam, entre os leads que chegaram no período. Custo por consulta: investido dividido pelas consultas agendadas, entre os mesmos leads.',
      'Na tabela, «Faturado» é o valor fechado nas conversas (' + dinheiro(d.faturadoDasConversas,'BRL',true) + ' no total) e «Fechou» é o estado de hoje dos leads do período.',
      'A variação compara com o período anterior do mesmo tamanho; não aparece quando a leitura das conversas foi cortada.',
      'Sem investido ligado, ou sem ninguém fechando, o número fica «—»: o painel nunca estima.'
    ]));
  }
`;
