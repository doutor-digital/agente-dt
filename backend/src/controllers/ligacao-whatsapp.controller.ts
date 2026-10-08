/**
 * Ligação pelo WhatsApp — as rotas.
 *
 * Do WIDGET (coluna do cartão no Kommo), com a mesma chave por unidade dos outros widgets (`X-Widget-Key`):
 *   GET  /api/public/widget/:slug/ligacao/painel?lead=      tudo que o painel mostra (permissão, travas, fila…)
 *   POST /api/public/widget/:slug/ligacao/permissao         {leadId,u,nome}  manda o pedido de permissão
 *   POST /api/public/widget/:slug/ligacao/combinar          {leadId}         a SDR copiou "Posso te ligar agora?"
 *   POST /api/public/widget/:slug/ligacao/ligar             {leadId,sdp,u,nome,origem,confirmouSemCombinar}
 *   GET  /api/public/widget/:slug/ligacao/chamada/:id       o navegador acompanha (e pega a resposta SDP)
 *   POST /api/public/widget/:slug/ligacao/chamada/:id/desligar
 *   GET  /api/public/widget/:slug/ligacao/fila              "Ligar próximo": quem deu permissão
 *
 * Da META (webhook campo `calls`, e a resposta ao pedido de permissão):
 *   GET  /api/webhooks/whatsapp/ligacoes   verificação (hub.challenge) — só usada se um dia a Meta apontar direto pra cá
 *   POST /api/webhooks/whatsapp/ligacoes   corpo cru da Meta. Aceita a assinatura da Meta (X-Hub-Signature-256 com o
 *        app secret da unidade) OU o segredo interno `X-DD-Token` (DD_INTERNAL_TOKEN) — é como o n8n repassa, já
 *        que o webhook do app hoje vai para o n8n do rastreio e a re-serialização do n8n quebra a assinatura.
 *        A unidade é achada pelo `metadata.phone_number_id` do corpo.
 *
 * O telefone NUNCA vem do widget: o servidor lê do contato do cartão no Kommo. Quem tem a chave do widget só
 * consegue ligar para paciente daquela conta, e só para quem deu permissão.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { chaveConfere } from '../lib/widget-agenda.js';
import { automacaoLigada, estadoDaAutomacao } from '../lib/automacoes-estado.js';
import { credenciaisDaUnidade } from '../lib/whatsapp-meta.js';
import { createKommoClient } from '../services/kommo.service.js';
import { MetaService } from '../services/meta.service.js';
import { segredoConfere } from './whatsapp-meta.controller.js';
import { numerosDeTeste } from '../lib/ligacao-whatsapp.js';
import { lerWebhookDeLigacoes, metaDaUnidade, numerosDoWebhook } from '../lib/ligacao-whatsapp-meta.js';
import { repositorioPrisma } from '../lib/ligacao-whatsapp-prisma.js';
import {
  encerrarLigacao,
  estadoDaLigacao,
  fecharSemRetorno,
  iniciarLigacao,
  marcarPergunta,
  montarFila,
  montarPainel,
  pedirPermissao,
  receberEventos,
  type Contexto,
  type KommoLigacoes,
} from '../lib/ligacao-whatsapp-servico.js';

/** Telefone e nome do contato mudam raramente; o painel relê a cada poucos segundos. 2 min de memória poupa o
 * portão de velocidade do Kommo, que é o mesmo da Sofia. */
const cacheContato = new Map<string, { em: number; v: Awaited<ReturnType<KommoLigacoes['contatoDoLead']>> }>();
const CONTATO_TTL_MS = 2 * 60_000;
const cacheMensagens = new Map<string, { em: number; v: number | null }>();

