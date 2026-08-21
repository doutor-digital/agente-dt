import axios from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';

const IG_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

export type SocialPlatform = 'instagram' | 'facebook';

export interface PlatformConfig {
  enabled: boolean;
  accountId: string | null;
  accessToken: string | null;
  verifyToken: string | null;
  appSecret: string | null;
  dryRun: boolean;
  whatsappNumber: string | null;
  publicSignature: string | null;
  deliveryMode: string;
  replyFieldId: number | null;
  commentPrompt: string | null;
}

export function platformConfig(unit: Unit, platform: SocialPlatform): PlatformConfig {
  if (platform === 'facebook') {
    return {
      enabled: unit.fbEnabled,
      accountId: unit.fbPageId,
      accessToken: unit.fbAccessToken,
      verifyToken: unit.fbVerifyToken?.trim() || unit.metaVerifyToken?.trim() || null,
      appSecret: unit.fbAppSecret?.trim() || unit.metaAppSecret?.trim() || null,
      dryRun: unit.fbDryRun,
      whatsappNumber: unit.fbWhatsappNumber,
      publicSignature: unit.fbPublicSignature,
      deliveryMode: unit.fbDeliveryMode,
      replyFieldId: unit.fbReplyFieldId,
      commentPrompt: unit.fbCommentPrompt,
    };
  }
  return {
    enabled: unit.igEnabled,
    accountId: unit.igUserId,
    accessToken: unit.igAccessToken,
    verifyToken: unit.igVerifyToken?.trim() || unit.metaVerifyToken?.trim() || null,
    appSecret: unit.igAppSecret?.trim() || unit.metaAppSecret?.trim() || null,
    dryRun: unit.igDryRun,
    whatsappNumber: unit.igWhatsappNumber,
    publicSignature: unit.igPublicSignature,
    deliveryMode: unit.igDeliveryMode,
    replyFieldId: unit.igReplyFieldId,
    commentPrompt: unit.igCommentPrompt,
  };
}

export interface IgInboundComment {
  commentId: string;
  mediaId: string | null;
  parentId: string | null;
  authorId: string | null;
  authorUsername: string | null;
  text: string;
  recipientId: string | null;
  timestamp: number;
}

export interface IgSendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export function resolveIgAppSecret(
  unit: Pick<Unit, 'igAppSecret' | 'metaAppSecret'>,
): string | null {
  return unit.igAppSecret?.trim() || unit.metaAppSecret?.trim() || null;
}

export function resolveIgVerifyToken(
  unit: Pick<Unit, 'igVerifyToken' | 'metaVerifyToken'>,
): string | null {
  return unit.igVerifyToken?.trim() || unit.metaVerifyToken?.trim() || null;
}

export function verifyWebhook(
  unit: Unit,
  query: { mode?: string; token?: string; challenge?: string },
  platform: SocialPlatform = 'instagram',
): { ok: boolean; challenge?: string; reason?: string } {
  const expected = platformConfig(unit, platform).verifyToken;
  if (!expected) return { ok: false, reason: 'unit sem ig_verify_token' };
  if (query.mode !== 'subscribe') return { ok: false, reason: 'mode != subscribe' };
  if (query.token !== expected) return { ok: false, reason: 'token inválido' };
  return { ok: true, challenge: query.challenge ?? '' };
}

export function parseComments(payload: unknown): IgInboundComment[] {
  const out: IgInboundComment[] = [];
  const root = payload as {
    object?: string;
    entry?: Array<{
      id?: string;
      time?: number;
      changes?: Array<{
        field?: string;
        value?: {
          id?: string;
          text?: string;
          parent_id?: string;
          from?: { id?: string; username?: string };
          media?: { id?: string };
        };
      }>;
    }>;
  };

  if (root.object && root.object !== 'instagram') return out;

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue;
      const v = change.value;
      if (!v?.id) continue;
      out.push({
        commentId: v.id,
        mediaId: v.media?.id ?? null,
        parentId: v.parent_id ?? null,
        authorId: v.from?.id ?? null,
        authorUsername: v.from?.username ?? null,
        text: (v.text ?? '').trim(),
        recipientId: entry.id ?? null,
        timestamp: entry.time ?? 0,
      });
    }
  }
  return out;
}

