// ============================================================================
// instagram.controller.ts — Webhook de comentários do Instagram (multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
//   GET  /webhooks/{slug}/instagram   → handshake (hub.challenge)
//   POST /webhooks/{slug}/instagram   → evento de comentário
//
// ACK EM ≤5s, igual aos outros webhooks da Meta: respondemos 200 antes de
// pensar, e o trabalho segue em background.
//
// TRÊS CAMADAS DE PROTEÇÃO ANTES DE ESCREVER EM PÚBLICO
// -----------------------------------------------------
// Errar aqui é diferente de errar no WhatsApp: no privado, um erro é visto
// por uma pessoa; no comentário, por todo mundo, e fica no perfil. Então:
//
//   1. LOOP GUARD — se o autor do comentário é a própria conta, ignora. Sem
//      isso, a resposta que a gente publica volta como webhook, o agente
//      responde a si mesmo, e isso não tem fim.
//   2. DEDUP DURÁVEL — `commentId` é unique no banco. O cache em memória
//      (claimMessageId) pega o retry rápido; o unique pega o retry que chega
//      depois de um deploy, quando o cache já morreu.
//   3. DRY RUN — ligado por padrão. O agente faz tudo e grava o rascunho sem
//      publicar. Vira fila de aprovação até a unidade confiar no texto.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { findUnitBySlug } from '../services/units.service.js';
import { claimMessageId } from '../lib/dedup-cache.js';
import { MetaService } from '../services/meta.service.js';
import {
  InstagramService,
  platformConfig,
  type IgInboundComment,
  type SocialPlatform,
} from '../services/instagram.service.js';
import { decideOnComment } from '../services/comment-agent.service.js';

/**
 * Abaixo disso a gente não publica nada, nem fora do dry run. Uma classificação
 * incerta que vira resposta pública é exatamente o caso que a fila de aprovação
 * existe pra pegar.
 */
const MIN_CONFIDENCE_TO_PUBLISH = 0.6;

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// ---------------------------------------------------------------------------
// GET — handshake.
// ---------------------------------------------------------------------------

function platformOf(req: Request): SocialPlatform {
  return req.path.endsWith('/facebook') ? 'facebook' : 'instagram';
}

export async function handleInstagramVerify(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.unitSlug ?? '');
  if (!slug) {
    res.status(400).send('missing_unit_slug');
    return;
  }
  const unit = await findUnitBySlug(slug);
  if (!unit) {
    res.status(404).send('unit_not_found');
    return;
  }

  const result = InstagramService.verifyWebhook(
    unit,
    {
      mode: req.query['hub.mode'] as string | undefined,
      token: req.query['hub.verify_token'] as string | undefined,
      challenge: req.query['hub.challenge'] as string | undefined,
    },
    platformOf(req),
  );

  if (!result.ok) {
    logger.warn({ slug, reason: result.reason }, 'instagram verify falhou');
    res.status(403).send(result.reason ?? 'forbidden');
    return;
  }
  res.status(200).send(result.challenge ?? '');
}

// ---------------------------------------------------------------------------
// POST — comentários.
// ---------------------------------------------------------------------------

export async function handleInstagramWebhook(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.unitSlug ?? '');
  if (!slug) {
    res.status(400).json({ ok: false, error: 'missing_unit_slug' });
    return;
  }
  const unit = await findUnitBySlug(slug);
  if (!unit) {
    res.status(404).json({ ok: false, error: 'unit_not_found' });
    return;
  }

  const platform = platformOf(req);
  const cfg = platformConfig(unit, platform);
  const appSecret = cfg.appSecret;
  const rawBody = (req as RawBodyRequest).rawBody;
  if (rawBody && appSecret) {
    const valid = MetaService.validateSignature(
      rawBody,
      req.header('x-hub-signature-256'),
      appSecret,
    );
    if (!valid) {
      logger.warn({ slug }, 'instagram signature inválida');
      res.status(401).json({ ok: false, error: 'invalid_signature' });
      return;
    }
  }

  const comments =
    platform === 'facebook'
      ? InstagramService.parseFacebookComments(req.body)
      : InstagramService.parseComments(req.body);

  res.status(200).json({ ok: true, received: comments.length });

  if (!cfg.enabled) {
    logger.debug({ slug }, 'instagram: canal desligado na unidade — ignorando');
    return;
  }
  if (comments.length === 0) return;

  for (const c of comments) {
    if (!claimMessageId(`${platform}-comment`, c.commentId)) {
      logger.info({ slug, commentId: c.commentId }, 'instagram: webhook duplicado — ignorando');
      continue;
    }
    void processComment(unit, c, platform).catch((err) => {
      logger.error({ err, slug, commentId: c.commentId }, 'erro processando comentário IG');
    });
  }
}

