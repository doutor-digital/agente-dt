/**
 * Página `/alta/:slug` — a recepção decide o que a IA não pode decidir sozinha.
 *
 * Duas listas: quem **terminou o protocolo** (candidato a ALTA) e quem **parou no
 * meio**. A alta nunca é automática porque ALTA é o "Ganho" nativo do funil de
 * tratamento e o gatilho dela dispara um bot SEM nenhuma condição — mover em
 * massa mandaria "parabéns pela conclusão" para quem terminou em 2025.
 *
 * Mesma proteção da `/pausa/:slug`: código de 6 dígitos da unidade, comparação em
 * tempo constante e limite por ip. A recepção não tem login do Kommo (e os campos
 * obrigatórios são cumulativos, o que trava o arrasto manual de cartão na tela —
 * por isso a página move por API).
 */
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import {
  diasParado,
  faltam,
  ordenarAltas,
  ordenarParados,
  resumoDoCandidato,
  type CandidatoBruto,
} from '../lib/fila-de-alta.js';

const JANELA_MS = 10 * 60_000;
const MAX_TENTATIVAS = 12;
const tentativas = new Map<string, { n: number; desde: number }>();

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

function esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

async function unidadePorSlug(slug: string) {
  return prisma.unit.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, isActive: true, pausaCodigo: true, spineTimezone: true },
  });
}

/** Lista o que está pendente, já ordenado pelo que a recepção deve atacar primeiro. */
export async function listarAltaHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug ?? '');
  const ip = req.ip ?? 'sem-ip';
  if (excedeu(`${ip}:${slug}`)) {
    res.status(429).json({ erro: 'muitas tentativas, tente em alguns minutos' });
    return;
  }
  const unit = await unidadePorSlug(slug);
  if (!unit || !unit.isActive) {
    res.status(404).json({ erro: 'unidade não encontrada' });
    return;
  }
  if (!codigoConfere(unit, req.query.codigo)) {
    res.status(401).json({ erro: 'código inválido' });
    return;
  }

  const pendentes = await prisma.altaCandidato.findMany({
    where: { unitId: unit.id, estado: 'pendente' },
    orderBy: { criadoEm: 'asc' },
  });
  const agora = new Date();
  const bruto = (c: (typeof pendentes)[number]): CandidatoBruto & { id: string } => ({
    id: c.id,
    leadId: c.leadId,
    nome: c.nome,
    classe: c.classe === 'ALTA' ? 'ALTA' : 'PAROU',
    realizadas: c.realizadas,
    previstas: c.previstas,
    ultimaSessao: c.ultimaSessao ? c.ultimaSessao.toISOString() : null,
  });
  const comResumo = (c: CandidatoBruto & { id: string }) => ({
    ...c,
    faltam: faltam(c),
    diasParado: diasParado(c.ultimaSessao, agora),
    resumo: resumoDoCandidato(c, agora),
  });

  const todos: Array<CandidatoBruto & { id: string }> = pendentes.map(bruto);
  res.json({
    unidade: unit.name,
    slug: unit.slug,
    altas: ordenarAltas(todos.filter((c) => c.classe === 'ALTA')).map(comResumo),
    parados: ordenarParados(todos.filter((c) => c.classe === 'PAROU'), agora).map(comResumo),
  });
}

const decisaoSchema = z.object({
  codigo: z.string().min(4).max(12),
  id: z.string().min(5).max(40),
  /** alta = move pra ALTA · segue = continua em tratamento · recuperar = abre tarefa · desistiu = só registra */
  decisao: z.enum(['alta', 'segue', 'recuperar', 'desistiu']),
  por: z.string().trim().max(80).optional(),
});

