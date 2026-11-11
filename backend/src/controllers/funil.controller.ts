/**
 * Funil de etapas encaixado no Chatwoot (Dashboard App) — ver `lib/funil-chatwoot.ts`.
 *
 * Página `GET /funil` (o Chatwoot a abre numa aba da conversa, com `?k=<chave>`) e as rotas que ela chama:
 *   GET  /api/public/funil/quadro?caixa=<id>   colunas por etapa (até 200 conversas mais recentes)
 *   GET  /api/public/funil/caixas              caixas de entrada (o filtro do topo)
 *   POST /api/public/funil/mover               { conversaId, etapa, quem } — grava a etapa e deixa nota interna
 * Todas pedem OU o cabeçalho X-Funil-Chave (derivada do token do Chatwoot — a aba da conversa) OU o login do próprio Chatwoot
 * (X-CW-Token/Client/Uid — o item "Funil" do menu, ver `GET /funil/menu.js`); sem Chatwoot configurado, 404.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { contaChatwootDoAmbiente, criarContextoChatwoot, chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { createHash } from 'node:crypto';
import { ATRIBUTO_ETAPA, MAX_PAGINAS, chaveConfere, etapasDoAtributo, montarQuadro, nomeSeTemConta, notaDaMudanca, sessaoDosCabecalhos, type SessaoChatwoot } from '../lib/funil-chatwoot.js';

let ctx: ContextoChatwoot | null | undefined;
function contexto(): ContextoChatwoot | null {
  if (ctx === undefined) {
    const conta = contaChatwootDoAmbiente();
    ctx = conta ? criarContextoChatwoot(conta) : null;
  }
  return ctx;
}

// 30 chaves erradas por ip a cada 10 min
const erros = new Map<string, { n: number; desde: number }>();
function bloqueado(ip: string): boolean {
  const t = erros.get(ip);
  return !!t && Date.now() - t.desde < 10 * 60_000 && t.n >= 30;
}
function errou(ip: string): void {
  const t = erros.get(ip);
  if (!t || Date.now() - t.desde > 10 * 60_000) erros.set(ip, { n: 1, desde: Date.now() });
  else t.n += 1;
}

// login do Chatwoot já conferido: hash da sessão → nome de quem está logado (5 min)
const sessoes = new Map<string, { nome: string; ate: number }>();
const SESSAO_VALE_MS = 5 * 60_000;

async function quemEstaLogado(c: ContextoChatwoot, s: SessaoChatwoot): Promise<string | null> {
  const k = createHash('sha256').update(`${s.token}|${s.client}|${s.uid}`).digest('hex');
  const t = sessoes.get(k);
  if (t && t.ate > Date.now()) return t.nome;
  const r = await c
    .fetch(`${c.conta!.url}/api/v1/profile`, {
      headers: { 'access-token': s.token, client: s.client, uid: s.uid, 'token-type': 'Bearer', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    .catch(() => null);
  if (!r?.ok) return null;
  const nome = nomeSeTemConta(await r.json().catch(() => null), c.conta!.conta);
  if (!nome) return null;
  if (sessoes.size > 500) sessoes.clear();
  sessoes.set(k, { nome, ate: Date.now() + SESSAO_VALE_MS });
  return nome;
}

/** Quem pode: a chave do funil (quem = o que a página manda) ou o login do Chatwoot (quem = o nome do perfil). */
async function autorizado(req: Request, res: Response): Promise<{ c: ContextoChatwoot; logado: string | null } | null> {
  const c = contexto();
  if (!c?.conta) {
    res.status(404).json({ error: 'funil desligado (Chatwoot não configurado)' });
    return null;
  }
  const ip = req.ip ?? '?';
  if (bloqueado(ip)) {
    res.status(429).json({ error: 'muitas tentativas — aguarde 10 minutos' });
    return null;
  }
  if (chaveConfere(c.conta.token, req.get('x-funil-chave'))) return { c, logado: null };
  const sessao = sessaoDosCabecalhos((n) => req.get(n));
  const nome = sessao ? await quemEstaLogado(c, sessao) : null;
  if (nome) return { c, logado: nome };
  errou(ip);
  res.status(403).json({ error: sessao ? 'entre no Chatwoot de novo (sessão expirada)' : 'chave do funil inválida' });
  return null;
}

