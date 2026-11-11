/**
 * Página pública `/aprendizados/:slug`: a própria unidade ensina a Sofia (pedido da dona de Timbó, 11/11/2026).
 * Mesmo molde da pausa (`pausa.controller.ts`): sem login, protegida pelo código de 6 dígitos da unidade e pela trava
 * de tentativas por ip+unidade. Nasce desligada: chave `aprendizados-pela-unidade` por unidade (automacoes.ts).
 *
 * Por que não o conector do claude.ai: ele não filtra por unidade (Kommo, Asaas, RH de TODAS as clínicas) — dar acesso
 * a uma unidade seria vazamento. Aqui a pessoa só vê e mexe nas regras da unidade dela.
 *
 * Fluxo: escreve a regra → prévia (a Sofia responde a falas de exemplo sem e com a regra; nada gravado) → salva.
 * A regra entra no bloco `<aprendizados>` do prompt (`renderLessons`), com a trava de pronto-socorro de sempre.
 * As travas que a unidade não desliga moram em `lib/aprendizados-unidade.ts`. Cada regra salva ou desligada avisa o João.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { enviarTelegram } from '../lib/telegram.js';
import { MAX_LICOES_NO_PROMPT } from '../services/lessons.service.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import {
  CHAVE_APRENDIZADOS,
  FALAS_DE_EXEMPLO,
  MAX_CARACTERES,
  MAX_FALAS_DA_PREVIA,
  MAX_REGRAS_DA_UNIDADE,
  SOURCE_DA_UNIDADE,
  cabePrevia,
  devolverPrevia,
  normalizarRegra,
  previasRestantes,
  recusaDaRegra,
} from '../lib/aprendizados-unidade.js';
import { esc, unidadePublica } from './pausa.controller.js';
import { rodarTesteDaSofia } from './playground.controller.js';

function ligadaPara(slug: string): boolean {
  return automacaoLigada(slug, CHAVE_APRENDIZADOS, process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS);
}

/**
 * Aviso ao João de cada regra salva/desligada: é o que compensa a trava ser heurística. Pelo Telegram (DD-Avisos), não pelo
 * WhatsApp do alertas2, que está desconectado desde 09/11 (achado do sênior no #265). Falha só vai para o log.
 */
function avisar(texto: string): void {
  void enviarTelegram(texto, { canal: 'avisos' }).then((ok) => {
    if (!ok) logger.warn({ texto: texto.slice(0, 120) }, 'aprendizados: aviso ao João NÃO saiu no Telegram');
  });
}

/** Regras ligadas da unidade (todas as origens): passar de MAX_LICOES_NO_PROMPT = a nova ficaria fora do prompt real. */
function ligadasNoTotal(unitId: string): Promise<number> {
  return prisma.unitLesson.count({ where: { unitId, enabled: true } });
}

function fuso(unit: Unit): string {
  return unit.spineTimezone ?? 'America/Sao_Paulo';
}

/** Chave desligada = a unidade "não existe" aqui, antes de olhar código (não dá para sondar). */
async function unidadeComChave(req: Request, res: Response): Promise<Unit | null> {
  const slug = String(req.params.slug ?? '');
  if (!ligadaPara(slug)) {
    res.status(404).json({ error: 'unidade não encontrada' });
    return null;
  }
  return unidadePublica(req, res);
}

async function estado(unit: Unit) {
  const regras = await prisma.unitLesson.findMany({
    where: { unitId: unit.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, content: true, enabled: true, source: true, createdAt: true },
  });
  return {
    unidade: unit.name,
    slug: unit.slug,
    regras: regras.map((r) => ({
      id: r.id,
      content: r.content,
      enabled: r.enabled,
      daUnidade: r.source === SOURCE_DA_UNIDADE,
      createdAt: r.createdAt,
    })),
    previasRestantes: previasRestantes(unit.slug, fuso(unit)),
    falasDeExemplo: FALAS_DE_EXEMPLO,
    maxCaracteres: MAX_CARACTERES,
  };
}