function kommoDaUnidade(unit: Unit): KommoLigacoes {
  const k = createKommoClient(unit);
  return {
    async contatoDoLead(leadId) {
      const chave = `${unit.id}:${leadId}`;
      const c = cacheContato.get(chave);
      if (c && Date.now() - c.em < CONTATO_TTL_MS) return c.v;
      const v = await lerContato(leadId);
      if (cacheContato.size > 2_000) cacheContato.clear();
      if (v.telefone) cacheContato.set(chave, { em: Date.now(), v });
      return v;
    },
    async ultimaMensagemDesde(contatoId, desde, fresco) {
      // 20 s de memória para o PAINEL (várias SDRs relendo, e o portão do Kommo é o mesmo da Sofia).
      // Na hora de ligar (`fresco`) sempre pergunta de novo.
      const chave = `${unit.id}:${contatoId}:${desde}`;
      const c = cacheMensagens.get(chave);
      if (!fresco && c && Date.now() - c.em < 20_000) return c.v;
      const v = await k.ultimaMensagemDoContatoDesde(contatoId, desde);
      if (cacheMensagens.size > 5_000) cacheMensagens.clear();
      cacheMensagens.set(chave, { em: Date.now(), v });
      return v;
    },
    registrarChamada: (corpo) => k.registrarChamadas([corpo]),
    async nota(leadId, texto) {
      await k.addLeadNote(leadId, texto);
    },
    async tarefa(leadId, texto, responsavel) {
      await k.createTask({ leadId, text: texto, completeAt: Math.floor(Date.now() / 1000) + 30 * 60, responsibleUserId: responsavel ?? undefined });
    },
  };

  async function lerContato(leadId: number) {
    const lead = await k.getLead(leadId);
    // o contato PRINCIPAL do cartão — um acompanhante cadastrado como 2º contato não pode receber a ligação
    const contatos = ((lead as { _embedded?: { contacts?: Array<{ id?: number; is_main?: boolean }> } })._embedded?.contacts ?? []).filter((c) => typeof c.id === 'number');
    const contatoId = (contatos.find((c) => c.is_main) ?? contatos[0])?.id ?? null;
    if (!contatoId) return { contatoId: null, telefone: null, nome: lead?.name ?? null };
    const c = await k.getContactBasico(contatoId);
    return { contatoId, telefone: c.telefone, nome: c.nome ?? lead?.name ?? null };
  }
}

export function contextoDaUnidade(unit: Unit): Contexto {
  const cred = credenciaisDaUnidade(unit);
  return {
    unit: { id: unit.id, slug: unit.slug, nome: unit.name, tz: unit.spineTimezone || 'America/Sao_Paulo' },
    modo: estadoDaAutomacao(unit.slug, 'ligacao-whatsapp', process.env.LIGACAO_WHATSAPP_SLUGS),
    meta: cred ? metaDaUnidade(cred) : null,
    kommo: kommoDaUnidade(unit),
    repo: repositorioPrisma,
    numerosDeTeste: numerosDeTeste(),
    gravar: automacaoLigada(unit.slug, 'ligacao-gravar', process.env.LIGACAO_GRAVAR_SLUGS),
    agora: () => new Date(),
    log: (nivel, dados, msg) => logger[nivel](dados, msg),
  };
}

// ── chave do widget + limite ─────────────────────────────────────────────────────────────────────

const chamadas = new Map<string, { n: number; desde: number }>();
/** O navegador acompanha a ligação a cada segundo: o limite daqui é mais largo que o dos outros widgets. */
const MAX_POR_MINUTO = 600; // a clínica inteira sai pelo mesmo IP: várias SDRs, cada ligação lê 60 vezes por minuto
const ESCRITAS_POR_MINUTO = 20;

function excedeu(chave: string, max: number): boolean {
  const agora = Date.now();
  const t = chamadas.get(chave);
  if (!t || agora - t.desde > 60_000) {
    if (chamadas.size > 5_000) chamadas.clear();
    chamadas.set(chave, { n: 1, desde: agora });
    return false;
  }
  t.n += 1;
  return t.n > max;
}