export async function decidirAltaHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug ?? '');
  const ip = req.ip ?? 'sem-ip';
  if (excedeu(`${ip}:${slug}`)) {
    res.status(429).json({ erro: 'muitas tentativas, tente em alguns minutos' });
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit || !unit.isActive) {
    res.status(404).json({ erro: 'unidade não encontrada' });
    return;
  }
  const parse = decisaoSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'pedido inválido' });
    return;
  }
  const { codigo, id, decisao, por } = parse.data;
  if (!codigoConfere(unit, codigo)) {
    res.status(401).json({ erro: 'código inválido' });
    return;
  }

  const cand = await prisma.altaCandidato.findFirst({ where: { id, unitId: unit.id } });
  if (!cand) {
    res.status(404).json({ erro: 'candidato não encontrado' });
    return;
  }
  if (cand.estado !== 'pendente') {
    res.status(409).json({ erro: 'esse já foi decidido', estado: cand.estado });
    return;
  }

  const quem = por?.trim() || 'recepção';
  let movido = false;

  if (decisao === 'alta') {
    const destino = await etapaDeAlta(unit);
    if (!destino) {
      res.status(422).json({ erro: 'não achei a etapa ALTA no funil de tratamento desta unidade' });
      return;
    }
    try {
      // pipeline_id SEMPRE junto: ALTA é o status 142 do funil TRATAMENTO e
      // GANHO/CONCLUÍDO é o 142 do COMERCIAL. Sem o funil, o cartão vira "venda".
      await createKommoClient(unit).moveStage({
        leadId: cand.leadId,
        statusId: destino.statusId,
        pipelineId: destino.pipelineId,
      });
      movido = true;
    } catch (err) {
      logger.warn({ err: String(err), lead: cand.leadId, unit: unit.slug }, 'alta: falha ao mover cartão');
      res.status(502).json({ erro: 'não consegui mover o cartão agora; tente de novo' });
      return;
    }
  }

  if (decisao === 'recuperar') {
    const f = Math.max(0, cand.previstas - cand.realizadas);
    await createKommoClient(unit)
      .createTask({
        leadId: cand.leadId,
        // prazo de amanhã: tarefa sem prazo some da fila da recepção
        completeAt: Math.floor(Date.now() / 1000) + 86_400,
        text:
          `Recuperar tratamento — ${cand.nome ?? 'paciente'}: fez ${cand.realizadas} de ${cand.previstas} sessões` +
          (f > 0 ? `, faltam ${f}` : '') +
          `. Marcado por ${quem} na página de altas.`,
      })
      .catch((err) => logger.warn({ err: String(err), lead: cand.leadId }, 'alta: falha ao criar tarefa'));
  }

  const estado = decisao === 'alta' || decisao === 'desistiu' ? 'aprovado' : 'recusado';
  await prisma.altaCandidato.update({
    where: { id: cand.id },
    data: { estado, decididoPor: quem, decididoEm: new Date() },
  });
  logger.info({ unit: unit.slug, lead: cand.leadId, decisao, quem, movido }, 'alta: decisão registrada');
  res.json({ ok: true, decisao, movido });
}

/** ALTA = o "Ganho" do funil cujo nome contém "tratamento". */
async function etapaDeAlta(unit: Unit): Promise<{ pipelineId: number; statusId: number } | null> {
  try {
    const pipes = await createKommoClient(unit).listPipelines();
    const pipe = pipes.find((p) => /tratamento/i.test(p.name || ''));
    if (!pipe) return null;
    const status =
      pipe.statuses?.find((s) => /^\s*alta\b/i.test(s.name || '')) ??
      pipe.statuses?.find((s) => s.id === 142);
    return status ? { pipelineId: pipe.id, statusId: status.id } : null;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'alta: não consegui ler os funis');
    return null;
  }
}

export async function paginaAltaHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug ?? '');
  const unit = await unidadePorSlug(slug);
  if (!unit || !unit.isActive) {
    res
      .status(404)
      .type('html')
      .send('<!doctype html><meta charset="utf-8"><title>Altas</title><p style="font-family:sans-serif;padding:24px">Unidade não encontrada.</p>');
    return;
  }
  res.type('html').send(paginaHtml(slug, unit.name));
}