const previaSchema = z.object({
  regra: z.string().max(MAX_CARACTERES * 2),
  falas: z.array(z.string().trim().max(500)).max(MAX_FALAS_DA_PREVIA).optional(),
});

const salvarSchema = z.object({
  regra: z.string().max(MAX_CARACTERES * 2),
  por: z.string().trim().min(2).max(80),
});

const ligarSchema = z.object({
  enabled: z.boolean(),
  por: z.string().trim().min(2).max(80),
});

// ── rotas públicas (com código) ─────────────────────────────────────────────
export async function publicAprendizadosHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  res.json(await estado(unit));
}

export async function publicAprendizadosPreviaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  const parsed = previaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  const regra = normalizarRegra(parsed.data.regra);
  const recusa = recusaDaRegra(regra);
  if (recusa) {
    res.status(422).json({ error: recusa });
    return;
  }
  const falas = (parsed.data.falas ?? []).filter(Boolean);
  const usar = (falas.length > 0 ? falas : [...FALAS_DE_EXEMPLO]).slice(0, MAX_FALAS_DA_PREVIA);
  if ((await ligadasNoTotal(unit.id)) >= MAX_LICOES_NO_PROMPT) {
    res.status(422).json({ error: `A Sofia já tem ${MAX_LICOES_NO_PROMPT} regras ligadas nesta unidade, o máximo que ela lê. Desligue uma antes.` });
    return;
  }
  if (!cabePrevia(unit.slug, fuso(unit))) {
    res.status(429).json({ error: 'As prévias de hoje acabaram. Amanhã libera de novo — ou salve a regra e acompanhe as conversas.' });
    return;
  }
  // "antes" e "depois" de cada fala em paralelo: a pessoa espera uma vez só; com prazo, para a página não ficar presa
  const PRAZO_MS = 120_000;
  let prazo: NodeJS.Timeout | undefined;
  const estourou = new Promise<'prazo'>((ok) => {
    prazo = setTimeout(() => ok('prazo'), PRAZO_MS);
  });
  const todas = Promise.all(
    usar.map(async (fala) => {
      const msgs = [{ role: 'user' as const, content: fala }];
      const [antes, depois] = await Promise.all([
        rodarTesteDaSofia(unit, msgs),
        rodarTesteDaSofia(unit, msgs, { aprendizadosExtras: [regra] }),
      ]);
      return { fala, antes, depois };
    }),
  );
  const corrida = await Promise.race([todas, estourou]).finally(() => clearTimeout(prazo));
  if (corrida === 'prazo') {
    devolverPrevia(unit.slug, fuso(unit));
    logger.warn({ unit: unit.slug }, 'aprendizados: a prévia passou de 2 min');
    res.status(504).json({ error: 'A Sofia demorou demais para responder a prévia. Tente de novo em instantes (esta não contou).' });
    return;
  }
  const rodadas = corrida;
  const falhou = rodadas.find((r) => !r.antes.ok || !r.depois.ok);
  if (falhou) {
    devolverPrevia(unit.slug, fuso(unit));
    const erro = !falhou.antes.ok ? falhou.antes : !falhou.depois.ok ? falhou.depois : null;
    logger.warn({ unit: unit.slug, erro }, 'aprendizados: a prévia falhou');
    res.status(502).json({ error: 'A Sofia não respondeu a prévia agora. Tente de novo em instantes (esta não contou).' });
    return;
  }
  logger.info({ unit: unit.slug, regra }, 'aprendizados: prévia rodada');
  res.json({
    regra,
    resultados: rodadas.map((r) => ({
      fala: r.fala,
      antes: r.antes.ok ? r.antes.reply : '',
      depois: r.depois.ok ? r.depois.reply : '',
    })),
    previasRestantes: previasRestantes(unit.slug, fuso(unit)),
  });
}

