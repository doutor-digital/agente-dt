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
 * Desenho («Placar», escolhido pelo João em 24/11/2026): no alto a faixa «o que precisa de você agora» (respostas ruins para revisar,
 * conversas pausadas, pedidos abertos); depois o desempenho (dois gráficos, cada um na sua escala, e os cinco números menores) e as
 * listas. O card «Consultas marcadas» é um botão: abre a lista completa do período (paciente, dia e hora, quando foi marcada e quem
 * agendou). Tema claro e escuro (o menu do Chatwoot avisa qual está ativo; sem aviso vale o do aparelho), pílulas com cor + forma,
 * números com `tabular-nums`, alvos de toque de 44 px. A definição de cada número fica no `title` do rótulo e em «Como cada número é
 * contado».
 *
 * A sessão chega do menu do Chatwoot por postMessage (`funil:pede-sessao` → `funil-sessao`, com checagem de origem). Todo texto que
 * vem do servidor entra por textContent (nunca innerHTML). O JavaScript não usa crase nem `${`: o texto é um String.raw e só
 * `__ORIGEM_CW__` (a origem do Chatwoot) e `__GUIA_LIGADO__` (true/false: o «?» do cabeçalho só aparece com o guia da etapa ligado) são trocados
 * por `paginaDoAgente`; página servida sem trocar os dois quebra o script.
 *
 * MODO KOMMO (24/11/2026, `paginaDoAgenteKommo`, rota `/agente/:slug`): a MESMA página, para as unidades que usam o Kommo e não têm login do
 * Chatwoot. Troca só a porta de entrada (código de 6 dígitos da unidade em vez da sessão do menu) e o transporte (`apiKm`: manda o código;
 * as rotas do painel, das pausadas e dos pedidos são as de `/api/public/agente-kommo/:slug`). As abas Ensinar/Testar falam com as mesmas rotas
 * de `/aprendizados`; Pausar com as de `/pausa`; Conferir com as de `/ia`. Fica de fora o que só existe no CRM: Registro, 👍/👎 e «para revisar».
 * `KM` é nulo no CRM: todo desvio do modo Kommo está atrás dele, e o CRM segue como estava.
 */
import { guiaDaEtapaLigado } from './chatwoot-guia-etapas.js';
import { comContaNaPagina } from './conta-no-navegador.js';

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Agente · Sofia</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root,[data-tema=claro]{color-scheme:light;--bg:#f9f9fb;--sf:#fff;--sf2:#f3f4f8;--txt:#0b122b;--sec:#464e70;--mut:#646d93;--b:#e3e6f0;--b2:#cdd2e3;--pri:#0b122b;--pri-tx:#fff;--lnk:#2437a0;--foco:#b45f00;--hero:#0b122b;--ok:#16694a;--ok-bg:#e3f5ec;--er:#b0203f;--er-bg:#fcebef;--at:#8a5200;--at-bg:#fff1d6;--so:#5b21b6;--so-bg:#efe8fd;--ne:#454c6b;--ne-bg:#eceef5;--s1:#5468b8;--s2:#d9780a;--ruim:#b0203f;--amarelo:#8a5200;--sombra:0 12px 40px rgba(11,18,43,.28)}
[data-tema=escuro]{color-scheme:dark;--bg:#111113;--sf:#18191b;--sf2:#212225;--txt:#edeef0;--sec:#b0b4ba;--mut:#8b8d98;--b:#2e3135;--b2:#43484e;--pri:#F0A030;--pri-tx:#0b122b;--lnk:#9eb1ff;--foco:#F0A030;--hero:#16204d;--ok:#72d9a8;--ok-bg:#12372a;--er:#ff93aa;--er-bg:#3d1626;--at:#f6bb55;--at-bg:#3b2a0a;--so:#c7adff;--so-bg:#2c1c5c;--ne:#b9bfdc;--ne-bg:#2a2d3a;--s1:#7684d6;--s2:#d37c0e;--ruim:#ff93aa;--amarelo:#f6bb55;--sombra:0 12px 40px rgba(0,0,0,.6)}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--txt);font:14px/1.5 Figtree,Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
button,select,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--foco);outline-offset:2px}
main{max-width:1240px;margin:0 auto;padding:20px 28px 56px}
h1{margin:0;font:800 26px/1.1 "Bricolage Grotesque",Figtree,sans-serif;letter-spacing:-.02em}
h3{margin:0 0 4px;font:700 17px/1.25 "Bricolage Grotesque",Figtree,sans-serif;letter-spacing:-.01em;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
h3 .c{color:var(--mut);font:500 13px Figtree,sans-serif;font-variant-numeric:tabular-nums}
.meta{color:var(--sec);font-size:13px}
.mut{color:var(--mut)}
.cab{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;margin-bottom:14px}
.cab .eu{display:flex;align-items:center;gap:10px;color:var(--sec);font-size:13px}
.cab .aj{width:44px;height:44px;border-radius:50%;border:1px solid var(--b2);background:transparent;color:var(--sec);font-weight:700;font-size:15px;cursor:pointer}.cab .aj:hover{color:var(--lnk);border-color:var(--lnk)}
.topo{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px 16px;border-bottom:1px solid var(--b2)}
.abas{display:flex;gap:4px;flex-wrap:wrap}
.abas button{position:relative;min-height:44px;padding:0 14px;border:0;border-bottom:3px solid transparent;background:transparent;color:var(--sec);font-weight:600;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;margin-bottom:-1px}
.abas button:hover{color:var(--txt)}
.abas button[aria-selected=true]{color:var(--txt);font-weight:700;border-bottom-color:#F0A030}
.abas .c{min-width:20px;height:20px;padding:0 7px;border-radius:999px;background:var(--ne-bg);color:var(--ne);font-size:11.5px;font-weight:700;line-height:20px;text-align:center;font-variant-numeric:tabular-nums}
.abas .c:empty{display:none}
#aba-pausadas .c{background:var(--so-bg);color:var(--so)}
.lado{display:flex;align-items:center;gap:10px;padding-bottom:6px}
.sel{min-height:44px;padding:0 10px;border:1px solid var(--b2);border-radius:10px;background:var(--sf);font-size:13px;cursor:pointer}
.bt{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--b2);background:var(--sf);color:var(--txt);font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .12s}
.bt:hover{background:var(--sf2)}
.bt.pri{background:var(--pri);border-color:var(--pri);color:var(--pri-tx)}
.bt.pri:hover{filter:brightness(1.12);background:var(--pri)}
.bt.link{border-color:transparent;background:transparent;color:var(--lnk);padding:0 10px}
.bt.link:hover{background:var(--sf2)}
.bt.leve{border-color:transparent;background:transparent;color:var(--sec)}
.bt.leve:hover{background:var(--sf2);color:var(--txt)}
.bt:disabled{opacity:.5;cursor:default}
.pane{padding-top:22px}
.pane>*+*{margin-top:28px}
.aviso{padding:10px 14px;border:1px solid var(--at);border-radius:10px;background:var(--at-bg);color:var(--at);font-size:13px;white-space:pre-wrap}
.aviso.erro{border-color:var(--er);background:var(--er-bg);color:var(--er)}
.vinculo{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;padding:7px 12px;border:1px solid var(--b2);border-radius:10px;background:var(--sf2);color:var(--txt);font-size:13px}

/* pílulas: cor + forma */
.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px 0 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--ne-bg);color:var(--ne)}
.pill::before{content:"";width:8px;height:8px;background:currentColor;flex:none}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.ok::before{border-radius:50%}
.pill.er{background:var(--er-bg);color:var(--er)}.pill.er::before{transform:rotate(45deg)}
.pill.at{background:var(--at-bg);color:var(--at)}.pill.at::before{clip-path:polygon(50% 0,100% 100%,0 100%);width:9px}
.pill.so{background:var(--so-bg);color:var(--so)}.pill.so::before{background:transparent;border:2px solid currentColor;border-radius:50%}
.pill.ne::before{height:2px;width:9px}

