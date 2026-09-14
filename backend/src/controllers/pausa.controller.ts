/**
 * Pausa da IA pela recepção: página pública `/pausa/:slug` (protegida por código de
 * 6 dígitos da unidade) + rotas autenticadas do painel. "Pausar até as 18h" e às 18h
 * a Sofia volta sozinha — cada caminho (resposta, régua, reativação, véspera) pergunta
 * `emPausa(unit)` na hora de agir.
 */
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { avisarJoao } from '../lib/alerta-whatsapp.js';
import { descreverPausa, emPausa, pausaAgendada, validarPedidoDePausa } from '../lib/pausa-unidade.js';

// ── proteção da rota pública: 12 tentativas por ip+unidade a cada 10 min ─────
const tentativas = new Map<string, { n: number; desde: number }>();
const JANELA_MS = 10 * 60_000;
const MAX_TENTATIVAS = 12;

function excedeu(chave: string): boolean {
  const agora = Date.now();
  const t = tentativas.get(chave);
  if (!t || agora - t.desde > JANELA_MS) {
    tentativas.set(chave, { n: 1, desde: agora });
    return false;
  }
  t.n += 1;
  return t.n > MAX_TENTATIVAS;
}

function codigoConfere(unit: Pick<Unit, 'pausaCodigo'>, codigo: unknown): boolean {
  if (!unit.pausaCodigo || typeof codigo !== 'string') return false;
  const a = Buffer.from(unit.pausaCodigo.padEnd(12, ' '));
  const b = Buffer.from(codigo.trim().padEnd(12, ' ').slice(0, 12));
  return a.length === b.length && timingSafeEqual(a, b);
}

function estado(unit: Unit) {
  const tz = unit.spineTimezone ?? 'America/Sao_Paulo';
  return {
    unidade: unit.name,
    slug: unit.slug,
    tz,
    emPausa: emPausa(unit),
    agendada: pausaAgendada(unit),
    pausaDesde: unit.pausaDesde,
    pausaAte: unit.pausaAte,
    motivo: unit.pausaMotivo,
    por: unit.pausaPor,
    descricao: descreverPausa(unit, tz),
    agora: new Date(),
  };
}

const pedidoSchema = z.object({
  ate: z.string().min(10),
  desde: z.string().min(10).nullable().optional(),
  motivo: z.string().trim().max(200).nullable().optional(),
  por: z.string().trim().max(80).nullable().optional(),
});

async function aplicarPausa(unit: Unit, body: unknown, quemPadrao: string | null): Promise<{ ok: true; unit: Unit } | { ok: false; erro: string }> {
  const parsed = pedidoSchema.safeParse(body);
  if (!parsed.success) return { ok: false, erro: 'pedido inválido' };
  const ate = new Date(parsed.data.ate);
  const desde = parsed.data.desde ? new Date(parsed.data.desde) : null;
  const erro = validarPedidoDePausa({ ate, desde });
  if (erro) return { ok: false, erro };
  const por = parsed.data.por?.trim() || quemPadrao;
  const atualizada = await prisma.unit.update({
    where: { id: unit.id },
    data: { pausaAte: ate, pausaDesde: desde && desde > new Date() ? desde : null, pausaMotivo: parsed.data.motivo?.trim() || null, pausaPor: por },
  });
  const desc = descreverPausa(atualizada, atualizada.spineTimezone ?? 'America/Sao_Paulo');
  logger.info({ unit: unit.slug, por, ate, desde }, 'pausa da IA ligada pela unidade');
  void avisarJoao(`⏸️ ${unit.name}: ${desc}`, `pausa:${unit.slug}:${ate.getTime()}`, 1);
  return { ok: true, unit: atualizada };
}

async function retomar(unit: Unit, por: string | null): Promise<Unit> {
  const atualizada = await prisma.unit.update({
    where: { id: unit.id },
    data: { pausaAte: null, pausaDesde: null, pausaMotivo: null, pausaPor: null },
  });
  logger.info({ unit: unit.slug, por }, 'pausa da IA desligada pela unidade');
  void avisarJoao(`▶️ ${unit.name}: IA retomada agora${por ? ` por ${por}` : ''}.`, `retomar:${unit.slug}:${Date.now()}`, 1);
  return atualizada;
}

async function unidadePublica(req: Request, res: Response): Promise<Unit | null> {
  const slug = String(req.params.slug ?? '');
  const codigo = (req.method === 'GET' ? req.query.codigo : (req.body as { codigo?: unknown })?.codigo) as unknown;
  const chave = `${req.ip}:${slug}`;
  if (excedeu(chave)) {
    res.status(429).json({ error: 'muitas tentativas — aguarde 10 minutos' });
    return null;
  }
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit || !unit.isActive) {
    res.status(404).json({ error: 'unidade não encontrada' });
    return null;
  }
  if (!codigoConfere(unit, codigo)) {
    res.status(403).json({ error: 'código inválido' });
    return null;
  }
  tentativas.delete(chave);
  return unit;
}

// ── rotas públicas (recepção, com código) ────────────────────────────────────
export async function publicStatusHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  res.json(estado(unit));
}