export async function publicAprendizadosSalvarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  const parsed = salvarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Escreva a regra e o seu nome.' });
    return;
  }
  const regra = normalizarRegra(parsed.data.regra);
  const recusa = recusaDaRegra(regra);
  if (recusa) {
    res.status(422).json({ error: recusa });
    return;
  }
  const ligadas = await prisma.unitLesson.count({ where: { unitId: unit.id, source: SOURCE_DA_UNIDADE, enabled: true } });
  if (ligadas >= MAX_REGRAS_DA_UNIDADE) {
    res.status(422).json({ error: `Já são ${ligadas} regras ligadas. Desligue uma que não vale mais antes de criar outra.` });
    return;
  }
  const total = await ligadasNoTotal(unit.id);
  if (total >= MAX_LICOES_NO_PROMPT) {
    res.status(422).json({ error: `A Sofia já tem ${total} regras ligadas nesta unidade, o máximo que ela lê. Desligue uma antes de criar outra.` });
    return;
  }
  const igual = await prisma.unitLesson.findFirst({ where: { unitId: unit.id, content: regra, enabled: true } });
  if (igual) {
    res.status(409).json({ error: 'Essa regra já está ligada.' });
    return;
  }
  const criada = await prisma.unitLesson.create({ data: { unitId: unit.id, content: regra, source: SOURCE_DA_UNIDADE, enabled: true } });
  const por = parsed.data.por;
  logger.info({ unit: unit.slug, por, lessonId: criada.id, regra }, 'aprendizados: regra salva pela unidade');
  avisar(`🧠 ${unit.name}: ${por} ensinou a Sofia (página de aprendizados)\n"${regra}"`);
  res.json(await estado(unit));
}

export async function publicAprendizadosLigarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  const parsed = ligarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Escreva o seu nome.' });
    return;
  }
  const id = String(req.params.id ?? '');
  // a unidade só mexe no que ela escreveu: as regras do painel (João, reflexão) ficam só para leitura
  const regra = await prisma.unitLesson.findFirst({ where: { id, unitId: unit.id, source: SOURCE_DA_UNIDADE } });
  if (!regra) {
    res.status(404).json({ error: 'regra não encontrada' });
    return;
  }
  if (parsed.data.enabled) {
    // religar passa pelas travas de hoje e pelo teto, como uma regra nova
    const recusa = recusaDaRegra(regra.content);
    if (recusa) {
      res.status(422).json({ error: recusa });
      return;
    }
    const ligadas = await prisma.unitLesson.count({ where: { unitId: unit.id, source: SOURCE_DA_UNIDADE, enabled: true } });
    if (!regra.enabled && ligadas >= MAX_REGRAS_DA_UNIDADE) {
      res.status(422).json({ error: `Já são ${ligadas} regras ligadas. Desligue uma antes.` });
      return;
    }
    if (!regra.enabled && (await ligadasNoTotal(unit.id)) >= MAX_LICOES_NO_PROMPT) {
      res.status(422).json({ error: `A Sofia já tem ${MAX_LICOES_NO_PROMPT} regras ligadas nesta unidade, o máximo que ela lê. Desligue uma antes.` });
      return;
    }
    const igual = await prisma.unitLesson.findFirst({ where: { unitId: unit.id, content: regra.content, enabled: true, NOT: { id: regra.id } } });
    if (igual) {
      res.status(409).json({ error: 'Essa regra já está ligada.' });
      return;
    }
  }
  await prisma.unitLesson.update({ where: { id: regra.id }, data: { enabled: parsed.data.enabled } });
  const por = parsed.data.por;
  logger.info({ unit: unit.slug, por, lessonId: regra.id, enabled: parsed.data.enabled }, 'aprendizados: regra ligada/desligada pela unidade');
  avisar(`🧠 ${unit.name}: ${por} ${parsed.data.enabled ? 'religou' : 'desligou'} a regra (página de aprendizados)\n"${regra.content}"`);
  res.json(await estado(unit));
}