export function parseFacebookComments(payload: unknown): IgInboundComment[] {
  const out: IgInboundComment[] = [];
  const root = payload as {
    object?: string;
    entry?: Array<{
      id?: string;
      time?: number;
      changes?: Array<{
        field?: string;
        value?: {
          item?: string;
          verb?: string;
          comment_id?: string;
          post_id?: string;
          parent_id?: string;
          message?: string;
          from?: { id?: string; name?: string };
        };
      }>;
    }>;
  };

  if (root.object && root.object !== 'page') return out;

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'feed') continue;
      const v = change.value;
      if (!v || v.item !== 'comment' || v.verb !== 'add' || !v.comment_id) continue;
      out.push({
        commentId: v.comment_id,
        mediaId: v.post_id ?? null,
        parentId: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null,
        authorId: v.from?.id ?? null,
        authorUsername: v.from?.name ?? null,
        text: (v.message ?? '').trim(),
        recipientId: entry.id ?? null,
        timestamp: entry.time ?? 0,
      });
    }
  }
  return out;
}

export async function replyToComment(
  cfg: Pick<PlatformConfig, 'accessToken'>,
  commentId: string,
  message: string,
  platform: SocialPlatform = 'instagram',
): Promise<IgSendResult> {
  if (!cfg.accessToken) return { ok: false, error: 'sem access token' };
  const path = platform === 'facebook' ? 'comments' : 'replies';
  try {
    const { data } = await axios.post(
      `${IG_GRAPH_BASE}/${commentId}/${path}`,
      { message },
      {
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        timeout: 15_000,
      },
    );
    return { ok: true, id: (data as { id?: string }).id };
  } catch (err) {
    const msg = describeAxiosError(err);
    logger.warn({ erro: msg, commentId }, 'instagram: resposta pública falhou');
    return { ok: false, error: msg };
  }
}

export async function sendPrivateReply(
  cfg: Pick<PlatformConfig, 'accountId' | 'accessToken'>,
  commentId: string,
  text: string,
  platform: SocialPlatform = 'instagram',
): Promise<IgSendResult> {
  if (!cfg.accessToken) return { ok: false, error: 'sem access token' };
  if (platform === 'instagram' && !cfg.accountId) {
    return { ok: false, error: 'sem ig_user_id' };
  }
  const url =
    platform === 'facebook'
      ? `${IG_GRAPH_BASE}/${commentId}/private_replies`
      : `${IG_GRAPH_BASE}/${cfg.accountId}/messages`;
  const body =
    platform === 'facebook'
      ? { message: text }
      : { recipient: { comment_id: commentId }, message: { text } };
  try {
    const { data } = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      timeout: 15_000,
    });
    return { ok: true, id: (data as { message_id?: string; id?: string }).message_id ?? (data as { id?: string }).id };
  } catch (err) {
    const msg = describeAxiosError(err);
    logger.warn({ erro: msg, commentId }, 'instagram: resposta privada falhou');
    return { ok: false, error: msg };
  }
}

export function buildWhatsappLink(number: string | null, prefill?: string): string | null {
  const digits = (number ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const base = `https://wa.me/${digits}`;
  return prefill ? `${base}?text=${encodeURIComponent(prefill)}` : base;
}

function describeAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return `${err.response?.status ?? '?'}: ${JSON.stringify(err.response?.data ?? err.message)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export const InstagramService = {
  verifyWebhook,
  parseComments,
  parseFacebookComments,
  platformConfig,
  replyToComment,
  sendPrivateReply,
  buildWhatsappLink,
  resolveIgAppSecret,
  resolveIgVerifyToken,
};