export async function publicPausarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  const r = await aplicarPausa(unit, req.body, 'recepção');
  if (!r.ok) {
    res.status(400).json({ error: r.erro });
    return;
  }
  res.json(estado(r.unit));
}

export async function publicRetomarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  const por = typeof (req.body as { por?: unknown })?.por === 'string' ? String((req.body as { por: string }).por).trim() : null;
  res.json(estado(await retomar(unit, por || 'recepção')));
}

// ── rotas do painel (sessão) ─────────────────────────────────────────────────
async function unidadeDoPainel(req: Request, res: Response): Promise<Unit | null> {
  const unit = await prisma.unit.findUnique({ where: { id: String(req.params.id ?? '') } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return null;
  }
  return unit;
}

export async function unitPausaGetHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoPainel(req, res);
  if (!unit) return;
  res.json({ ...estado(unit), codigo: unit.pausaCodigo, link: `${req.protocol}://${req.get('host')}/pausa/${unit.slug}` });
}

export async function unitPausarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoPainel(req, res);
  if (!unit) return;
  const quem = req.user?.name || req.user?.email || 'painel';
  const r = await aplicarPausa(unit, req.body, quem);
  if (!r.ok) {
    res.status(400).json({ error: r.erro });
    return;
  }
  res.json(estado(r.unit));
}

export async function unitRetomarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoPainel(req, res);
  if (!unit) return;
  res.json(estado(await retomar(unit, req.user?.name || req.user?.email || 'painel')));
}