async function unidadeDoWidget(req: Request, res: Response, escrita = false): Promise<Unit | null> {
  const slug = String(req.params.slug ?? '');
  if (excedeu(`${req.ip}:${slug}`, MAX_POR_MINUTO) || (escrita && excedeu(`w:${req.ip}:${slug}`, ESCRITAS_POR_MINUTO))) {
    res.status(429).json({ error: 'muitas chamadas — aguarde um minuto' });
    return null;
  }
  const recebida = req.header('x-widget-key') ?? (typeof req.query.chave === 'string' ? req.query.chave : undefined);
  if (!chaveConfere(slug, env.SESSION_JWT_SECRET, recebida)) {
    res.status(403).json({ error: 'chave inválida' });
    return null;
  }
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit || !unit.isActive) {
    res.status(404).json({ error: 'unidade não encontrada' });
    return null;
  }
  return unit;
}

const corpo = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const leadDe = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const textoDe = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

function falhou(res: Response, err: unknown, unit: Unit, onde: string): void {
  logger.warn({ err: String(err), unit: unit.slug }, `ligacao-whatsapp: falha em ${onde}`);
  res.status(502).json({ error: 'não consegui falar com o Kommo ou com a Meta agora — tente de novo' });
}

// ── widget ───────────────────────────────────────────────────────────────────────────────────────

export async function ligacaoPainelHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const leadId = leadDe(req.query.lead);
  if (!leadId) { res.status(400).json({ error: 'lead inválido' }); return; }
  const ctx = contextoDaUnidade(unit);
  if (ctx.modo === 'desligado') { res.json({ modo: 'desligado', unidade: unit.name }); return; }
  try {
    res.json(await montarPainel(ctx, leadId));
  } catch (err) {
    falhou(res, err, unit, 'painel');
  }
}

export async function ligacaoPermissaoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res, true);
  if (!unit) return;
  const b = corpo(req);
  const leadId = leadDe(b.leadId);
  if (!leadId) { res.status(400).json({ error: 'leadId inválido' }); return; }
  try {
    const r = await pedirPermissao(contextoDaUnidade(unit), { leadId, kommoUserId: leadDe(b.u), nomeSdr: textoDe(b.nome, 60) });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (err) {
    falhou(res, err, unit, 'pedir permissão');
  }
}

export async function ligacaoCombinarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res, true);
  if (!unit) return;
  const leadId = leadDe(corpo(req).leadId);
  if (!leadId) { res.status(400).json({ error: 'leadId inválido' }); return; }
  try {
    const ctx = contextoDaUnidade(unit);
    if (ctx.modo === 'desligado') { res.status(404).json({ error: 'desligada nesta unidade' }); return; }
    const r = await marcarPergunta(ctx, leadId);
    res.status(r.ok ? 200 : 409).json(r);
  } catch (err) {
    falhou(res, err, unit, 'combinar');
  }
}

export async function ligacaoLigarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res, true);
  if (!unit) return;
  const b = corpo(req);
  const leadId = leadDe(b.leadId);
  const sdp = textoDe(b.sdp, 20_000);
  if (!leadId || !sdp) { res.status(400).json({ error: 'leadId e sdp são obrigatórios' }); return; }
  try {
    const r = await iniciarLigacao(contextoDaUnidade(unit), {
      leadId,
      sdp,
      kommoUserId: leadDe(b.u),
      nomeSdr: textoDe(b.nome, 60),
      origem: b.origem === 'fila' ? 'fila' : 'cartao',
      confirmouSemCombinar: b.confirmouSemCombinar === true,
    });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (err) {
    falhou(res, err, unit, 'ligar');
  }
}

export async function ligacaoEstadoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const e = await estadoDaLigacao(contextoDaUnidade(unit), String(req.params.id ?? '')).catch(() => null);
  if (!e) { res.status(404).json({ error: 'ligação não encontrada' }); return; }
  res.json(e);
}

export async function ligacaoDesligarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res, true);
  if (!unit) return;
  try {
    const r = await encerrarLigacao(contextoDaUnidade(unit), String(req.params.id ?? ''));
    res.status(r.ok ? 200 : 404).json(r);
  } catch (err) {
    falhou(res, err, unit, 'desligar');
  }
}