// ---------------------------------------------------------------------------
// Processamento de um comentário.
// ---------------------------------------------------------------------------

async function processComment(
  unit: Unit,
  c: IgInboundComment,
  platform: SocialPlatform,
): Promise<void> {
  const cfg = platformConfig(unit, platform);

  // 1. LOOP GUARD. A resposta que publicamos chega de volta como comentário.
  if (cfg.accountId && c.authorId && c.authorId === cfg.accountId) {
    logger.debug({ commentId: c.commentId }, 'instagram: comentário nosso — ignorando');
    return;
  }

  // 2. DEDUP DURÁVEL. `create` com commentId unique: se já existe, a Meta
  // reentregou e a gente para aqui — sem responder duas vezes em público.
  let row;
  try {
    row = await prisma.instagramComment.create({
      data: {
        unitId: unit.id,
        platform,
        commentId: c.commentId,
        mediaId: c.mediaId,
        parentId: c.parentId,
        authorId: c.authorId,
        authorUsername: c.authorUsername,
        text: c.text,
        status: 'PENDING',
      },
    });
  } catch (err) {
    logger.info(
      { commentId: c.commentId, unit: unit.slug, err },
      'instagram: comentário já registrado — ignorando reentrega',
    );
    return;
  }

  const decision = await decideOnComment(unit, {
    commentId: c.commentId,
    text: c.text,
    platform,
  });

  const patch: Record<string, unknown> = {
    category: decision.category,
    confidence: decision.confidence,
    publicReply: decision.publicReply,
    privateReply: decision.privateReply,
  };

  // Spam: registra e não responde. Responder spam em público dá palco.
  if (decision.category === 'SPAM') {
    await prisma.instagramComment.update({
      where: { id: row.id },
      data: { ...patch, status: 'SKIPPED', skipReason: 'spam' },
    });
    return;
  }

  const lowConfidence =
    decision.viaRule === null && decision.confidence < MIN_CONFIDENCE_TO_PUBLISH;

  if (cfg.dryRun || lowConfidence) {
    await prisma.instagramComment.update({
      where: { id: row.id },
      data: {
        ...patch,
        status: 'PENDING',
        skipReason: cfg.dryRun ? 'dry_run' : 'confianca_baixa',
      },
    });
    logger.info(
      { commentId: c.commentId, category: decision.category, dryRun: cfg.dryRun },
      'instagram: rascunho na fila de aprovação',
    );
    return;
  }

  await publishDecision(
    unit,
    row.id,
    c.commentId,
    decision.publicReply,
    decision.privateReply,
    patch,
    platform,
  );
}

// ---------------------------------------------------------------------------
// Publicação — usada pelo fluxo automático E pela aprovação manual.
// ---------------------------------------------------------------------------
// A resposta pública sai ANTES do DM de propósito. Se o DM falhar (permissão
// faltando, janela de 7 dias vencida), pelo menos a pessoa foi respondida em
// público. O contrário deixaria um DM órfão dizendo "te respondi ali" apontando
// pra um comentário sem resposta nenhuma.