async function etapas(c: ContextoChatwoot): Promise<string[]> {
  // attribute_model=0: atributo de CONVERSA
  const defs = await chamar(c, 'GET', 'custom_attribute_definitions', { query: { attribute_model: '0' } }).catch(() => []);
  return etapasDoAtributo(defs);
}

export async function funilQuadroHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const { c } = a;
  try {
    const lista = await etapas(c);
    const caixa = Number(req.query.caixa);
    const base: Record<string, string> = { status: 'all', assignee_type: 'all' };
    if (Number.isInteger(caixa) && caixa > 0) base.inbox_id = String(caixa);
    const paginas: unknown[] = [];
    for (let p = 1; p <= MAX_PAGINAS; p++) {
      const pg = (await chamar(c, 'GET', 'conversations', { query: { ...base, page: String(p) } })) as any;
      paginas.push(pg);
      const n = pg?.data?.payload?.length ?? 0;
      if (n < 25) break;
    }
    res.json({ ...montarQuadro(paginas, lista), chatwoot: c.conta!.url, conta: c.conta!.conta });
  } catch (e) {
    logger.warn({ err: String(e) }, 'funil: quadro falhou');
    res.status(502).json({ error: 'não consegui ler o Chatwoot agora' });
  }
}

export async function funilCaixasHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const { c } = a;
  try {
    const r = (await chamar(c, 'GET', 'inboxes')) as any;
    const lista = Array.isArray(r?.payload) ? r.payload : [];
    res.json(lista.map((i: any) => ({ id: i.id, nome: String(i.name ?? `Caixa ${i.id}`) })));
  } catch (e) {
    logger.warn({ err: String(e) }, 'funil: caixas falhou');
    res.status(502).json({ error: 'não consegui ler o Chatwoot agora' });
  }
}

const moverSchema = z.object({
  conversaId: z.number().int().positive(),
  etapa: z.string().trim().min(1).max(60),
  quem: z.string().trim().max(80).nullable().optional(),
});

export async function funilMoverHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const { c } = a;
  const p = moverSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  // logado pelo Chatwoot: vale o nome do perfil, não o que a página mandou
  const quem = a.logado ?? p.data.quem ?? null;
  try {
    const lista = await etapas(c);
    if (!lista.includes(p.data.etapa)) {
      res.status(400).json({ error: `etapa desconhecida: ${p.data.etapa}` });
      return;
    }
    const conv = (await chamar(c, 'GET', `conversations/${p.data.conversaId}`)) as any;
    const atuais = (conv?.custom_attributes && typeof conv.custom_attributes === 'object' ? conv.custom_attributes : {}) as Record<string, unknown>;
    const de = typeof atuais[ATRIBUTO_ETAPA] === 'string' && lista.includes(atuais[ATRIBUTO_ETAPA] as string) ? (atuais[ATRIBUTO_ETAPA] as string) : lista[0];
    if (de === p.data.etapa) {
      res.json({ ok: true, igual: true });
      return;
    }
    // o Chatwoot troca o objeto inteiro: manda os atributos que já existem junto, para não apagar nenhum
    await chamar(c, 'POST', `conversations/${p.data.conversaId}/custom_attributes`, { corpo: { custom_attributes: { ...atuais, [ATRIBUTO_ETAPA]: p.data.etapa } } });
    await chamar(c, 'POST', `conversations/${p.data.conversaId}/messages`, {
      corpo: { content: notaDaMudanca(de, p.data.etapa, quem), private: true, message_type: 'outgoing' },
    }).catch((e) => logger.warn({ err: String(e), conversa: p.data.conversaId }, 'funil: a nota interna falhou (a etapa foi gravada)'));
    logger.info({ conversa: p.data.conversaId, de, para: p.data.etapa, quem }, 'funil: etapa mudada');
    res.json({ ok: true, de, para: p.data.etapa });
  } catch (e) {
    logger.warn({ err: String(e), conversa: p.data.conversaId }, 'funil: mover falhou');
    res.status(502).json({ error: 'não consegui gravar no Chatwoot agora' });
  }
}

export function paginaFunilHandler(_req: Request, res: Response): void {
  if (!contexto()?.conta) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Funil desligado.</p>');
    return;
  }
  res.type('html').send(PAGINA.replace('__ORIGEM_CW__', JSON.stringify(new URL(contexto()!.conta!.url).origin)));
}