function paginaHtml(slug: string, nome: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Altas e retornos · ${esc(nome)}</title>
<style>
:root{--bg:#0B0B11;--s1:#13131B;--s2:#1A1A24;--line:#2A2A36;--ink:#F5F5F7;--muted:#8A8C97;--acc:#3D6BFF;--ok:#04D361;--warn:#E9B949}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;padding:20px 16px 48px}
main{max-width:560px;margin:0 auto}h1{font-size:22px;font-weight:600;margin:6px 0 2px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
h2{font-size:15px;font-weight:600;margin:22px 0 10px;color:var(--muted);letter-spacing:.03em;text-transform:uppercase}
.card{background:var(--s1);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px}
.nome{font-weight:600;font-size:16px}.res{color:var(--muted);font-size:14px;margin-top:2px}
.acoes{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
button{background:var(--s2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit;padding:10px 14px;cursor:pointer}
button.p{background:var(--acc);border-color:transparent;font-weight:600}
button:disabled{opacity:.5;cursor:default}
input{width:100%;background:var(--s2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit;padding:12px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 6px}
.vazio{color:var(--muted);font-size:14px;padding:10px 2px}
.msg{margin-top:10px;font-size:14px;min-height:20px}.ok{color:var(--ok)}.err{color:var(--warn)}
.perto{border-color:#2f5e3a}
</style></head><body><main>
<h1>Altas e retornos</h1>
<p class="sub">${esc(nome)}</p>

<div class="card" id="entrar">
  <label>Código da unidade</label>
  <input id="cod" inputmode="numeric" autocomplete="off" placeholder="6 dígitos">
  <label>Seu nome</label>
  <input id="por" autocomplete="off" placeholder="quem está conferindo">
  <div class="acoes"><button class="p" id="ok">Abrir lista</button></div>
  <div class="msg" id="m"></div>
</div>

<div id="listas" hidden>
  <h2>Terminaram o protocolo</h2>
  <div id="altas"></div>
  <h2>Pararam no meio</h2>
  <div id="parados"></div>
</div>

<script>
const S=${JSON.stringify(slug)};
const $=(i)=>document.getElementById(i);
let COD='',POR='';
function card(c,tipo){
  const d=document.createElement('div');
  d.className='card'+(tipo==='parados'&&c.faltam<=3?' perto':'');
  const acoes = tipo==='altas'
    ? [['alta','Dar alta','p'],['segue','Ainda em tratamento','']]
    : [['recuperar','Vou recuperar','p'],['desistiu','Desistiu','']];
  d.innerHTML='<div class="nome"></div><div class="res"></div><div class="acoes"></div><div class="msg"></div>';
  d.querySelector('.nome').textContent=c.nome||('Lead '+c.leadId);
  d.querySelector('.res').textContent=c.resumo;
  const box=d.querySelector('.acoes'), msg=d.querySelector('.msg');
  for(const [dec,rot,cls] of acoes){
    const b=document.createElement('button'); b.textContent=rot; if(cls)b.className=cls;
    b.onclick=async()=>{
      box.querySelectorAll('button').forEach(x=>x.disabled=true);
      msg.textContent='...'; msg.className='msg';
      try{
        const r=await fetch('/api/public/alta/'+S,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({codigo:COD,id:c.id,decisao:dec,por:POR})});
        const j=await r.json();
        if(!r.ok){ msg.textContent=j.erro||'não deu certo'; msg.className='msg err';
          box.querySelectorAll('button').forEach(x=>x.disabled=false); return; }
        msg.textContent = j.movido ? 'alta registrada e cartão movido' : 'registrado';
        msg.className='msg ok';
        setTimeout(()=>d.remove(),1200);
      }catch(e){ msg.textContent='sem conexão'; msg.className='msg err';
        box.querySelectorAll('button').forEach(x=>x.disabled=false); }
    };
    box.appendChild(b);
  }
  return d;
}
async function abrir(){
  COD=$('cod').value.trim(); POR=$('por').value.trim();
  if(!COD){ $('m').textContent='digite o código'; $('m').className='msg err'; return; }
  $('m').textContent='...'; $('m').className='msg';
  const r=await fetch('/api/public/alta/'+S+'?codigo='+encodeURIComponent(COD));
  const j=await r.json();
  if(!r.ok){ $('m').textContent=j.erro||'não deu certo'; $('m').className='msg err'; return; }
  $('entrar').hidden=true; $('listas').hidden=false;
  const enche=(id,lista,tipo)=>{
    const el=$(id); el.innerHTML='';
    if(!lista.length){ el.innerHTML='<div class="vazio">nada por aqui agora</div>'; return; }
    lista.forEach(c=>el.appendChild(card(c,tipo)));
  };
  enche('altas',j.altas,'altas');
  enche('parados',j.parados,'parados');
}
$('ok').onclick=abrir;
$('cod').addEventListener('keydown',e=>{if(e.key==='Enter')abrir();});
</script></main></body></html>`;
}