/* faixa «o que precisa de você» */
.b-hero{--at:#f6bb55;--at-bg:#3b2a0a;--so:#c7adff;--so-bg:#2c1c5c;--ne:#c3c9e4;--ne-bg:#2a3260;--er:#ff93aa;--er-bg:#4a1a2d;background:var(--hero);color:#fff;border-radius:20px;padding:22px 24px 24px}
.b-hero h2{margin:0;font:700 20px/1.2 "Bricolage Grotesque",Figtree,sans-serif;letter-spacing:-.01em}
.b-hero .meta{color:#aeb6d8}
.b-hero-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:6px 16px}
.b-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:16px}
.b-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;padding:16px 18px 18px;border-radius:16px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#fff;cursor:pointer;min-height:44px}
.b-tile:hover{background:rgba(255,255,255,.11)}
.b-tile:focus-visible{outline-color:#F0A030}
.b-tile.alerta{border:2px solid #F0A030;padding:15px 17px 17px}
.b-tile .num{font:800 58px/1 "Bricolage Grotesque",Figtree,sans-serif;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.b-tile.alerta .num{color:#F0A030}
.b-tile .rot{font-size:14px;color:#dfe3f5;font-weight:500}

/* desempenho */
.b-sec>h3{margin-bottom:12px}
.b-grandes{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.b-peq{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin-top:14px}
.b-card{display:block;width:100%;text-align:left;background:var(--sf);border:1px solid var(--b);border-radius:18px;padding:18px 20px;color:inherit}
.b-card .r{display:block;font-size:13.5px;color:var(--sec);font-weight:500;cursor:help}
.b-card .v{display:block;font:800 44px/1.05 "Bricolage Grotesque",Figtree,sans-serif;letter-spacing:-.03em;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.b-card .v.nulo{color:var(--mut)}
.b-peq .b-card{padding:14px 16px}.b-peq .v{font-size:32px}
.b-card .graf{display:block;margin-top:12px}
button.b-clicavel{cursor:pointer;border-color:var(--b2)}
button.b-clicavel:hover{border-color:var(--lnk);background:var(--sf2)}
.b-ver{display:inline-flex;align-items:center;gap:6px;margin-top:12px;min-height:24px;color:var(--lnk);font-weight:700;font-size:13px}
.b-ver::after{content:"";width:7px;height:7px;border-top:2px solid currentColor;border-right:2px solid currentColor;transform:rotate(45deg)}
.dt{display:block;min-height:19px;font-size:12.5px;color:var(--sec);font-variant-numeric:tabular-nums}
.dt.up::before,.dt.dn::before{content:"";display:inline-block;width:8px;height:7px;margin-right:5px;background:currentColor}
.dt.up::before{clip-path:polygon(50% 0,100% 100%,0 100%)}.dt.dn::before{clip-path:polygon(0 0,100% 0,50% 100%)}
.dt.bom{color:var(--ok)}.dt.ruim{color:var(--er)}.dt .vs{color:var(--mut)}
.graf svg{display:block;width:100%;height:auto;overflow:visible}
.g-grade{stroke:var(--b)}.g-base{stroke:var(--b2)}.g-eixo{fill:var(--sec);font:11px Figtree,sans-serif}
.g-r{fill:var(--s1)}.g-m{fill:var(--s2)}
.b-nota{margin:8px 0 0}
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
.b-duas{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:26px;align-items:start}
.b-lista{background:var(--sf);border:1px solid var(--b);border-radius:18px;padding:4px 22px 10px;margin-top:10px}
.b-lista>:first-child{border-top:0}
.b-lista+.b-lista,.b-bloco+.b-bloco{margin-top:26px}

/* listas densas */
.lin{display:flex;align-items:center;justify-content:space-between;gap:8px 14px;flex-wrap:wrap;padding:11px 0;border-top:1px solid var(--b)}
.lin .nm{font-weight:600}
.lin .det{display:block;margin-top:1px;font-size:13px;color:var(--sec);font-variant-numeric:tabular-nums}
.lin .btns{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.mais{display:flex;justify-content:flex-end;padding-top:6px}
.vazio{margin:0;padding:12px 0;border-top:1px solid var(--b);color:var(--sec)}
.vazio b{color:var(--txt);font-weight:600}
.reg-filtros{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.reg-filtros input.sel{width:170px}
.reg{border-top:1px solid var(--b);padding:12px 0}
.reg-cab{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.reg-cab .bt{margin-left:auto}
.reg-it{display:grid;grid-template-columns:92px 1fr;gap:10px;padding:4px 0 4px 12px;border-left:3px solid var(--b2)}
.reg-it.reg-nao-respondeu{border-left-color:var(--er)}
.reg-it.reg-marcou,.reg-it.reg-pix{border-left-color:var(--ok)}
.reg-it.reg-equipe{border-left-color:var(--so)}
.reg-it.reg-resposta{border-left-color:var(--lnk)}
.reg-it.reg-avaliacao{border-left-color:var(--at)}
.reg-q{color:var(--sec);font-variant-numeric:tabular-nums;font-size:12.5px}
.reg-tx{min-width:0;overflow-wrap:anywhere}

/* resposta para revisar */
.caso{padding:14px 0;border-top:1px solid var(--b)}
.caso .q{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--sec)}
.caso .q b{color:var(--txt);font-weight:600}
.caso dl{display:grid;grid-template-columns:64px minmax(0,1fr);gap:5px 10px;margin:8px 0 0;font-size:14px}
.caso dt{color:var(--mut);font-size:12.5px;padding-top:2px}
.caso dd{margin:0;white-space:pre-wrap;word-break:break-word}
.caso dd.errado{color:var(--er);font-weight:500}
.caso .btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}

/* ensinar */
label.rot{display:flex;justify-content:space-between;gap:10px;font-size:13px;font-weight:600;margin:14px 0 6px}
label.rot span{font-weight:400;color:var(--mut);font-variant-numeric:tabular-nums}
textarea,input[type=text]{width:100%;border:1px solid var(--b2);border-radius:10px;background:var(--sf);padding:10px 12px;line-height:1.45}
textarea{min-height:96px;resize:vertical}
textarea:focus,input[type=text]:focus{outline:2px solid var(--foco);outline-offset:1px}
textarea::placeholder,input::placeholder{color:var(--mut)}
.exemplos{list-style:none;padding:0!important}
.exemplos button{border:0;background:transparent;padding:4px 0;color:var(--lnk);cursor:pointer;text-align:left}
.exemplos button:hover{text-decoration:underline}
.falas input{margin-top:6px}
.acoes{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
.antes-depois{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
.antes-depois>div{border:1px solid var(--b);border-radius:12px;padding:10px 12px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.antes-depois>div.nova{border-color:var(--lnk);background:var(--sf2)}
.antes-depois small{display:block;margin-bottom:3px;color:var(--sec);font-size:12px;font-weight:600}
.previa-item{padding:12px 0;border-top:1px solid var(--b)}
.previa-item .fala{font-size:13px;color:var(--sec)}
.previa-item .fala b{color:var(--txt);font-weight:600}
.regra{display:flex;gap:12px;align-items:flex-start;padding:11px 0;border-top:1px solid var(--b)}
.regra p{margin:0;flex:1;min-width:0;font-size:14px;white-space:pre-wrap;word-break:break-word}
.regra small{display:block;margin-top:2px;color:var(--mut);font-size:12px}
.regra.off p{color:var(--mut)}
.sw{position:relative;width:46px;height:28px;margin-top:0;border-radius:999px;border:0;background:var(--b2);cursor:pointer;flex:none;transition:background .15s}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.sw[aria-checked=true]{background:var(--ok)}
.sw[aria-checked=true]::after{transform:translateX(18px)}
details.equipe{margin-top:12px}

/* testar */
.chatbox{border:1px solid var(--b);border-radius:16px;overflow:hidden;background:var(--sf)}
.chatbox .cabc{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:11px 14px;border-bottom:1px solid var(--b);font-size:13px;color:var(--sec)}
.chatbox .cabc b{color:var(--txt);font-weight:700;font-size:14px}
.chat{display:flex;flex-direction:column;gap:6px;height:min(56vh,520px);overflow-y:auto;padding:14px;background:var(--sf2)}
.msg{max-width:78%;padding:8px 12px;border-radius:14px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.msg.pac{align-self:flex-start;background:var(--ne-bg);color:var(--txt);border-bottom-left-radius:4px}
.msg.sofia{align-self:flex-end;background:var(--so-bg);color:var(--txt);border-bottom-right-radius:4px}
.msg.acao{align-self:flex-end;background:transparent;color:var(--amarelo);font-size:12px;padding:0 4px}
.msg.dica{align-self:center;background:transparent;color:var(--sec);font-size:13px;text-align:center}
.msg.dig{color:var(--sec)}
.escrever{display:flex;gap:8px;padding:10px;border-top:1px solid var(--b)}
.escrever textarea{min-height:44px;height:44px;resize:none}
.lista-falas{margin:6px 0 0;padding:0;list-style:none}
.lista-falas li{border-top:1px solid var(--b)}
.lista-falas button{width:100%;border:0;background:transparent;text-align:left;padding:10px 0;cursor:pointer;color:var(--txt)}
.lista-falas button:hover{color:var(--lnk)}

/* tabelas */
.rolar{overflow-x:auto}
table.tab{width:100%;border-collapse:collapse;font-size:14px}
.tab th{padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--sec);white-space:nowrap;border-bottom:1px solid var(--b2)}
.tab td{padding:10px 12px;border-bottom:1px solid var(--b);vertical-align:middle}
.tab th:first-child,.tab td:first-child{padding-left:0}
.tab th:last-child,.tab td:last-child{padding-right:0;text-align:right;white-space:nowrap}
.tab .n{font-variant-numeric:tabular-nums}
.sem{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px 0 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--ne-bg);color:var(--ne)}
.sem::before{content:"";width:8px;height:8px;background:currentColor;flex:none}
.sem.g{background:var(--ok-bg);color:var(--ok)}.sem.g::before{border-radius:50%}
.sem.v{background:var(--er-bg);color:var(--er)}.sem.v::before{transform:rotate(45deg)}
.sem.a{background:var(--at-bg);color:var(--at)}.sem.a::before{clip-path:polygon(50% 0,100% 100%,0 100%);width:9px}

/* pedir */
.tipos{display:flex;flex-direction:column;gap:2px;margin-top:10px}
.tipos label{display:flex;align-items:center;gap:10px;padding:6px 0;min-height:36px;cursor:pointer;font-size:14px}
.tipos input{width:18px;height:18px;margin:0;accent-color:var(--pri)}
.pedido{padding:12px 0;border-top:1px solid var(--b)}
.pedido .l1{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pedido .l1 b{font-weight:700;font-variant-numeric:tabular-nums}
.pedido p{margin:4px 0 0;font-size:14px;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.pedido .det{margin-top:2px;font-size:12.5px;color:var(--sec)}
.pedido .resp{margin-top:8px;padding-left:10px;border-left:3px solid var(--ok);color:var(--txt);font-size:13px;white-space:pre-wrap}

/* lista de consultas (janela) */
dialog.janela{width:min(940px,calc(100vw - 24px));max-height:calc(100vh - 32px);padding:0;border:1px solid var(--b2);border-radius:20px;background:var(--sf);color:var(--txt);box-shadow:var(--sombra)}
dialog.janela::backdrop{background:rgba(5,8,20,.6)}
.janela-in{display:flex;flex-direction:column;max-height:calc(100vh - 34px)}
.janela-cab{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 22px 12px;border-bottom:1px solid var(--b)}
.janela-cab h3{margin:0;font-size:20px}
.janela-corpo{overflow:auto;padding:4px 22px 6px}
.janela-rodape{padding:10px 22px 16px;border-top:1px solid var(--b);color:var(--sec);font-size:13px}
.tab .quem{white-space:nowrap}

/* modo Kommo: entrada por código, pausa da unidade, conferir, celular */
a.bt{text-decoration:none}
.entrada{max-width:420px;margin-top:20px}
.entrada input{margin-bottom:4px}
.pausa-ops{display:flex;flex-direction:column;gap:2px;margin:10px 0 8px}
.pausa-ops label{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;font-size:14px}
.pausa-ops input{width:16px;height:16px;margin:0;accent-color:var(--pri)}
.pausa-estado{display:inline-flex;align-items:center;gap:6px;font-weight:600}
.pausa-estado::before{content:"";width:8px;height:8px;border-radius:50%;background:#30a46c}
.pausa-estado.off::before{background:#e5a100}
.conf-grupo h4{margin:14px 0 2px;font-size:13.5px;font-weight:600;color:var(--amarelo)}
.conf-col{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--b);font-variant-numeric:tabular-nums}
.conf-item{padding:8px 0;border-top:1px solid var(--b)}
.conf-item a{color:var(--txt);font-weight:600;text-decoration:none;border-bottom:1px dotted var(--mut)}
.conf-item .f{font-size:13px;color:var(--sec)}
.tipo-ia{color:var(--lnk)}.tipo-equipe{color:var(--ok)}.tipo-robo{color:var(--mut)}.tipo-consultoria{color:var(--amarelo)}
@media (max-width:560px){body.km .abas{width:100%;gap:0 2px}body.km .abas button{padding:0 9px;font-size:13.5px}body.km .lado{width:100%;padding:8px 0}body.km .lado .sel{flex:1;min-height:40px}body.km .bt{min-height:40px}}

body.km .col-quem,body.km #tRevisar{display:none}
@media (min-width:561px){body.km .b-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
body.km .b-duas{grid-template-columns:minmax(0,1fr)}
/* esqueleto e aviso flutuante */
.sk{display:block;border-radius:10px;background:linear-gradient(90deg,var(--sf2) 0,var(--b) 40%,var(--sf2) 80%);background-size:300% 100%;animation:brilho 1.2s ease-in-out infinite}
@keyframes brilho{from{background-position:100% 0}to{background-position:0 0}}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));padding:11px 16px;border-radius:12px;background:var(--pri);color:var(--pri-tx);font-size:13.5px;font-weight:600;z-index:20}
.toast.erro{background:var(--er-bg);color:var(--er);border:1px solid var(--er)}
.rodape{margin-top:32px;color:var(--mut);font-size:12.5px}
@media (max-width:1000px){.b-peq{grid-template-columns:repeat(3,minmax(0,1fr))}.b-duas,.duas,.duas.larga{grid-template-columns:1fr}}
@media (max-width:700px){.b-peq{grid-template-columns:repeat(2,minmax(0,1fr))}.b-grandes{grid-template-columns:1fr}}
@media (max-width:560px){
 main{padding:14px 14px 40px}
 .b-hero{padding:18px 16px;border-radius:16px}
 .b-tiles{grid-template-columns:1fr}
 .b-tile{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:2px 16px}
 .b-tile .num{font-size:44px;grid-row:1/3}
 .b-tile .pill{justify-self:start}
 .b-card .v{font-size:36px}
 .abas{overflow-x:auto;flex-wrap:nowrap;width:100%}.abas button{flex:none}
 .lado{width:100%}.lado .sel{width:100%}
 .antes-depois{grid-template-columns:1fr}
 .reg-it{grid-template-columns:1fr;gap:2px}.reg-filtros input.sel{width:100%}
 .bt{min-height:44px}
 .lin .btns{justify-content:flex-start}
 .b-lista{padding:2px 14px 8px}
 .janela-cab,.janela-corpo,.janela-rodape{padding-left:14px;padding-right:14px}
 table.tab.empilha thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
 table.tab.empilha tr{display:block;padding:10px 0;border-bottom:1px solid var(--b)}
 table.tab.empilha td{display:flex;justify-content:space-between;gap:12px;border:0;padding:3px 0;text-align:right!important}
 table.tab.empilha td::before{content:attr(data-r);color:var(--mut);font-size:12px;font-weight:400;text-align:left}
 table.tab.empilha td:last-child{justify-content:flex-end;padding-top:8px}
 table.tab.empilha td:last-child::before{content:none}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body><main>
<div class="cab">
  <div><h1>Agente</h1><div class="meta" id="unidadeNome">Carregando…</div></div>
  <div class="eu"><button class="aj" id="ajuda" type="button" hidden title="Ver a aula desta tela" aria-label="Ver a aula em vídeo desta tela">?</button><select class="sel" id="unidadeSel" aria-label="Unidade" hidden></select><span id="euNome"></span><button class="bt leve" id="kmSair" type="button" hidden>Sair</button></div>
</div>
<div id="erroTopo" class="aviso erro" hidden></div>
<section class="entrada" id="entradaKm" hidden>
  <h3>Entrar</h3>
  <div class="meta">Use o código de 6 dígitos da unidade (o mesmo da página de pausar a Sofia).</div>
  <label class="rot" for="kmCodigo">Código da unidade</label>
  <input type="text" id="kmCodigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 dígitos">
  <label class="rot" for="kmNome">Seu nome</label>
  <input type="text" id="kmNome" maxlength="80" placeholder="Quem está usando">
  <div class="acoes"><span></span><button class="bt pri" id="kmEntrar" type="button">Entrar</button></div>
</section>

<div id="corpo" hidden>
<div class="topo">
  <nav class="abas" role="tablist" aria-label="Seções">
    <button role="tab" id="aba-painel" data-aba="painel" aria-selected="true">Painel</button>
    <button role="tab" id="aba-ensinar" data-aba="ensinar" aria-selected="false">Ensinar</button>
    <button role="tab" id="aba-testar" data-aba="testar" aria-selected="false">Testar</button>
    <button role="tab" id="aba-pausadas" data-aba="pausadas" aria-selected="false">Pausadas<span class="c" id="contaPausadas"></span></button>
    <button role="tab" id="aba-registro" data-aba="registro" aria-selected="false">Registro</button>
    <button role="tab" id="aba-conferir" data-aba="conferir" aria-selected="false" hidden>Conferir</button>
    <button role="tab" id="aba-pedir" data-aba="pedir" aria-selected="false">Pedir à Doutor Digital<span class="c" id="contaPedidos"></span></button>
  </nav>
  <div class="lado" id="ladoPainel"><select class="sel" id="periodo" aria-label="Período"><option value="hoje">Hoje</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option></select></div>
</div>

<!-- PAINEL -->
<section class="pane" id="pane-painel" role="tabpanel" aria-labelledby="aba-painel">
  <div class="b-hero">
    <div class="b-hero-top"><h2>O que precisa de você agora</h2><span class="meta" id="heroUnidade"></span></div>
    <div class="b-tiles">
      <button class="b-tile alerta" id="tRevisar" type="button"><span class="num" id="nRevisar">—</span><span class="rot">respostas marcadas como ruins, sem revisão</span><span class="pill er">Para revisar</span></button>
      <button class="b-tile" id="tPausadas" type="button"><span class="num" id="nPausadas">—</span><span class="rot">conversas com a Sofia pausada</span><span class="pill so">Equipe no comando</span></button>
      <button class="b-tile" id="tPedidos" type="button"><span class="num" id="nPedidos">—</span><span class="rot">pedidos abertos à Doutor Digital</span><span class="pill at">Na fila</span></button>
    </div>
  </div>
  <div class="meta" id="lidoEm" hidden></div>
  <section class="b-sec">
    <h3>Desempenho da Sofia <span class="c" id="descPeriodo"></span></h3>
    <div class="b-grandes" id="grandes"><span class="sk" style="height:220px"></span><span class="sk" style="height:220px"></span></div>
    <p class="meta b-nota">Cada gráfico tem a sua escala: os últimos 14 dias.</p>
    <div class="b-peq" id="peq"><span class="sk" style="height:96px"></span></div>
    <details class="def" style="margin-top:12px"><summary>Ver o gráfico por dia como tabela</summary><div class="rolar"><table class="tabdia" id="tabDia"></table></div></details>
  </section>
  <div class="b-duas">
    <section id="secRevisar">
      <h3>Respostas marcadas como ruins <span class="c" id="cRevisar"></span></h3>
      <div class="meta">Ficam aqui até alguém ensinar a Sofia, pedir ajuste ou dar ok.</div>
      <div class="b-lista" id="listaRevisar"><span class="sk" style="height:60px"></span></div>
    </section>
    <div>
      <section class="b-bloco">
        <h3>Conversas pausadas <span class="c" id="cPausadasPainel"></span></h3>
        <div class="meta">A Sofia volta quando a conversa é resolvida. Dá para devolver antes.</div>
        <div class="b-lista" id="listaPausadasPainel"><span class="sk" style="height:60px"></span></div>
      </section>
      <section class="b-bloco">
        <h3>Consultas que a Sofia marcou <span class="c" id="cMarcadas"></span></h3>
        <div class="meta">No período escolhido. Mais recentes primeiro.</div>
        <div class="b-lista" id="listaMarcadas"><span class="sk" style="height:60px"></span></div>
      </section>
    </div>
  </div>
  <details class="def"><summary>Como cada número é contado</summary><ul>
    <li><b>Pessoas respondidas</b>: conversas em que a Sofia mandou pelo menos uma resposta no período.</li>
    <li><b>Consultas marcadas</b>: consultas que a Sofia marcou na agenda da franquia por uma conversa do CRM. Consultas que a equipe marca direto na agenda não passam por aqui.</li>
    <li><b>Marcaram</b>: consultas marcadas ÷ pessoas respondidas.</li>
    <li><b>Passou para a equipe</b>: conversas em que ela chamou alguém da equipe (paciente pediu uma pessoa, assunto que ela não resolve).</li>
    <li><b>Pix do sinal gerado</b>: conversas em que ela gerou o Pix do sinal.</li>
    <li class="so-crm"><b>Para revisar</b>: respostas marcadas como ruins que ninguém revisou ainda.</li>
    <li><b>À noite ou no fim de semana</b>: respostas antes das 8h, a partir das 18h, sábado e domingo.</li>
    <li class="so-crm"><b>Avaliadas como boas</b>: das avaliações que a equipe deu nos balões da Sofia, quantas foram positivas.</li>
    <li class="so-km" hidden><b>De onde vêm os números</b>: do registro de tudo o que a Sofia fez em cada conversa. A cobrança de quem sumiu, a reativação e o cartão de chegada não contam como resposta.</li>
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
      <p class="meta" style="margin-top:16px">Agenda e Pix aqui são de mentira: nada vai para a franquia, o CRM ou o WhatsApp. A conversa fica só neste aparelho.</p>
    </section>
  </div>
</section>

<!-- PAUSADAS -->
<section class="pane" id="pane-pausadas" role="tabpanel" aria-labelledby="aba-pausadas" hidden>
  <section id="pausaUnidade" hidden>
    <h3>Pausar a Sofia na unidade</h3>
    <div class="meta" id="pausaDescricao">Carregando…</div>
    <div class="pausa-ops" id="pausaOps" role="radiogroup" aria-label="Até quando"></div>
    <input type="text" id="pausaMotivo" maxlength="200" placeholder="Motivo (opcional): reunião, feriado local…" aria-label="Motivo">
    <div class="acoes"><span class="meta">Pausada, a Sofia não responde, não cobra quem sumiu e não manda lembrete. Ela volta sozinha na hora marcada.</span><span><button class="bt pri" id="btPausar" type="button">Pausar a Sofia</button> <button class="bt" id="btRetomar" type="button" hidden>Retomar agora</button></span></div>
    <div id="avisoPausa" class="aviso erro" hidden style="margin-top:10px"></div>
  </section>
  <section>
    <h3>Conversas com a Sofia pausada <span class="c" id="cPausadas"></span></h3>
    <div class="meta" id="pausadasMeta">A Sofia sai da frente quando alguém da equipe responde (pelo CRM ou pelo celular) e volta quando a conversa é resolvida. Aqui dá para devolver antes.</div>
    <div class="rolar" style="margin-top:8px"><table class="tab"><thead><tr><th>Paciente</th><th>Pausada por</th><th>Desde</th><th id="thCom">Com</th><th></th></tr></thead><tbody id="listaPausadas"></tbody></table></div>
  </section>
</section>

<!-- CONFERIR (só no modo Kommo) -->
<section class="pane" id="pane-conferir" role="tabpanel" aria-labelledby="aba-conferir" hidden>
  <div id="conferirAvisos"></div>
  <div id="conferirCorpo"><span class="sk" style="height:84px"></span></div>
  <p class="meta" id="conferirQuando"></p>
</section>

<!-- REGISTRO -->
<section class="pane" id="pane-registro" role="tabpanel" aria-labelledby="aba-registro" hidden>
  <section>
    <h3>O que a Sofia fez <span class="c" id="cRegistro"></span></h3>
    <div class="meta">Últimos 7 dias, por conversa, o mais recente primeiro: o que ela respondeu, marcou, passou para a equipe, o Pix que mandou, as avaliações de vocês e, quando ela não respondeu, o motivo.</div>
    <div class="reg-filtros">
      <select class="sel" id="regTipo" aria-label="Tipo"><option value="">Tudo</option><option value="resposta">Respostas</option><option value="marcou">Consultas marcadas</option><option value="equipe">Passou para a equipe</option><option value="pix">Pix do sinal</option><option value="nao-respondeu">Não respondeu</option><option value="avaliacao">Avaliações</option></select>
      <input class="sel" id="regConversa" inputmode="numeric" placeholder="Nº da conversa" aria-label="Número da conversa" maxlength="9">
      <button class="bt" id="btRegFiltrar" type="button">Filtrar</button>
    </div>
    <div id="listaRegistro" style="margin-top:8px"><span class="sk" style="height:60px"></span></div>
  </section>
</section>

<!-- PEDIR -->
<section class="pane" id="pane-pedir" role="tabpanel" aria-labelledby="aba-pedir" hidden>
  <div class="duas">
    <section>
      <h3>Pedir à Doutor Digital</h3>
      <div class="meta">Valor, horários, médicos, informação da clínica ou um erro da Sofia: isso a nossa equipe ajusta. A resposta aparece na lista de pedidos.</div>
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
<dialog class="janela" id="dlgConsultas" aria-labelledby="dlgTitulo">
  <div class="janela-in">
    <div class="janela-cab">
      <div><h3 id="dlgTitulo">Consultas que a Sofia marcou</h3><div class="meta" id="dlgPeriodo"></div></div>
      <button class="bt" id="dlgFechar" type="button">Fechar</button>
    </div>
    <div class="janela-corpo">
      <div class="rolar"><table class="tab empilha"><thead><tr><th>Paciente</th><th>Consulta</th><th>Marcada</th><th class="col-quem">Quem agendou</th><th></th></tr></thead><tbody id="dlgLista"></tbody></table></div>
    </div>
    <div class="janela-rodape" id="dlgRodape"></div>
  </div>
</dialog>
<div id="toast" class="toast" role="status" hidden></div>
<script>
(function(){
  var GUIA_LIGADO = __GUIA_LIGADO__;
  var CW = __ORIGEM_CW__, S = null, U = null, EU = '', UNIDADES = [];
  var KM = __KOMMO__, KM_COD = '', KM_NOME = '', KM_LIB = false;
  if (KM) document.body.classList.add('km');
  function kmRota(parte, query){ return '/api/public/agente-kommo/' + encodeURIComponent(KM.slug) + '/' + parte + (query ? '?' + query : ''); }
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
  /*__CONTA_JS__*/
  function cab(){ var h = { 'Content-Type': 'application/json' }; if (S) { h['X-CW-Token'] = S.token; h['X-CW-Client'] = S.client; h['X-CW-Uid'] = S.uid; } return h; }
  // modo Kommo: o código da unidade vai em toda chamada (GET no cabeçalho x-codigo, para não ir parar no log de acesso; o resto no corpo) e o nome de quem está usando vira «por»
  async function apiKm(method, path, body){
    // sem código (saiu, ou o código foi recusado) nada vai ao servidor: cada chamada com código vazio gastaria uma das 12 tentativas da unidade
    if (!KM_COD) throw new Error('Entre com o código da unidade.');
    var url = path, init = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (method === 'GET') init.headers['x-codigo'] = KM_COD;
    else init.body = JSON.stringify(Object.assign({ por: KM_NOME }, body || {}, { codigo: KM_COD }));
    var r = await fetch(url, init);
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { var er = new Error(j.error || ('erro ' + r.status)); er.dados = j; er.status = r.status; if (r.status === 403 && j.error === 'código inválido') sairKm('Código inválido. Confira os 6 dígitos.'); throw er; }
    return j;
  }
  async function api(method, path, body){
    if (KM) return apiKm(method, path, body);
    var r = await fetch(comConta(path), { method: method, headers: cab(), body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
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
  var ABAS = ['painel', 'ensinar', 'testar', 'pausadas', 'conferir', 'registro', 'pedir'], abaAtual = 'painel';
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
    if (qual === 'conferir') carregarConferir();
    if (qual === 'registro') carregarRegistro();
    if (qual === 'pedir') carregarPedidos();
  }
  ABAS.forEach(function(a){ $('aba-' + a).addEventListener('click', function(){ ir(a); }); });

  // ── estado da unidade (regras, testes de regra, conversa de teste) ──
  var EST = null, MAX = 400, falasPadrao = [];
  async function lerEstado(){
    if (KM && !KM_LIB) return null;
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
  var tPainel = null, tentativasPainel = 0;
  var COMPARA = { hoje: 'ontem', '7': '7 dias antes', '30': '30 dias antes' };
  var SEM_ANTES = false;
  var ROT_PERIODO = { hoje: 'hoje', '7': 'últimos 7 dias', '30': 'últimos 30 dias' };
  // a variação contra o período anterior: v = «+17», vs = «vs. 7 dias antes»; s = sentido da seta; c = bom | ruim (vazio = neutro)
  function variacao(agora, antes, pontos){
    if (agora == null || antes == null || SEM_ANTES) return { v: '', vs: '', c: '', s: '' };
    var d = agora - antes;
    if (d === 0) return { v: PERIODO === 'hoje' ? 'igual a ontem' : 'igual ao período anterior', vs: '', c: '', s: '' };
    return { v: (d > 0 ? '+' : '−') + Math.abs(d) + (pontos ? ' pts' : ''), vs: ' vs. ' + COMPARA[PERIODO], c: d > 0 ? 'bom' : 'ruim', s: d > 0 ? 'up' : 'dn' };
  }
  function elDelta(v){
    var d = el('span', 'dt' + (v && v.c ? ' ' + v.c : '') + (v && v.s ? ' ' + v.s : ''));
    if (v && v.v) d.appendChild(document.createTextNode(v.v));
    if (v && v.vs) d.appendChild(el('span', 'vs', v.vs));
    if (v && v.texto) d.textContent = v.texto;
    return d;
  }
  function cartao(tag, rotulo, definicao, valor, v, extra){
    var k = el(tag, 'b-card' + (extra ? ' ' + extra : '')); if (tag === 'button') k.type = 'button';
    var r = el('span', 'r', rotulo); r.title = definicao; k.appendChild(r);
    k.appendChild(el('span', 'v' + (valor === '—' ? ' nulo' : ''), valor));
    k.appendChild(elDelta(v));
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
  var ULTIMO = null, graficos = [];
  // erro ou «lendo…»: nada do período anterior (nem de OUTRA unidade) fica na tela
  function painelVazio(){
    ULTIMO = null; graficos = [];
    $('grandes').textContent = ''; $('peq').textContent = ''; $('nRevisar').textContent = '—'; $('cRevisar').textContent = ''; $('cMarcadas').textContent = ''; $('descPeriodo').textContent = '';
    ['listaRevisar', 'listaMarcadas'].forEach(function(id){ $(id).textContent = ''; });
  }
  function abrirDialogo(d){ if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  function fecharDialogo(d){ if (d.close) d.close(); else d.removeAttribute('open'); }
  async function carregarPainel(){
    ULTIMO = null;
    try {
      var p = await api('GET', KM ? kmRota('painel', 'periodo=' + enc(PERIODO)) : '/api/public/agente/painel?slug=' + enc(U.slug) + '&periodo=' + enc(PERIODO));
      clearTimeout(tPainel);
      if (p.carregando) {
        // a primeira leitura de uma conta grande demora: pergunta de novo sozinha, sem martelar
        painelVazio(); $('grandes').appendChild(el('div', 'aviso', p.motivo || 'Lendo os números…'));
        if (++tentativasPainel < 30) tPainel = setTimeout(function(){ if (abaAtual === 'painel') carregarPainel(); }, 6000);
        else { painelVazio(); erroEm($('grandes'), 'Os números estão demorando mais que o normal. Toque em Painel de novo daqui a alguns minutos.'); }
        return;
      }
      // cache velho servido enquanto a leitura nova roda por trás: pergunta de novo, como no «lendo…»
      if (KM && p.atualizando && ++tentativasPainel < 30) tPainel = setTimeout(function(){ if (abaAtual === 'painel') carregarPainel(); }, 6000);
      else tentativasPainel = 0;
      SEM_ANTES = !!(KM && p.semAnterior);
      ULTIMO = p;
      $('descPeriodo').textContent = ROT_PERIODO[PERIODO] + (SEM_ANTES ? '' : ', contra ' + (PERIODO === 'hoje' ? 'ontem até a mesma hora' : 'os ' + COMPARA[PERIODO]));
      var g = $('grandes'); g.textContent = ''; graficos = [];
      var gr = cartao('div', 'Pessoas respondidas', 'Conversas em que a Sofia mandou pelo menos uma resposta no período', String(p.respondidas.agora), variacao(p.respondidas.agora, p.respondidas.antes), 'b-grande');
      var gm = cartao('button', 'Consultas marcadas', 'Consultas que a Sofia marcou na agenda da franquia por uma conversa do CRM', String(p.marcadas.agora), variacao(p.marcadas.agora, p.marcadas.antes), 'b-grande b-clicavel');
      gm.setAttribute('aria-haspopup', 'dialog'); gm.onclick = abrirConsultas;
      [[gr, 'respondidas', 'g-r'], [gm, 'marcadas', 'g-m']].forEach(function(x){ var box = el('span', 'graf'); x[0].appendChild(box); g.appendChild(x[0]); graficos.push({ box: box, chave: x[1], cls: x[2] }); });
      gm.appendChild(el('span', 'b-ver', p.marcadas.agora ? (KM ? 'Ver as consultas' : 'Ver quem agendou') : 'Ver a lista'));
      var k = $('peq'); k.textContent = '';
      k.appendChild(cartao('div', 'Marcaram', 'Consultas marcadas ÷ pessoas respondidas', p.conversao.agora == null ? '—' : p.conversao.agora + '%', variacao(p.conversao.agora, p.conversao.antes, true)));
      if (!KM || p.pixUsado) k.appendChild(cartao('div', 'Pix do sinal gerado', 'Conversas em que ela gerou o Pix do sinal', String(p.pix.agora), variacao(p.pix.agora, p.pix.antes)));
      var eq = variacao(p.equipe.agora, p.equipe.antes); eq.c = '';
      k.appendChild(cartao('div', 'Passou para a equipe', 'Conversas em que ela chamou alguém da equipe', String(p.equipe.agora), eq));
      k.appendChild(cartao('div', 'À noite ou fim de semana', 'Respostas antes das 8h, a partir das 18h, sábado e domingo', p.foraDoHorario.pct == null ? '—' : p.foraDoHorario.pct + '%', { texto: p.respostas ? (p.foraDoHorario.respostas + ' de ' + plural(p.respostas, 'resposta', 'respostas')) : '' }));
      var nr = p.totalParaRevisar != null ? p.totalParaRevisar : (p.paraRevisar || []).length;
      if (!KM) {
        k.appendChild(cartao('div', 'Avaliadas como boas', 'Das avaliações que a equipe deu nos balões da Sofia, quantas foram positivas', p.avaliacoes.pct == null ? '—' : p.avaliacoes.pct + '%', p.avaliacoes.pct == null ? { texto: 'ninguém avaliou' } : variacao(p.avaliacoes.pct, p.avaliacoes.pctAntes, true)));
        $('nRevisar').textContent = String(nr);
      } else {
        var le = $('lidoEm'); le.hidden = false;
        // «Lido às 10:42» só vale se foi hoje: leitura de outro dia leva o dia
        var lido = new Date(p.lidoEm), hojeLido = lido.toDateString() === new Date().toDateString();
        var quandoLido = (hojeLido ? '' : lido.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' às ') + lido.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        le.textContent = p.desatualizado ? ('Mostrando a última leitura (' + quandoLido + ')' + (p.atualizando ? ': estou atualizando.' : ': não consegui atualizar agora.')) : ('Lido ' + (hojeLido ? 'às ' : 'em ') + quandoLido + ' · os números se renovam a cada 5 minutos.');
      }
      desenharGraficos(p.porDia || []);
      desenharMarcadas(p.ultimasMarcadas || [], p.marcadas.agora);
      if (!KM) desenharRevisar(p.paraRevisar || [], nr);
    } catch (e) { painelVazio(); erroEm($('grandes'), e.message); }
    contarPausadas();
  }
  var NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs){ var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  var diasDoGrafico = null, tRedesenho = null;
  window.addEventListener('resize', function(){ clearTimeout(tRedesenho); tRedesenho = setTimeout(function(){ if (diasDoGrafico && abaAtual === 'painel') desenharGraficos(diasDoGrafico); }, 150); });
  // um gráfico de barras por medida, cada um na sua escala (marcadas é bem menor que respondidas); barras finas, base reta, valor do topo escrito
  function desenharBarras(box, dias, chave, cls){
    box.textContent = '';
    var W = Math.max(240, Math.round(box.clientWidth || 520)), H = 112, base = 90, topo = 14, n = dias.length || 1, passo = W / n, larg = Math.min(22, passo * 0.5);
    var max = 1; dias.forEach(function(d){ max = Math.max(max, d[chave]); });
    var g = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': (chave === 'respondidas' ? 'Pessoas respondidas' : 'Consultas marcadas') + ' por dia' });
    g.appendChild(svg('line', { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, class: 'g-base' }));
    g.appendChild(svg('line', { x1: 0, x2: W, y1: topo + 0.5, y2: topo + 0.5, class: 'g-grade' }));
    var tm = svg('text', { x: 0, y: topo - 4, class: 'g-eixo' }); tm.textContent = String(max); g.appendChild(tm);
    dias.forEach(function(d, i){
      var x = i * passo + (passo - larg) / 2, a = d[chave] > 0 ? Math.max(3, (base - topo) * d[chave] / max) : 0;
      var gr = svg('g', {}), t = svg('title', {}); t.textContent = diaMes(d.dia) + ': ' + (chave === 'respondidas' ? plural(d.respondidas, 'pessoa respondida', 'pessoas respondidas') : plural(d.marcadas, 'consulta marcada', 'consultas marcadas')); gr.appendChild(t);
      gr.appendChild(svg('rect', { x: i * passo, y: 0, width: passo, height: H, fill: 'transparent' }));
      if (a) gr.appendChild(svg('rect', { x: x, y: base - a, width: larg, height: a, rx: 3, class: cls }));
      if (i % 3 === (n - 1) % 3) { var tx = svg('text', { x: x + larg / 2, y: base + 17, 'text-anchor': 'middle', class: 'g-eixo' }); tx.textContent = diaMes(d.dia); gr.appendChild(tx); }
      g.appendChild(gr);
    });
    box.appendChild(g);
  }
  function desenharGraficos(dias){
    diasDoGrafico = dias;
    graficos.forEach(function(x){ desenharBarras(x.box, dias, x.chave, x.cls); });
    var tab = $('tabDia'); tab.textContent = '';
    var cabT = el('tr'); ['Dia', 'Pessoas respondidas', 'Consultas marcadas'].forEach(function(t){ cabT.appendChild(el('th', null, t)); }); tab.appendChild(cabT);
    dias.slice().reverse().forEach(function(d){ var tr = el('tr'); tr.appendChild(el('td', null, diaMes(d.dia))); tr.appendChild(el('td', null, String(d.respondidas))); tr.appendChild(el('td', null, String(d.marcadas))); tab.appendChild(tr); });
  }
  var PREVIA_MARCADAS = 4;
  function desenharMarcadas(l, total){
    var box = $('listaMarcadas'); box.textContent = ''; $('cMarcadas').textContent = total ? String(total) : '';
    if (!l.length) { var v = el('p', 'vazio'); v.appendChild(el('b', null, 'Nenhuma no período. ')); v.appendChild(document.createTextNode('Quando a Sofia marcar uma consulta, ela aparece aqui com o dia e a hora.')); box.appendChild(v); return; }
    l.slice(0, PREVIA_MARCADAS).forEach(function(m){
      var row = el('div', 'lin'), q = el('div');
      q.appendChild(el('div', 'nm', m.nome || ((KM ? 'Cartão ' : 'Conversa ') + m.conversa)));
      q.appendChild(el('span', 'det', (m.agendadoPara ? 'Consulta ' + consultaEm(m.agendadoPara) : 'Consulta marcada') + ' · marcada ' + ha(m.criadoEm)));
      var bs = el('div', 'btns'), ab;
      if (KM) { ab = el('a', 'bt', 'Abrir cartão'); if (m.link) { ab.href = m.link; ab.target = '_blank'; ab.rel = 'noopener noreferrer'; } else ab.hidden = true; }
      else { ab = el('button', 'bt', 'Abrir conversa'); ab.type = 'button'; ab.onclick = function(){ abrirConversa(m.conversa); }; }
      bs.appendChild(ab);
      row.appendChild(q); row.appendChild(bs); box.appendChild(row);
    });
    var mais = el('div', 'mais'), bm = el('button', 'bt link', 'Ver as ' + (total || l.length) + ' e quem agendou'); bm.type = 'button'; bm.onclick = abrirConsultas; mais.appendChild(bm); box.appendChild(mais);
  }
  // a lista COMPLETA das consultas do período: paciente, dia e hora da consulta, quando foi marcada e quem agendou
  function dataHoraCurta(iso){ var d = new Date(iso); if (isNaN(d.getTime())) return ''; return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  function celula(tr, rotulo, conteudo, cls){ var td = el('td', cls || null); td.setAttribute('data-r', rotulo); if (typeof conteudo === 'string') td.textContent = conteudo; else td.appendChild(conteudo); tr.appendChild(td); return td; }
  function abrirConsultas(){
    var p = ULTIMO; if (!p) return;
    var lista = p.consultasDoPeriodo || p.ultimasMarcadas || [], tb = $('dlgLista'); tb.textContent = '';
    $('dlgPeriodo').textContent = ROT_PERIODO[PERIODO].charAt(0).toUpperCase() + ROT_PERIODO[PERIODO].slice(1) + ' · ' + plural(p.marcadas.agora, 'consulta', 'consultas');
    if (!lista.length) { var tr0 = el('tr'), td0 = el('td'); td0.colSpan = 5; td0.style.textAlign = 'left'; td0.appendChild(el('span', 'mut', 'A Sofia não marcou nenhuma consulta neste período.')); tr0.appendChild(td0); tb.appendChild(tr0); }
    lista.forEach(function(m){
      var tr = el('tr');
      celula(tr, 'Paciente', m.nome || ('Conversa ' + m.conversa)).style.fontWeight = '700';
      celula(tr, 'Consulta', m.agendadoPara ? consultaEm(m.agendadoPara) : '—', 'n');
      celula(tr, 'Marcada', dataHoraCurta(m.criadoEm) + ' · ' + ha(m.criadoEm), 'n');
      var q = m.quem ? el('span', 'pill so', m.quem) : el('span', 'mut', '—');
      celula(tr, 'Quem agendou', q, 'quem col-quem');
      var ab;
      if (KM) { ab = el('a', 'bt', 'Abrir cartão'); if (m.link) { ab.href = m.link; ab.target = '_blank'; ab.rel = 'noopener noreferrer'; } else ab.hidden = true; }
      else { ab = el('button', 'bt', 'Abrir conversa'); ab.type = 'button'; ab.onclick = function(){ fecharDialogo($('dlgConsultas')); abrirConversa(m.conversa); }; }
      celula(tr, '', ab);
      tb.appendChild(tr);
    });
    var tot = p.consultasTotal != null ? p.consultasTotal : p.marcadas.agora;
    $('dlgRodape').textContent = (tot > lista.length ? 'Mostrando as ' + lista.length + ' mais recentes de ' + tot + '. ' : '') + (KM ? 'A lista traz as consultas mais recentes que o Kommo registrou.' : 'Aqui entram as consultas que a Sofia marcou. As que a equipe marca direto na agenda não são registradas por esta tela.');
    abrirDialogo($('dlgConsultas'));
  }
  $('dlgFechar').addEventListener('click', function(){ fecharDialogo($('dlgConsultas')); });
  $('dlgConsultas').addEventListener('click', function(ev){ if (ev.target === $('dlgConsultas')) fecharDialogo($('dlgConsultas')); });
  function desenharRevisar(l, total){
    var box = $('listaRevisar'); box.textContent = ''; $('cRevisar').textContent = total ? (total > l.length ? (l.length + ' de ' + total) : String(total)) : '';
    if (!l.length) { var v = el('p', 'vazio'); v.appendChild(el('b', null, 'Nada para revisar. ')); v.appendChild(document.createTextNode('Para marcar uma resposta ruim, passe o mouse no balão da Sofia dentro da conversa.')); box.appendChild(v); return; }
    l.forEach(function(a){
      var c = el('div', 'caso'), q = el('div', 'q'), quem = el('span'); quem.appendChild(el('b', null, a.quemNome)); quem.appendChild(document.createTextNode(' marcou como ruim'));
      q.appendChild(quem); q.appendChild(el('span', null, 'Conversa ' + a.conversa + ' · ' + ha(a.criadoEm))); c.appendChild(q);
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
  $('tRevisar').addEventListener('click', function(){ var a = $('secRevisar'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('tPausadas').addEventListener('click', function(){ ir('pausadas'); });
  $('tPedidos').addEventListener('click', function(){ ir('pedir'); });

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
    if (KM && !KM_LIB) return;
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
  function mostrarContaPausadas(n){ $('contaPausadas').textContent = n ? String(n) : ''; $('cPausadas').textContent = n ? String(n) : ''; $('cPausadasPainel').textContent = n ? String(n) : ''; $('nPausadas').textContent = String(n || 0); }
  async function contarPausadas(){ try { var r = await api('GET', KM ? kmRota('pausadas') : '/api/public/testar-ia/pausadas'); mostrarContaPausadas(r.conversas.length); desenharPausadasPainel(r.conversas); } catch (e) {} }
  async function devolverParaASofia(c, bt, depois){
    bt.disabled = true;
    try { await api('POST', '/api/public/assistente/pausa', { conversa: c.id, acao: 'reativar' }); toast('A Sofia voltou a responder nesta conversa.'); depois(); } catch (e) { bt.disabled = false; toast(e.message, true); }
  }
  // as 3 pausadas mais recentes no painel (a lista inteira fica na aba Pausadas)
  function desenharPausadasPainel(l){
    var box = $('listaPausadasPainel'); box.textContent = '';
    if (!l.length) { var v = el('p', 'vazio'); v.appendChild(el('b', null, 'Nenhuma pausada. ')); v.appendChild(document.createTextNode('A Sofia está atendendo todas as conversas.')); box.appendChild(v); return; }
    l.slice(0, 3).forEach(function(c){
      var row = el('div', 'lin'), q = el('div'), bs = el('div', 'btns');
      q.appendChild(el('div', 'nm', c.nome));
      if (KM) {
        // modo Kommo: cartão (não conversa); a devolução com data fica na aba Pausadas
        q.appendChild(el('span', 'det', 'Pausada ' + ha(c.desde) + ' · ' + (c.por || '—') + (c.tipo === 'janela' && c.ate ? ' · até ' + dataHora(c.ate) : '')));
        if (c.link) { var ak = el('a', 'bt link', 'Abrir cartão'); ak.href = c.link; ak.target = '_blank'; ak.rel = 'noopener noreferrer'; bs.appendChild(ak); }
      } else {
        q.appendChild(el('span', 'det', 'Pausada ' + (c.em ? ha(c.em) : '') + ' · ' + (c.por || '—') + (c.atendente ? ' · com ' + c.atendente : '')));
        var ab = el('button', 'bt link', 'Abrir'), re = el('button', 'bt', 'Devolver para a Sofia');
        ab.type = re.type = 'button'; ab.onclick = function(){ abrirConversa(c.id); };
        re.onclick = function(){ devolverParaASofia(c, re, contarPausadas); };
        bs.appendChild(ab); bs.appendChild(re);
      }
      row.appendChild(q); row.appendChild(bs); box.appendChild(row);
    });
    if (l.length > 3) { var mais = el('div', 'mais'), bm = el('button', 'bt link', 'Ver as ' + l.length + ' pausadas'); bm.type = 'button'; bm.onclick = function(){ ir('pausadas'); }; mais.appendChild(bm); box.appendChild(mais); }
  }
  function linhaUnica(tb, conteudo){ var tr = el('tr'), td = el('td'); td.colSpan = 5; td.style.textAlign = 'left'; td.appendChild(conteudo); tr.appendChild(td); tb.appendChild(tr); }
  async function carregarPausadas(){
    if (KM) { carregarPausaUnidade(); }
    var tb = $('listaPausadas'); tb.textContent = '';
    var sk = el('span', 'sk'); sk.style.height = '40px'; linhaUnica(tb, sk);
    try {
      var r = await api('GET', KM ? kmRota('pausadas') : '/api/public/testar-ia/pausadas'); mostrarContaPausadas(r.conversas.length); tb.textContent = '';
      if (!r.conversas.length) { linhaUnica(tb, el('span', 'mut', 'Nenhuma conversa com a Sofia pausada agora.')); return; }
      if (KM) { r.conversas.forEach(linhaPausadaKm.bind(null, tb)); return; }
      r.conversas.forEach(function(c){
        var tr = el('tr');
        tr.appendChild(el('td', null, c.nome));
        tr.appendChild(el('td', null, c.por || '—'));
        tr.appendChild(el('td', null, c.em ? ha(c.em) : '—'));
        tr.appendChild(el('td', null, c.atendente || '—'));
        var td = el('td'), ab = el('button', 'bt link', 'Abrir'), re = el('button', 'bt', 'Devolver para a Sofia');
        ab.type = re.type = 'button'; ab.onclick = function(){ abrirConversa(c.id); };
        re.onclick = function(){ devolverParaASofia(c, re, carregarPausadas); };
        td.appendChild(ab); td.appendChild(re); tr.appendChild(td); tb.appendChild(tr);
      });
    } catch (e) { tb.textContent = ''; linhaUnica(tb, el('div', 'aviso erro', e.message)); }
  }

  // ── REGISTRO ──
  function dataHora(iso){ var d = new Date(iso); if (isNaN(d.getTime())) return ''; return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  async function carregarRegistro(){
    var box = $('listaRegistro'); box.textContent = '';
    var sk = el('span', 'sk'); sk.style.height = '60px'; box.appendChild(sk);
    var tipo = $('regTipo').value, conv = $('regConversa').value.trim();
    var q = '/api/public/agente/registro?slug=' + enc(U.slug) + (tipo ? '&tipo=' + enc(tipo) : '') + (/^\d{1,9}$/.test(conv) ? '&conversa=' + conv : '');
    try {
      var r = await api('GET', q); box.textContent = '';
      $('cRegistro').textContent = r.total ? String(r.total) : '';
      if (!r.conversas.length) { box.appendChild(tgVazioReg('Nada registrado nos últimos ' + r.dias + ' dias' + (tipo || conv ? ' com esse filtro.' : '.'))); return; }
      r.conversas.forEach(function(g){
        var bloco = el('div', 'reg'), cab = el('div', 'reg-cab');
        cab.appendChild(el('b', null, 'Conversa ' + g.conversa));
        cab.appendChild(el('span', 'meta', dataHora(g.ultima)));
        var ab = el('button', 'bt link', 'Abrir conversa'); ab.type = 'button'; ab.onclick = function(){ abrirConversa(g.conversa); }; cab.appendChild(ab);
        bloco.appendChild(cab);
        g.itens.forEach(function(i){
          var li = el('div', 'reg-it reg-' + i.tipo), tx = el('div', 'reg-tx');
          li.appendChild(el('span', 'reg-q', dataHora(i.quando)));
          tx.appendChild(el('div', null, i.titulo)); if (i.detalhe) tx.appendChild(el('div', 'meta', i.detalhe));
          li.appendChild(tx); bloco.appendChild(li);
        });
        box.appendChild(bloco);
      });
      if (r.cortado) box.appendChild(el('p', 'meta', 'Mostrando os mais recentes. Filtre por conversa ou por tipo para ver o resto.'));
    } catch (e) { box.textContent = ''; box.appendChild(el('div', 'aviso erro', e.message)); }
  }
  function tgVazioReg(txt){ return el('p', 'vazio', txt); }
  $('btRegFiltrar').addEventListener('click', carregarRegistro);
  $('regTipo').addEventListener('change', carregarRegistro);
  $('regConversa').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') carregarRegistro(); });

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
    var abertos = lista.filter(function(p){ return p.situacao !== 'resolvido'; }).length; $('contaPedidos').textContent = abertos ? String(abertos) : ''; $('nPedidos').textContent = String(abertos);
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
    try { var r = await api('GET', KM ? kmRota('pedidos') : '/api/public/agente/pedidos?slug=' + enc(U.slug)); TIPOS = r.tipos || []; desenharTipos(); desenharPedidos(r.pedidos || []); }
    catch (e) { erroEm($('listaPedidos'), e.message); }
  }
  $('btPedir').addEventListener('click', async function(){
    var b = this, texto = $('pedidoTexto').value.trim(); some('avisoPedido');
    if (!tipoPedido) { aviso('avisoPedido', 'Escolha o tipo do pedido.'); return; }
    if (texto.length < 10) { aviso('avisoPedido', 'Explique o que precisa (pelo menos uma frase).'); $('pedidoTexto').focus(); return; }
    b.disabled = true;
    try {
      var r = await api('POST', KM ? kmRota('pedidos') : '/api/public/agente/pedidos', { slug: U.slug, tipo: tipoPedido, texto: texto, conversa: pedidoConversa });
      if (revisando && revisando.aba === 'pedir') await revisar(revisando.id, 'pedido').catch(function(){});
      desvincular();
      $('pedidoTexto').value = ''; contarPedido(); desenharPedidos(r.pedidos || []);
      toast('Pedido #' + r.protocolo + ' enviado. A Doutor Digital já foi avisada.');
    } catch (e) { aviso('avisoPedido', e.message); }
    b.disabled = false;
  });

  // ── tema: o menu do CRM diz se o Chatwoot está no escuro; sem aviso, vale o do aparelho ──
  var temaDoCrm = null, mqEscuro = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function aplicarTema(t){ document.documentElement.setAttribute('data-tema', t === 'escuro' ? 'escuro' : 'claro'); if (diasDoGrafico && abaAtual === 'painel') desenharGraficos(diasDoGrafico); }
  aplicarTema(mqEscuro && mqEscuro.matches ? 'escuro' : 'claro');
  if (mqEscuro && mqEscuro.addEventListener) mqEscuro.addEventListener('change', function(){ if (!temaDoCrm) aplicarTema(mqEscuro.matches ? 'escuro' : 'claro'); });

  // ── entrada: sessão do Chatwoot pelo menu, unidade pelas caixas da pessoa ──
  function pedirSessao(){ try { window.parent.postMessage({ event: 'funil:pede-sessao' }, CW); } catch (e) {} }
  function escolherUnidade(u){
    U = u; if (!KM) guardar('agente:unidade', u.slug); $('unidadeNome').textContent = u.nome; $('heroUnidade').textContent = 'Sofia · ' + u.nome; desvincular();
    // nada da unidade anterior fica na tela: números, contadores da faixa e pedidos abertos
    painelVazio(); $('nPausadas').textContent = '—'; $('nPedidos').textContent = '—'; $('contaPedidos').textContent = '';
    EST = null; previaDe = null; $('cardPrevia').hidden = true; lerChat(); restam = null;
    if (KM && !KM_LIB) return;
    carregarPedidos();
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
  // ── modo Kommo: entrada pelo código da unidade ──
  function sairKm(msg){
    clearTimeout(tPainel); clearTimeout(tConferir); tentativasPainel = 0; tentativasConferir = 0;
    KM_COD = ''; guardar('pausa-codigo-' + KM.slug, null);
    $('corpo').hidden = true; $('kmSair').hidden = true; $('euNome').textContent = ''; $('unidadeNome').textContent = '';
    $('entradaKm').hidden = false; $('kmCodigo').value = '';
    if (msg) aviso('erroTopo', msg); else some('erroTopo');
  }
  async function tentarKm(){
    var c = $('kmCodigo').value.trim(), n = $('kmNome').value.trim();
    if (!/^[0-9]{6}$/.test(c)) { aviso('erroTopo', 'Digite os 6 dígitos do código da unidade.'); return; }
    if (n.length < 2) { aviso('erroTopo', 'Escreva o seu nome.'); return; }
    KM_COD = c; KM_NOME = n; $('kmEntrar').disabled = true;
    try {
      var e = await api('GET', kmRota('estado'));
      guardar('pausa-codigo-' + KM.slug, c); guardar('pausa-nome-' + KM.slug, n);
      KM_LIB = !!e.aprendizados; U = { slug: KM.slug, nome: e.unidade }; document.title = 'Agente · ' + e.unidade;
      $('entradaKm').hidden = true; some('erroTopo'); $('kmSair').hidden = false; $('euNome').textContent = n; $('pedidoQuem').textContent = n;
      $('aba-registro').hidden = true; $('aba-conferir').hidden = false; $('aba-pausadas').childNodes[0].nodeValue = 'Pausar'; $('thCom').textContent = 'Volta'; $('pausaUnidade').hidden = false;
      Array.prototype.forEach.call(document.querySelectorAll('.so-crm'), function(x){ x.hidden = true; });
      Array.prototype.forEach.call(document.querySelectorAll('.so-km'), function(x){ x.hidden = false; });
      $('secRevisar').hidden = true;
      $('pausadasMeta').textContent = 'A Sofia sai da frente quando alguém da equipe responde ao paciente e volta cerca de 1 hora depois da última fala da equipe. Aqui dá para devolver antes só as pausas com data.';
      // entrar de novo (a chave pode ter ligado desde a última vez): limpa o aviso e mostra as abas antes de decidir
      ['ensinar', 'testar'].forEach(function(a){ var p = $('pane-' + a); Array.prototype.forEach.call(p.querySelectorAll('.nao-liberado'), function(x){ x.remove(); }); Array.prototype.forEach.call(p.children, function(x){ x.hidden = false; }); });
      if (!KM_LIB) ['ensinar', 'testar'].forEach(function(a){
        var p = $('pane-' + a); Array.prototype.forEach.call(p.children, function(x){ x.hidden = true; });
        var v = el('p', 'vazio nao-liberado'); v.appendChild(el('b', null, 'Ainda não liberado para a sua unidade. ')); v.appendChild(document.createTextNode('Para a Sofia aprender com vocês, peça à Doutor Digital pela aba '));
        var b = el('button', 'bt link', 'Pedir à Doutor Digital'); b.type = 'button'; b.onclick = function(){ ir('pedir'); }; v.appendChild(b); p.appendChild(v);
      });
      escolherUnidade(U); $('corpo').hidden = false; ir(lerGuardado('agente:aba') || 'painel');
      if (abaAtual !== 'pausadas' && abaAtual !== 'painel') contarPausadas();
      if (abaAtual !== 'pedir') carregarPedidos();
    } catch (er) { if (er.status !== 403) aviso('erroTopo', er.message); }
    $('kmEntrar').disabled = false;
  }
  var OPCOES_PAUSA = [['hoje18', 'Até as 18h de hoje'], ['1h', 'Por 1 hora'], ['2h', 'Por 2 horas'], ['amanha8', 'Até amanhã às 8h']], pausaEscolha = 'hoje18';
  function fimDaPausa(){
    var d = new Date();
    if (pausaEscolha === '1h') return new Date(Date.now() + 3600e3);
    if (pausaEscolha === '2h') return new Date(Date.now() + 7200e3);
    if (pausaEscolha === 'amanha8') { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d; }
    d.setHours(18, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d;
  }
  OPCOES_PAUSA.forEach(function(o){ var l = el('label'), i = el('input'); l.setAttribute('data-k', o[0]); i.type = 'radio'; i.name = 'pausa'; i.value = o[0]; i.checked = o[0] === pausaEscolha; i.onchange = function(){ pausaEscolha = o[0]; }; l.appendChild(i); l.appendChild(document.createTextNode(o[1])); $('pausaOps').appendChild(l); });
  // «Até as 18h de hoje» depois das 18h viraria «amanhã às 18h»: some. A hora é a do fuso da unidade (vem da /pausa) ou, sem ela, a do aparelho (como a /pausa)
  var PAUSA_TZ = '';
  function horaAgora(){ try { var h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: PAUSA_TZ || undefined, hour: '2-digit', hourCycle: 'h23' }).format(new Date())); if (!isNaN(h)) return h; } catch (e) {} return new Date().getHours(); }
  function ajustarOpcoesPausa(){
    var tarde = horaAgora() >= 18, l = document.querySelector('#pausaOps label[data-k="hoje18"]');
    if (l) l.hidden = tarde;
    if (tarde && pausaEscolha === 'hoje18') { pausaEscolha = '1h'; var i = document.querySelector('#pausaOps input[value="1h"]'); if (i) i.checked = true; }
  }
  ajustarOpcoesPausa();
  function mostrarPausa(e){
    if (e.tz) PAUSA_TZ = e.tz; ajustarOpcoesPausa();
    var d = $('pausaDescricao'); d.textContent = '';
    var on = !!e.emPausa; d.appendChild(el('span', 'pausa-estado' + (on ? ' off' : ''), on ? 'Pausada' : (e.agendada ? 'Pausa marcada' : 'Ativa e respondendo')));
    if (e.descricao && (on || e.agendada)) d.appendChild(document.createTextNode(' · ' + e.descricao + (e.por ? ' (por ' + e.por + ')' : '')));
    $('btRetomar').hidden = !(on || e.agendada);
  }
  async function carregarPausaUnidade(){
    try { mostrarPausa(await api('GET', '/api/public/pausa/' + enc(U.slug))); } catch (e) { $('pausaDescricao').textContent = e.message; }
  }
  $('btPausar').addEventListener('click', async function(){
    var b = this; some('avisoPausa');
    // tela aberta desde antes das 18h: «Até as 18h de hoje» clicado depois das 18h pausaria até amanhã às 18h — não pausa, pede outra escolha
    if (pausaEscolha === 'hoje18' && horaAgora() >= 18) { ajustarOpcoesPausa(); aviso('avisoPausa', 'Já passou das 18h. Escolha outra opção e toque em Pausar de novo.'); return; }
    b.disabled = true;
    try { var e = await api('POST', '/api/public/pausa/' + enc(U.slug), { ate: fimDaPausa().toISOString(), motivo: $('pausaMotivo').value }); mostrarPausa(e); toast('Pronto: ' + e.descricao + '.'); }
    catch (er) { aviso('avisoPausa', er.message); }
    b.disabled = false;
  });
  $('btRetomar').addEventListener('click', async function(){
    var b = this; some('avisoPausa'); b.disabled = true;
    try { mostrarPausa(await api('DELETE', '/api/public/pausa/' + enc(U.slug), {})); toast('A Sofia voltou a responder.'); }
    catch (er) { aviso('avisoPausa', er.message); }
    b.disabled = false;
  });
  function linhaPausadaKm(tb, c){
    var tr = el('tr');
    tr.appendChild(el('td', null, c.nome)); tr.appendChild(el('td', null, c.por || '—')); tr.appendChild(el('td', null, ha(c.desde)));
    tr.appendChild(el('td', null, c.tipo === 'janela' && c.ate ? 'até ' + dataHora(c.ate) : 'depois da equipe'));
    var td = el('td');
    if (c.link) { var ab = el('a', 'bt link', 'Abrir cartão'); ab.href = c.link; ab.target = '_blank'; ab.rel = 'noopener noreferrer'; td.appendChild(ab); }
    // a pausa da equipe (a Sofia se calou porque alguém falou com o paciente) termina depois que a equipe para de falar; só a pausa com data tem «devolver»
    if (c.tipo === 'janela') {
      var re = el('button', 'bt', 'Devolver para a Sofia'); re.type = 'button';
      re.onclick = async function(){ re.disabled = true; try { await api('DELETE', '/api/public/pausa/' + enc(U.slug) + '/lead/' + c.leadId, {}); toast(c.equipeTambem ? 'Tirei a pausa com data. A equipe ainda está atendendo este cartão: a Sofia só volta depois que ela terminar.' : 'A Sofia voltou a responder neste cartão.'); carregarPausadas(); } catch (e) { re.disabled = false; toast(e.message, true); } };
      td.appendChild(re);
    }
    tr.appendChild(td); tb.appendChild(tr);
  }

  // ── CONFERIR (modo Kommo): colunas, mudanças do dia e cartões para conferir — a leitura da página /ia ──
  var tConferir = null, tentativasConferir = 0;
  function semKommo(t){ return String(t == null ? '' : t).replace(/Kommo/g, 'CRM'); }
  function horaDe(iso, tz){ try { return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)); } catch (e) { return ''; } }
  async function carregarConferir(){
    var corpo = $('conferirCorpo'), av = $('conferirAvisos'); clearTimeout(tConferir);
    try {
      var d = await api('GET', '/api/public/ia/' + enc(U.slug)), k = d.kommo || {};
      av.textContent = ''; corpo.textContent = '';
      if (!k.ok) { av.appendChild(el('div', k.carregando ? 'aviso' : 'aviso erro', semKommo(k.motivo || 'Dados do CRM indisponíveis agora.'))); }
      else {
        if (k.atualizando) av.appendChild(el('div', 'aviso', 'Atualizando… mostrando a leitura das ' + horaDe(k.lidoEm, d.tz) + '.'));
        else if (k.desatualizado) av.appendChild(el('div', 'aviso', 'Mostrando a última leitura (' + horaDe(k.lidoEm, d.tz) + '): não consegui atualizar agora.'));
        (k.avisos || []).forEach(function(a){ av.appendChild(el('div', 'aviso', semKommo(a))); });
        desenharConferir(corpo, k, d.tz);
      }
      $('conferirQuando').textContent = 'Atualizado às ' + horaDe(d.geradoEm, d.tz) + (k.ok ? ' · a leitura do CRM se renova a cada ' + d.renovaACadaMin + ' min' : '');
      if ((k.carregando || k.atualizando) && abaAtual === 'conferir') {
        if (++tentativasConferir < 20) tConferir = setTimeout(carregarConferir, 6000);
      } else tentativasConferir = 0;
    } catch (e) { corpo.textContent = ''; erroEm(corpo, e.message); }
  }
  function desenharConferir(box, k, tz){
    if (k.colunas) {
      var s1 = el('section'); s1.appendChild(el('h3', null, 'Cartões em cada coluna')); s1.appendChild(el('div', 'meta', 'Só cartões abertos (ganhos e perdidos não entram).'));
      k.colunas.forEach(function(fu){
        var t = el('div', 'meta', fu.funil + ' · ' + fu.total); t.style.marginTop = '12px'; s1.appendChild(t);
        fu.etapas.forEach(function(e){ var l = el('div', 'conf-col'); l.appendChild(el('span', null, e.nome)); l.appendChild(el('b', null, String(e.total))); s1.appendChild(l); });
      });
      box.appendChild(s1);
    }
    if (k.mudancas) {
      var m = k.mudancas, s2 = el('section'); s2.appendChild(el('h3', null, 'Mudanças de coluna hoje')); s2.appendChild(el('div', 'meta', 'Quem moveu o cartão de uma coluna para outra.'));
      if (!m.total) s2.appendChild(el('p', 'vazio', 'Nenhuma mudança de coluna hoje.'));
      else {
        s2.appendChild(el('div', 'meta', m.porTipo.map(function(t){ return t.rotulo + ': ' + t.total; }).join(' · ')));
        if (m.pessoas.length) s2.appendChild(el('div', 'meta', 'Equipe: ' + m.pessoas.map(function(p){ return p.nome + ' (' + p.total + ')'; }).join(', ')));
        m.lista.forEach(function(x){
          var l = el('div', 'conf-item'), a = el('a', null, x.paciente); a.href = x.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; l.appendChild(a);
          l.appendChild(el('div', 'f', x.de + ' → ' + x.para)); l.appendChild(el('div', 'f tipo-' + x.tipo, x.quem + ' · ' + x.hora)); s2.appendChild(l);
        });
        if (m.total > m.lista.length) s2.appendChild(el('p', 'meta', 'Mostrando as ' + m.lista.length + ' mais recentes de ' + m.total + '.'));
      }
      box.appendChild(s2);
    }
    if (k.conferir) {
      var cf = k.conferir, s3 = el('section'); s3.appendChild(el('h3', null, 'Para conferir')); s3.appendChild(el('div', 'meta', 'Cartões que parecem estar na coluna errada ou sem um dado importante.'));
      if (!cf.total) s3.appendChild(el('p', 'vazio', 'Tudo certo: nada para conferir agora.'));
      cf.grupos.forEach(function(g){
        var gr = el('div', 'conf-grupo'); gr.appendChild(el('h4', null, g.titulo + ' (' + g.total + ')'));
        g.itens.forEach(function(i){ var it = el('div', 'conf-item'), a = el('a', null, i.nome); a.href = i.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; it.appendChild(a); it.appendChild(el('div', 'f', i.oQueFazer)); gr.appendChild(it); });
        if (g.total > g.itens.length && g.regra !== 'cartao_vazio') gr.appendChild(el('p', 'meta', 'e mais ' + (g.total - g.itens.length) + ' nesta lista.'));
        s3.appendChild(gr);
      });
      box.appendChild(s3);
    }
    box.style.display = 'grid'; box.style.gap = '28px';
  }
  $('kmEntrar').addEventListener('click', tentarKm);
  $('kmCodigo').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') tentarKm(); });
  $('kmNome').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') tentarKm(); });
  // «Sair» apaga o código guardado NESTE aparelho (vale também para /pausa e /ia, que usam a mesma chave) e recarrega: nada da pessoa anterior fica na tela
  $('kmSair').addEventListener('click', function(){ clearTimeout(tPainel); clearTimeout(tConferir); KM_COD = ''; guardar('pausa-codigo-' + KM.slug, null); location.reload(); });

  window.addEventListener('message', function(ev){
    if (KM) return;
    if (!origemDoCrm(ev.origin) || ev.source !== window.parent) return;
    var d = ev.data; if (d && d.event === 'funil-tema' && (d.tema === 'escuro' || d.tema === 'claro')) { temaDoCrm = d.tema; aplicarTema(d.tema); return; }
    if (!d || d.event !== 'funil-sessao') return;
    if (d.tema === 'escuro' || d.tema === 'claro') { temaDoCrm = d.tema; aplicarTema(d.tema); }
    var novo = d.sessao && d.sessao.token ? d.sessao : null, primeira = !S && novo && !U; S = novo;
    if (primeira) entrar();
  });
  window.addEventListener('storage', function(ev){
    if (KM || ev.key !== 'testar-ia-rascunho' || !ev.newValue || !U) return;
    guardar('testar-ia-rascunho', null); $('regra').value = ev.newValue.slice(0, 800); ir('ensinar'); contar(); $('regra').focus();
  });
  // «?» do cabeçalho: abre a aula desta tela em vídeo por cima da conversa (o menu do CRM mostra o modal; aqui só se pede). Só dentro do CRM.
  if (window.parent !== window && GUIA_LIGADO) {
    $('ajuda').hidden = false;
    $('ajuda').addEventListener('click', function(){ try { window.parent.postMessage({ event: 'guia:tela', tela: 'agente' }, CW); } catch (e) {} });
  }
  if (KM) {
    $('entradaKm').hidden = false; $('unidadeNome').textContent = '';
    $('kmCodigo').value = lerGuardado('pausa-codigo-' + KM.slug) || ''; $('kmNome').value = lerGuardado('pausa-nome-' + KM.slug) || '';
    // o aparelho já guardou o código (página de pausar a Sofia ou o último acesso): entra direto
    if (/^[0-9]{6}$/.test($('kmCodigo').value) && $('kmNome').value.trim().length >= 2) tentarKm();
  } else {
    pedirSessao(); setTimeout(function(){ if (!S) pedirSessao(); }, 1500);
    setTimeout(function(){ if (!S) aviso('erroTopo', 'Abra esta tela pelo menu do CRM (Agente), já logada.'); }, 6000);
  }
})();
</script></body></html>`;

/**
 * A página das unidades do Kommo (`/agente/:slug`). `slug` vem de uma unidade que existe e está ativa; entra no JavaScript como JSON com o
 * `<` escapado (nunca fecha o `<script>`). Sem origem do Chatwoot: ninguém fala com esta página por postMessage.
 */
export function paginaDoAgenteKommo(slug: string): string {
  const km = JSON.stringify({ slug }).replace(/</g, '\\u003c');
  return comContaNaPagina(PAGINA.split('__ORIGEM_CW__').join("''").split('__KOMMO__').join(km).split('__GUIA_LIGADO__').join('false'));
}

/** A página. `origemChatwoot` = a origem do Chatwoot (só ela fala com a página por postMessage). */
export function paginaDoAgente(origemChatwoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return comContaNaPagina(PAGINA.split('__ORIGEM_CW__').join(`origemDoPai(${JSON.stringify(origemChatwoot)})`).split('__KOMMO__').join('null').split('__GUIA_LIGADO__').join(String(guiaDaEtapaLigado(env))));
}