const PAGINA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Funil · Doutor Digital</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--line:#e3e8ef;--ink:#1f2d3d;--muted:#6b7a90;--acc:#1f93ff;--ok:#44ce4b;--warn:#ffc532}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
header h1{font-size:16px;margin:0 8px 0 0}select,input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;color:inherit}
#esta{display:flex;gap:8px;align-items:center;background:#eaf4ff;border:1px solid #c7e1ff;border-radius:8px;padding:6px 10px}
#msg{color:var(--muted);font-size:13px}
.quadro{display:flex;gap:12px;padding:12px 16px 24px;overflow-x:auto;min-height:calc(100vh - 60px);align-items:flex-start}
.col{flex:0 0 260px;background:#eef2f7;border-radius:10px;padding:8px;max-height:calc(100vh - 90px);display:flex;flex-direction:column}
.col h2{font-size:13px;margin:4px 6px 8px;display:flex;justify-content:space-between;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.col .lista{overflow-y:auto;flex:1;min-height:40px;border-radius:8px}.col.alvo .lista{outline:2px dashed var(--acc)}
.cartao{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px;cursor:grab}
.cartao.esta{border-color:var(--acc);box-shadow:0 0 0 2px #c7e1ff}.cartao b{display:block;font-size:14px}
.cartao small{color:var(--muted);display:block;margin-top:2px}.cartao p{margin:6px 0 0;color:#3c4858;font-size:13px;word-break:break-word}
.tag{display:inline-block;background:#f0f4f8;border-radius:4px;padding:0 5px;margin:4px 4px 0 0;font-size:11px;color:var(--muted)}
.cartao a{color:var(--acc);text-decoration:none;font-size:12px}.cartao select{margin-top:6px;width:100%;font-size:12px}
</style></head><body>
<header><h1>Funil</h1>
<select id="caixa"><option value="">Todas as caixas</option></select>
<input id="busca" placeholder="Buscar nome" size="14">
<span id="esta" hidden>Esta conversa: <select id="estaEtapa"></select></span>
<span id="msg"></span></header>
<main class="quadro" id="quadro"></main>
<script>
(function(){
  var q=new URLSearchParams(location.search), K=q.get('k')||'', MENU=q.get('menu')==='1', ORIGEM_CW=__ORIGEM_CW__, S=null, iniciado=false;
  var $=function(id){return document.getElementById(id)};
  var ctx={conversa:null,agente:null,conta:null}, dados=null, arrastando=null;
  function msg(t){ $('msg').textContent=t||''; }
  async function api(m,p,b){ var r=await fetch('/api/public/funil/'+p,{method:m,headers:cabecalhos(),body:b?JSON.stringify(b):undefined}); var j=await r.json().catch(function(){return {}}); if(!r.ok) throw new Error(j.error||('erro '+r.status)); return j; }
  function cabecalhos(){ var h={'Content-Type':'application/json'}; if(K) h['X-Funil-Chave']=K; else if(S){ h['X-CW-Token']=S.token; h['X-CW-Client']=S.client; h['X-CW-Uid']=S.uid; } return h; }
  function el(t,c,x){ var e=document.createElement(t); if(c) e.className=c; if(x!=null) e.textContent=x; return e; }
  function quando(s){ if(!s) return ''; var d=new Date(s*1000), h=(Date.now()-d)/36e5; return h<24? d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : d.toLocaleDateString('pt-BR'); }
  function linkConversa(id){ var base=dados&&dados.chatwoot, conta=ctx.conta||(dados&&dados.conta); return base&&conta? (base+'/app/accounts/'+conta+'/conversations/'+id) : null; }
  async function mover(id,etapa){
    msg('Gravando…');
    try{ await api('POST','mover',{conversaId:id,etapa:etapa,quem:ctx.agente}); msg('Movido para '+etapa+'.'); await carregar(); }
    catch(e){ msg(e.message); }
  }
  function desenhar(){
    var termo=$('busca').value.trim().toLowerCase(), box=$('quadro'); box.textContent='';
    dados.colunas.forEach(function(col){
      var c=el('section','col'), h=el('h2'), lista=el('div','lista');
      var vis=col.cartoes.filter(function(k){ return !termo || k.nome.toLowerCase().indexOf(termo)>=0; });
      h.appendChild(el('span',null,col.etapa)); h.appendChild(el('span',null,String(vis.length))); c.appendChild(h);
      c.addEventListener('dragover',function(ev){ ev.preventDefault(); c.classList.add('alvo'); });
      c.addEventListener('dragleave',function(){ c.classList.remove('alvo'); });
      c.addEventListener('drop',function(ev){ ev.preventDefault(); c.classList.remove('alvo'); if(arrastando && arrastando.etapa!==col.etapa) mover(arrastando.id,col.etapa); });
      vis.forEach(function(k){
        var d=el('article','cartao'+(ctx.conversa===k.id?' esta':'')); d.draggable=true;
        d.addEventListener('dragstart',function(){ arrastando=k; });
        d.appendChild(el('b',null,k.nome));
        d.appendChild(el('small',null,quando(k.atividade)+(k.responsavel?(' · '+k.responsavel):'')+(k.status&&k.status!=='open'?(' · '+k.status):'')));
        if(k.ultimaMensagem) d.appendChild(el('p',null,k.ultimaMensagem));
        k.etiquetas.forEach(function(t){ d.appendChild(el('span','tag',t)); });
        var s=el('select'); dados.etapas.forEach(function(e){ var o=el('option',null,e); o.value=e; if(e===k.etapa) o.selected=true; s.appendChild(o); });
        s.addEventListener('change',function(){ mover(k.id,s.value); }); d.appendChild(s);
        var u=linkConversa(k.id); if(u){ var a=el('a',null,'abrir conversa #'+k.id); a.href=u; a.target='_top'; d.appendChild(el('br')); d.appendChild(a); }
        lista.appendChild(d);
      });
      c.appendChild(lista); box.appendChild(c);
    });
    // "esta conversa" (quando aberto como aba dentro de uma conversa)
    if(ctx.conversa){
      var achado=null; dados.colunas.forEach(function(col){ col.cartoes.forEach(function(k){ if(k.id===ctx.conversa) achado=k; }); });
      var s=$('estaEtapa'); s.textContent=''; dados.etapas.forEach(function(e){ var o=el('option',null,e); o.value=e; if(achado&&e===achado.etapa) o.selected=true; s.appendChild(o); });
      $('esta').hidden=false;
    }
  }
  async function carregar(){
    if(!K && !S){ msg(MENU? 'Entre no Chatwoot para ver o funil.' : 'Abra o funil pelo Chatwoot (falta a chave).'); return; }
    try{ dados=await api('GET','quadro'+($('caixa').value?('?caixa='+encodeURIComponent($('caixa').value)):'')); desenhar(); if(!$('msg').textContent || /Carregando/.test($('msg').textContent)) msg(dados.total+' conversas'); }
    catch(e){ msg(e.message); }
  }
  $('estaEtapa').addEventListener('change',function(){ if(ctx.conversa) mover(ctx.conversa,this.value); });
  $('caixa').addEventListener('change',carregar);
  $('busca').addEventListener('input',function(){ if(dados) desenhar(); });
  // contexto do Chatwoot (Dashboard App): conversa aberta e quem está usando — só para a nota e o destaque
  window.addEventListener('message',function(ev){
    try{ var d=typeof ev.data==='string'?JSON.parse(ev.data):ev.data;
      // item "Funil" do menu: o login do Chatwoot chega só do próprio Chatwoot
      if(d&&d.event==='funil-sessao'&&ev.origin===ORIGEM_CW&&ev.source===window.parent){ S=d.sessao&&d.sessao.token?d.sessao:null; iniciar(); return; }
      if(!d||d.event!=='appContext') return;
      var x=d.data||{}; ctx.conversa=x.conversation&&x.conversation.id||null; ctx.agente=x.currentAgent&&x.currentAgent.name||null;
      ctx.conta=(x.conversation&&x.conversation.account_id)||(x.currentAgent&&x.currentAgent.account_id)||ctx.conta;
      if(dados) desenhar(); }catch(e){}
  });
  function iniciar(){
    if(!K && !S){ carregar(); return; }
    if(iniciado){ carregar(); return; }
    iniciado=true; msg('Carregando…');
    api('GET','caixas').then(function(l){ l.forEach(function(c){ var o=el('option',null,c.nome); o.value=c.id; $('caixa').appendChild(o); }); }).catch(function(){});
    carregar(); setInterval(carregar,60000);
  }
  if(MENU){ try{ window.parent.postMessage({event:'funil:pede-sessao'},ORIGEM_CW); }catch(e){} setTimeout(function(){ if(!S&&!K) carregar(); },4000); }
  else { try{ window.parent.postMessage('chatwoot-dashboard-app:fetch-info','*'); }catch(e){} iniciar(); }
})();
</script></body></html>`;

/**
 * Script do item "Funil" no menu da esquerda do Chatwoot. Entra pelo DASHBOARD_SCRIPTS (Super Admin › configuração do
 * Chatwoot): `<script src="https://agente-vps.doutordigitalconsultoria.com/funil/menu.js" defer></script>`. Não mexe no
 * código do Chatwoot: acha o item "Contatos" no menu, põe um "Funil" logo abaixo e, ao clicar, abre o quadro por cima da
 * tela. Passa ao quadro só o login de quem já está logado no Chatwoot (o cookie da sessão dele), e só para este servidor.
 * Se um dia o Chatwoot mudar o menu e o item não achar lugar, aparece um botão "Funil" no canto (nada quebra).
 */
export function menuFunilHandler(req: Request, res: Response): void {
  const c = contexto();
  if (!c?.conta) {
    res.status(404).type('application/javascript').send('/* funil desligado */');
    return;
  }
  const host = String(req.get('host') ?? '').replace(/[^a-z0-9.:-]/gi, '');
  res
    .type('application/javascript')
    .set('Cache-Control', 'public, max-age=300')
    .set('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(MENU_JS.replace('__AGENTE__', JSON.stringify(`https://${host}`)));
}

const MENU_JS = `(function(){
  if (window.__funilMenu) return; window.__funilMenu = 1;
  var AGENTE = __AGENTE__, cam = null, fr = null;
  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  function fechar(){ if (cam) cam.style.display = 'none'; }
  function abrir(ev){
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (!cam) {
      cam = document.createElement('div');
      cam.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#f5f7fb;display:flex;flex-direction:column';
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;justify-content:flex-end;padding:6px 10px;border-bottom:1px solid #e3e8ef;background:#fff';
      var x = document.createElement('button'); x.type = 'button'; x.textContent = '\\u2715 Fechar funil';
      x.style.cssText = 'font:14px system-ui,sans-serif;padding:6px 12px;border:1px solid #e3e8ef;border-radius:6px;background:#fff;color:#1f2d3d;cursor:pointer';
      x.onclick = fechar; bar.appendChild(x);
      fr = document.createElement('iframe'); fr.src = AGENTE + '/funil?menu=1'; fr.title = 'Funil';
      fr.style.cssText = 'flex:1;border:0;width:100%';
      cam.appendChild(bar); cam.appendChild(fr); document.body.appendChild(cam);
    }
    cam.style.display = 'flex';
  }
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') fechar(); });
  window.addEventListener('message', function(ev){
    if (ev.origin !== AGENTE || !fr || ev.source !== fr.contentWindow) return;
    var d = ev.data; if (d && d.event === 'funil:pede-sessao') fr.contentWindow.postMessage({ event: 'funil-sessao', sessao: sessao() }, AGENTE);
  });
  function trocarTexto(no){
    var w = document.createTreeWalker(no, NodeFilter.SHOW_TEXT), t;
    while ((t = w.nextNode())) { if (t.nodeValue.trim()) { t.nodeValue = 'Funil'; return; } }
  }
  function por(){
    if (document.querySelector('[data-funil-menu]')) return true;
    var a = document.querySelector('aside a[href*="/contacts"], nav a[href*="/contacts"]');
    if (!a) return false;
    var item = a.closest('li') || a, novo = item.cloneNode(true);
    novo.setAttribute('data-funil-menu', '1');
    var link = novo.tagName === 'A' ? novo : novo.querySelector('a');
    if (link) { link.setAttribute('href', '#funil'); link.classList.remove('router-link-active', 'router-link-exact-active'); link.removeAttribute('aria-current'); }
    trocarTexto(novo);
    novo.addEventListener('click', abrir, true);
    item.parentNode.insertBefore(novo, item.nextSibling);
    return true;
  }
  function botao(){
    if (document.querySelector('[data-funil-menu]')) return;
    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Funil'; b.setAttribute('data-funil-menu', '1');
    b.style.cssText = 'position:fixed;left:12px;bottom:70px;z-index:2147482999;padding:8px 14px;border-radius:18px;border:0;background:#1f93ff;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    b.onclick = abrir; document.body.appendChild(b);
  }
  var espera = null;
  new MutationObserver(function(){ if (espera) return; espera = setTimeout(function(){ espera = null; por(); }, 300); }).observe(document.documentElement, { childList: true, subtree: true });
  por(); setTimeout(function(){ if (!por() && /\\/app\\/accounts\\//.test(location.pathname)) botao(); }, 8000);
})();`;