// ── a página ─────────────────────────────────────────────────────────────────
export async function paginaAprendizadosHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug ?? '');
  const unit = ligadaPara(slug) ? await prisma.unit.findUnique({ where: { slug }, select: { name: true, isActive: true } }) : null;
  if (!unit || !unit.isActive) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Ensinar a Sofia</title><p style="font-family:sans-serif;padding:24px">Página não encontrada.</p>');
    return;
  }
  res.type('html').send(paginaHtml(slug, unit.name));
}

function paginaHtml(slug: string, nome: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ensinar a Sofia · ${esc(nome)}</title>
<style>
:root{--bg:#0B0B11;--s1:#13131B;--s2:#1A1A24;--line:#2A2A36;--ink:#F5F5F7;--ink2:#C7C8D1;--muted:#8A8C97;--acc:#3D6BFF;--ok:#04D361;--warn:#E9B949;--red:#F75A68}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;padding:20px 16px 48px}
main{max-width:560px;margin:0 auto}h1{font-size:22px;font-weight:600;margin:6px 0 2px}h2{font-size:16px;font-weight:600;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.card{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 6px;letter-spacing:.02em}
input,textarea{width:100%;background:var(--s2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit;padding:12px}
textarea{min-height:96px;resize:vertical}input:focus,textarea:focus{outline:2px solid var(--acc);border-color:transparent}
[hidden]{display:none!important}
button.main{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:var(--acc);color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer}
button.main.ok{background:var(--ok);color:#06210F}button:disabled{opacity:.55;cursor:default}
.msg{margin-top:10px;padding:10px 12px;border-radius:10px;font-size:14px;white-space:pre-wrap}.msg.ok{background:rgba(4,211,97,.12);color:#8FEFB4}.msg.err{background:rgba(247,90,104,.12);color:#FFB3B9}
.count{float:right;color:var(--muted);font-size:12px}
.regra{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}.regra:first-child{border-top:0}
.regra p{margin:0;flex:1;color:var(--ink2);white-space:pre-wrap;word-break:break-word}.regra.off p{color:var(--muted)}.regra.off .txt{text-decoration:line-through}
.tag{font-size:11px;color:var(--muted);display:block;margin-top:2px}
.sw{flex:none;border:1px solid var(--line);background:var(--s2);color:var(--ink);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
.sw.on{border-color:var(--ok);color:#8FEFB4}
.res{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.res:first-child{border-top:0;margin-top:0;padding-top:0}
.bolha{border-radius:12px;padding:10px 12px;margin:6px 0;white-space:pre-wrap;word-break:break-word;font-size:15px}
.pac{background:var(--s2)}.antes{background:rgba(138,140,151,.12);color:var(--ink2)}.depois{background:rgba(61,107,255,.16)}
.rot{font-size:12px;color:var(--muted);margin-top:8px}
.foot{color:var(--muted);font-size:12.5px;margin-top:18px}
</style></head><body><main>
<p class="sub" style="margin:0">Doutor Digital · Sofia</p>
<h1>${esc(nome)}</h1>
<p class="sub">Ensine a Sofia: escreva o que ela deve fazer diferente, veja a resposta dela antes e depois, e salve.</p>

<div class="card">
  <label for="codigo">Código da unidade</label>
  <input id="codigo" inputmode="numeric" maxlength="6" placeholder="6 dígitos" autocomplete="one-time-code">
  <label for="por">Seu nome</label>
  <input id="por" placeholder="Quem está ensinando" maxlength="80">
  <div id="msgTopo" class="msg" hidden></div>
</div>

<div id="corpo" hidden>
<div class="card">
  <h2>Nova regra</h2>
  <label for="regra">O que a Sofia deve fazer diferente? <span class="count" id="cnt"></span></label>
  <textarea id="regra" placeholder="Ex.: Quando o paciente disser que vai falar com a família, ofereça mandar o endereço e o valor por escrito para ele mostrar."></textarea>
  <details style="margin-top:10px"><summary style="color:var(--muted);font-size:14px;cursor:pointer">Falas de paciente para testar (pode trocar)</summary>
    <input id="f0" style="margin-top:8px" maxlength="500"><input id="f1" style="margin-top:8px" maxlength="500"><input id="f2" style="margin-top:8px" maxlength="500">
  </details>
  <button class="main" id="btnPrevia">Ver prévia</button>
  <div id="msgPrevia" class="msg" hidden></div>
</div>

<div class="card" id="cardRes" hidden>
  <h2>Prévia</h2>
  <p class="sub" style="margin:0 0 8px">Nada foi gravado ainda. Gostou? Salve abaixo.</p>
  <div id="res"></div>
  <button class="main ok" id="btnSalvar">Salvar regra</button>
  <div id="msgSalvar" class="msg" hidden></div>
</div>

<div class="card">
  <h2>Regras que a Sofia segue nesta unidade</h2>
  <div id="lista"></div>
</div>
</div>

<p class="foot">A regra vale na hora para as próximas conversas desta unidade. Algumas coisas não mudam por aqui e a página avisa: pronto-socorro, sinal de alerta, promessa de cura, valor e desconto, diagnóstico e remédio. A equipe da Doutor Digital é avisada de cada regra salva ou desligada.</p>
</main>
<script>
(function(){
  var SLUG=${JSON.stringify(slug)}; var API='/api/public/aprendizados/'+encodeURIComponent(SLUG);
  var $=function(id){return document.getElementById(id)};
  var KC='pausa-codigo-'+SLUG, KN='aprendizados-nome-'+SLUG;
  try{ $('codigo').value=localStorage.getItem(KC)||''; $('por').value=localStorage.getItem(KN)||localStorage.getItem('pausa-nome-'+SLUG)||''; }catch(e){}
  var MAX=400, previaDe=null, falasPadrao=[];
  function aviso(id,txt,ok){ var m=$(id); m.textContent=txt; m.className='msg '+(ok?'ok':'err'); m.hidden=false; }
  function some(id){ $(id).hidden=true; }
  function codigo(){ var c=$('codigo').value.trim(); try{ localStorage.setItem(KC,c); localStorage.setItem(KN,$('por').value.trim()); }catch(e){} return c; }
  async function api(method,path,body){ var url=API+(path||'')+(method==='GET'?('?codigo='+encodeURIComponent(codigo())):''); var r=await fetch(url,{method:method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(Object.assign({codigo:codigo()},body||{}))}); var j=await r.json().catch(function(){return {}}); if(!r.ok) throw new Error(j.error||('erro '+r.status)); return j; }
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  function quando(iso){ var d=new Date(iso); return d.toLocaleDateString('pt-BR'); }
  function mostrar(e){
    MAX=e.maxCaracteres||400; falasPadrao=e.falasDeExemplo||[];
    ['f0','f1','f2'].forEach(function(id,i){ if(!$(id).value) $(id).value=falasPadrao[i]||''; });
    $('corpo').hidden=false; some('msgTopo'); contar();
    var l=$('lista'); l.textContent='';
    if(!e.regras.length){ l.appendChild(el('p','sub','Nenhuma regra ainda.')); }
    e.regras.forEach(function(r){
      var row=el('div','regra'+(r.enabled?'':' off')); var p=el('p'); p.appendChild(el('span','txt',r.content));
      p.appendChild(el('span','tag',(r.daUnidade?'escrita pela unidade':'da equipe Doutor Digital — só leitura')+' · '+quando(r.createdAt)+(r.enabled?'':' · desligada')));
      row.appendChild(p);
      if(r.daUnidade){ var b=el('button','sw'+(r.enabled?' on':''),r.enabled?'Ligada':'Desligada'); b.addEventListener('click',function(){ ligar(r.id,!r.enabled,b); }); row.appendChild(b); }
      l.appendChild(row);
    });
    $('btnPrevia').textContent='Ver prévia'+(e.previasRestantes!=null?(' ('+e.previasRestantes+' hoje)'):'');
  }
  async function carregar(){ if(codigo().length!==6){ $('corpo').hidden=true; return; } try{ mostrar(await api('GET')); }catch(e){ $('corpo').hidden=true; aviso('msgTopo',e.message,false); } }
  function contar(){ var n=$('regra').value.trim().length; $('cnt').textContent=n+'/'+MAX; if(previaDe!==null && $('regra').value.trim()!==previaDe){ $('cardRes').hidden=true; previaDe=null; } }
  async function ligar(id,on,b){ if($('por').value.trim().length<2){ aviso('msgTopo','Escreva o seu nome antes.',false); return; } b.disabled=true; try{ mostrar(await api('POST','/regra/'+encodeURIComponent(id),{enabled:on,por:$('por').value.trim()})); }catch(e){ aviso('msgTopo',e.message,false); b.disabled=false; } }
  $('regra').addEventListener('input',contar);
  // só consulta quando o código muda: cada tentativa gasta da trava de tentativas (a mesma da página de pausa)
  var ultimoCodigo=null;
  function tentar(){ var c=$('codigo').value.trim(); if(c.length===6 && c!==ultimoCodigo){ ultimoCodigo=c; carregar(); } }
  $('codigo').addEventListener('keyup',tentar);
  $('codigo').addEventListener('change',tentar);
  $('btnPrevia').addEventListener('click',async function(){
    var b=this, regra=$('regra').value.trim(); some('msgPrevia');
    if(regra.length<10){ aviso('msgPrevia','Escreva a regra primeiro.',false); return; }
    b.disabled=true; var txt=b.textContent; b.textContent='A Sofia está respondendo… (até 1 minuto)';
    try{
      var falas=['f0','f1','f2'].map(function(id){return $(id).value.trim()}).filter(Boolean);
      var r=await api('POST','/previa',{regra:regra,falas:falas});
      var box=$('res'); box.textContent='';
      r.resultados.forEach(function(x){ var d=el('div','res'); d.appendChild(el('div','rot','Paciente')); d.appendChild(el('div','bolha pac',x.fala)); d.appendChild(el('div','rot','Sofia hoje')); d.appendChild(el('div','bolha antes',x.antes)); d.appendChild(el('div','rot','Sofia com a regra nova')); d.appendChild(el('div','bolha depois',x.depois)); box.appendChild(d); });
      previaDe=regra; $('cardRes').hidden=false; some('msgSalvar'); $('btnSalvar').disabled=false;
      txt='Ver prévia ('+r.previasRestantes+' hoje)';
      $('cardRes').scrollIntoView({behavior:'smooth'});
    }catch(e){ aviso('msgPrevia',e.message,false); }
    finally{ b.disabled=false; b.textContent=txt; }
  });
  $('btnSalvar').addEventListener('click',async function(){
    var b=this; if($('por').value.trim().length<2){ aviso('msgSalvar','Escreva o seu nome lá em cima.',false); return; }
    if(previaDe===null || $('regra').value.trim()!==previaDe){ aviso('msgSalvar','O texto mudou: veja a prévia de novo.',false); return; }
    b.disabled=true;
    try{ mostrar(await api('POST','',{regra:previaDe,por:$('por').value.trim()})); aviso('msgSalvar','Pronto: a Sofia já segue essa regra nas próximas conversas.',true); $('regra').value=''; previaDe=null; contar(); }
    catch(e){ aviso('msgSalvar',e.message,false); b.disabled=false; }
  });
  ultimoCodigo=$('codigo').value.trim()||null; carregar();
})();
</script></body></html>`;
}