export async function publishDecision(
  unit: Unit,
  rowId: string,
  commentId: string,
  publicReply: string | null,
  privateReply: string | null,
  extraPatch: Record<string, unknown> = {},
  platform: SocialPlatform = 'instagram',
): Promise<void> {
  const cfg = platformConfig(unit, platform);
  const patch: Record<string, unknown> = { ...extraPatch };
  const errors: string[] = [];

  if (publicReply) {
    const signature = cfg.publicSignature?.trim();
    const text = signature ? `${publicReply} ${signature}` : publicReply;
    const r = await InstagramService.replyToComment(cfg, commentId, text, platform);
    if (r.ok) {
      patch.publicSentAt = new Date();
    } else {
      errors.push(`público: ${r.error}`);
    }
  }

  if (privateReply) {
    const r = await InstagramService.sendPrivateReply(cfg, commentId, privateReply, platform);
    if (r.ok) {
      patch.privateSentAt = new Date();
    } else {
      errors.push(`privado: ${r.error}`);
    }
  }

  patch.status = errors.length > 0 ? 'FAILED' : 'SENT';
  if (errors.length > 0) patch.error = errors.join(' | ');

  await prisma.instagramComment.update({ where: { id: rowId }, data: patch });

  if (errors.length > 0) {
    logger.warn({ commentId, errors }, 'instagram: falha ao publicar resposta');
  }
}

// ---------------------------------------------------------------------------
// API do painel — fila de moderação.
// ---------------------------------------------------------------------------
// Rotas sob /units/:id/instagram/*, protegidas por requireUnitAccess no router.

const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'SENT', 'SKIPPED', 'FAILED']).optional(),
  platform: z.enum(['instagram', 'facebook']).default('instagram'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listInstagramCommentsHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten() });
    return;
  }
  const { status, limit, platform } = parsed.data;

  const [rows, counts] = await Promise.all([
    prisma.instagramComment.findMany({
      where: { unitId, platform, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.instagramComment.groupBy({
      by: ['status'],
      where: { unitId, platform },
      _count: { _all: true },
    }),
  ]);

  res.json({
    comments: rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  });
}

const approveSchema = z.object({
  // O moderador pode corrigir os dois textos antes de publicar. É o ponto
  // inteiro da fila: o rascunho é sugestão, não decisão.
  publicReply: z.string().max(2000).nullable().optional(),
  privateReply: z.string().max(4000).nullable().optional(),
});

export async function approveInstagramCommentHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const rowId = String(req.params.commentRowId);
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
    return;
  }

  const row = await prisma.instagramComment.findFirst({ where: { id: rowId, unitId } });
  if (!row) {
    res.status(404).json({ error: 'comment_not_found' });
    return;
  }
  if (row.status === 'SENT') {
    // Não é erro do usuário, é corrida entre dois moderadores. Mas publicar
    // de novo criaria uma segunda resposta pública no mesmo comentário.
    res.status(409).json({ error: 'already_sent' });
    return;
  }

  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const publicReply =
    parsed.data.publicReply !== undefined ? parsed.data.publicReply : row.publicReply;
  const privateReply =
    parsed.data.privateReply !== undefined ? parsed.data.privateReply : row.privateReply;

  await publishDecision(
    unit,
    row.id,
    row.commentId,
    publicReply,
    privateReply,
    { publicReply, privateReply, skipReason: null },
    (row.platform as SocialPlatform) ?? 'instagram',
  );

  const updated = await prisma.instagramComment.findUnique({ where: { id: row.id } });
  res.json({ comment: updated });
}

export async function rejectInstagramCommentHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const rowId = String(req.params.commentRowId);
  const row = await prisma.instagramComment.findFirst({ where: { id: rowId, unitId } });
  if (!row) {
    res.status(404).json({ error: 'comment_not_found' });
    return;
  }
  const updated = await prisma.instagramComment.update({
    where: { id: row.id },
    data: { status: 'SKIPPED', skipReason: 'recusado_manualmente' },
  });
  res.json({ comment: updated });
}