export async function ligacaoFilaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const ctx = contextoDaUnidade(unit);
  if (ctx.modo === 'desligado') { res.json({ modo: 'desligado', pausada: false, itens: [] }); return; }
  try {
    res.json({ modo: ctx.modo, ...(await montarFila(ctx)) });
  } catch (err) {
    falhou(res, err, unit, 'fila');
  }
}

// ── webhook da Meta ──────────────────────────────────────────────────────────────────────────────

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function webhookLigacoesVerifyHandler(req: Request, res: Response): void {
  const esperado = (process.env.LIGACAO_WEBHOOK_VERIFY_TOKEN ?? '').trim();
  if (esperado.length >= 16 && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === esperado) {
    res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    return;
  }
  res.status(403).send('forbidden');
}

export async function webhookLigacoesHandler(req: Request, res: Response): Promise<void> {
  const payload = req.body;
  const ids = numerosDoWebhook(payload);
  if (!ids.length) { res.status(200).json({ ok: true, ignorado: 'sem phone_number_id' }); return; }
  const units = await prisma.unit.findMany({ where: { metaPhoneNumberId: { in: ids } } });
  if (!units.length) { res.status(200).json({ ok: true, ignorado: 'número de nenhuma unidade' }); return; }

  const porSegredo = segredoConfere(req.get('x-dd-token'), process.env.DD_INTERNAL_TOKEN);
  const raw = (req as RawBodyRequest).rawBody;
  const assinatura = req.header('x-hub-signature-256');
  const porAssinatura = !!raw && !!assinatura && units.some((u) => !!u.metaAppSecret && MetaService.validateSignature(raw, assinatura, u.metaAppSecret));
  if (!porSegredo && !porAssinatura) {
    logger.warn({ ip: req.ip, numeros: ids }, 'ligacao-whatsapp: webhook sem assinatura válida nem segredo interno');
    res.status(401).json({ ok: false, error: 'não autorizado' });
    return;
  }

  const eventos = lerWebhookDeLigacoes(payload);
  let tratados = 0;
  try {
    for (const unit of units) {
      const daUnidade = eventos.filter((e) => e.phoneNumberId === unit.metaPhoneNumberId);
      if (!daUnidade.length) continue;
      const r = await receberEventos(contextoDaUnidade(unit), daUnidade);
      tratados += r.tratados;
    }
  } catch (err) {
    // 500 de propósito: a Meta (ou o n8n) reenvia, e o evento "connect" com a resposta SDP não pode se perder.
    logger.error({ err: String(err) }, 'ligacao-whatsapp: falha ao tratar o webhook');
    res.status(500).json({ ok: false });
    return;
  }
  res.status(200).json({ ok: true, eventos: eventos.length, tratados });
}

// ── vigia das ligações penduradas ────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

export async function varrerLigacoesParadas(): Promise<number> {
  const ate = new Date(Date.now() - 3 * 60_000);
  const paradas = await repositorioPrisma.abertasParadas(ate);
  let fechadas = 0;
  const unidades = new Map<string, Unit | null>();
  for (const l of paradas) {
    if (!unidades.has(l.unitId)) unidades.set(l.unitId, await prisma.unit.findUnique({ where: { id: l.unitId } }));
    const unit = unidades.get(l.unitId);
    if (!unit) continue;
    try {
      if (await fecharSemRetorno(contextoDaUnidade(unit), l)) fechadas++;
    } catch (err) {
      logger.warn({ err: String(err), ligacao: l.id }, 'ligacao-whatsapp: não consegui fechar ligação parada');
    }
  }
  if (fechadas) logger.warn({ fechadas }, 'ligacao-whatsapp: ligações sem retorno da Meta encerradas pelo vigia');
  return fechadas;
}

export function startLigacaoWhatsappWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void varrerLigacoesParadas().catch((err) => logger.warn({ err: String(err) }, 'ligacao-whatsapp: varredura falhou'));
  }, 60_000);
  timer.unref?.();
}

export function stopLigacaoWhatsappWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