// ── página da recepção ───────────────────────────────────────────────────────
export async function paginaPausaHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug ?? '');
  const unit = await prisma.unit.findUnique({ where: { slug }, select: { name: true, isActive: true, spineTimezone: true } });
  if (!unit || !unit.isActive) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Pausa da IA</title><p style="font-family:sans-serif;padding:24px">Unidade não encontrada.</p>');
    return;
  }
  res.type('html').send(paginaHtml(slug, unit.name));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function paginaHtml(slug: string, nome: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pausar a Sofia · ${esc(nome)}</title>
<style>
:root{--bg:#0B0B11;--s1:#13131B;--s2:#1A1A24;--line:#2A2A36;--ink:#F5F5F7;--ink2:#C7C8D1;--muted:#8A8C97;--acc:#3D6BFF;--ok:#04D361;--warn:#E9B949;--red:#F75A68}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;padding:20px 16px 48px}
main{max-width:520px;margin:0 auto}h1{font-size:22px;font-weight:600;margin:6px 0 2px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.card{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
.status{display:flex;gap:12px;align-items:center}.dot{width:14px;height:14px;border-radius:50%;background:var(--ok);flex:none;box-shadow:0 0 0 4px rgba(4,211,97,.15)}.dot.off{background:var(--warn);box-shadow:0 0 0 4px rgba(233,185,73,.15)}
.status b{display:block;font-size:17px}.status small{color:var(--muted)}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 6px;letter-spacing:.02em}
input,select,textarea{width:100%;background:var(--s2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit;padding:12px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--acc);border-color:transparent}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:8px}.opt{background:var(--s2);border:1px solid var(--line);border-radius:12px;padding:12px;cursor:pointer;text-align:left;color:var(--ink);font:inherit}
.opt[aria-pressed=true]{border-color:var(--acc);background:rgba(61,107,255,.14)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}[hidden]{display:none!important}
button.main{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:var(--acc);color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer}
button.main.red{background:var(--red)}button:disabled{opacity:.6;cursor:default}
.msg{margin-top:10px;padding:10px 12px;border-radius:10px;font-size:14px}.msg.ok{background:rgba(4,211,97,.12);color:#8FEFB4}.msg.err{background:rgba(247,90,104,.12);color:#FFB3B9}
.foot{color:var(--muted);font-size:12.5px;margin-top:18px}
</style></head><body><main>
<p class="sub" style="margin:0">Doutor Digital · Sofia</p>
<h1>${esc(nome)}</h1>
<p class="sub">Pausa a Sofia por um tempo e ela volta sozinha no horário marcado.</p>

<div class="card"><div class="status"><span class="dot" id="dot"></span><div><b id="st">Carregando…</b><small id="stsub">&nbsp;</small></div></div></div>

<div class="card">
  <label for="codigo">Código da unidade</label>
  <input id="codigo" inputmode="numeric" maxlength="6" placeholder="6 dígitos" autocomplete="one-time-code">
  <label for="por">Seu nome</label>
  <input id="por" placeholder="Quem está pausando" maxlength="80">
</div>

<div class="card" id="cardPausar">
  <label>Até quando?</label>
  <div class="opts" id="opts">
    <button class="opt" data-k="hoje18" aria-pressed="true">Até as 18h de hoje</button>
    <button class="opt" data-k="1h">Por 1 hora</button>
    <button class="opt" data-k="2h">Por 2 horas</button>
    <button class="opt" data-k="amanha8">Até amanhã às 8h</button>
    <button class="opt" data-k="custom" style="grid-column:1/-1">Escolher dia e horário…</button>
  </div>
  <div id="custom" hidden>
    <div class="row"><div><label for="desde">Começa em (opcional)</label><input id="desde" type="datetime-local"></div><div><label for="ate">Termina em</label><input id="ate" type="datetime-local"></div></div>
  </div>
  <label for="motivo">Motivo (opcional)</label>
  <input id="motivo" placeholder="Ex.: reunião, feriado local, sistema fora" maxlength="200">
  <button class="main" id="btnPausar">Pausar a Sofia</button>
  <div id="msg" class="msg" hidden></div>
</div>

<div class="card" id="cardRetomar" hidden>
  <button class="main red" id="btnRetomar">Retomar a Sofia agora</button>
  <div id="msg2" class="msg" hidden></div>
</div>

<p class="foot">Enquanto pausada, a Sofia não responde pacientes, não cobra lead parado e não manda lembrete. Quem escreve nesse período fica com a equipe. Ela volta sozinha no horário marcado.</p>
</main>
<script>
(function(){
  var SLUG=${JSON.stringify(slug)}; var API='/api/public/pausa/'+encodeURIComponent(SLUG);
  var $=function(id){return document.getElementById(id)};
  var KC='pausa-codigo-'+SLUG, KN='pausa-nome-'+SLUG;
  try{ $('codigo').value=localStorage.getItem(KC)||''; $('por').value=localStorage.getItem(KN)||''; }catch(e){}
  var escolha='hoje18';
  $('opts').addEventListener('click',function(e){ var b=e.target.closest('.opt'); if(!b) return; escolha=b.dataset.k; [].forEach.call(document.querySelectorAll('.opt'),function(o){o.setAttribute('aria-pressed',String(o===b))}); $('custom').hidden=escolha!=='custom'; });
  function pad(n){return String(n).padStart(2,'0')}
  function fim(){ var d=new Date();
    if(escolha==='hoje18'){ d.setHours(18,0,0,0); if(d<=new Date()){ d.setDate(d.getDate()+1); } return {ate:d}; }
    if(escolha==='1h') return {ate:new Date(Date.now()+3600e3)};
    if(escolha==='2h') return {ate:new Date(Date.now()+7200e3)};
    if(escolha==='amanha8'){ d.setDate(d.getDate()+1); d.setHours(8,0,0,0); return {ate:d}; }
    var a=$('ate').value, s=$('desde').value; if(!a) throw new Error('Escolha a hora de término.');
    return {ate:new Date(a), desde:s?new Date(s):null}; }
  function fmt(iso){ if(!iso) return ''; var d=new Date(iso); return pad(d.getDate())+'/'+pad(d.getMonth()+1)+' às '+pad(d.getHours())+':'+pad(d.getMinutes()); }
  function mostrar(e){ var on=e.emPausa; $('dot').className='dot'+(on?' off':'');
    $('st').textContent=on?('Pausada até '+fmt(e.pausaAte)):(e.agendada?('Ativa — pausa marcada de '+fmt(e.pausaDesde)+' até '+fmt(e.pausaAte)):'Ativa e respondendo');
    $('stsub').textContent=(e.por?('por '+e.por):'')+(e.motivo?(' · '+e.motivo):'')||'\\u00a0';
    $('cardRetomar').hidden=!(on||e.agendada); }
  function aviso(id,txt,ok){ var m=$(id); m.textContent=txt; m.className='msg '+(ok?'ok':'err'); m.hidden=false; }
  function codigo(){ var c=$('codigo').value.trim(); try{ localStorage.setItem(KC,c); localStorage.setItem(KN,$('por').value.trim()); }catch(e){} return c; }
  async function api(method,body){ var r=await fetch(API+(method==='GET'?('?codigo='+encodeURIComponent(codigo())):''),{method:method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(Object.assign({codigo:codigo()},body||{}))}); var j=await r.json().catch(function(){return {}}); if(!r.ok) throw new Error(j.error||('erro '+r.status)); return j; }
  async function carregar(){ if(!codigo()){ $('st').textContent='Digite o código da unidade para ver o status'; $('stsub').textContent='\\u00a0'; return; } try{ mostrar(await api('GET')); }catch(e){ $('st').textContent=e.message; } }
  $('codigo').addEventListener('change',carregar); $('codigo').addEventListener('keyup',function(){ if($('codigo').value.length===6) carregar(); });
  $('btnPausar').addEventListener('click',async function(){ var b=this; b.disabled=true; try{ var f=fim(); var e=await api('POST',{ate:f.ate.toISOString(),desde:f.desde?f.desde.toISOString():null,motivo:$('motivo').value,por:$('por').value}); mostrar(e); aviso('msg','Pronto: '+e.descricao+'.',true); }catch(e){ aviso('msg',e.message,false); } finally{ b.disabled=false; } });
  $('btnRetomar').addEventListener('click',async function(){ var b=this; b.disabled=true; try{ var e=await api('DELETE',{por:$('por').value}); mostrar(e); aviso('msg2','A Sofia voltou a responder.',true); }catch(e){ aviso('msg2',e.message,false); } finally{ b.disabled=false; } });
  carregar(); setInterval(carregar,60000);
})();
</script></body></html>`;
}
