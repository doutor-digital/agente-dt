// ============================================================================
// instagram.service.ts — Cliente da Graph API para COMENTÁRIOS do Instagram.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Canal diferente do WhatsApp em natureza, não só em endpoint:
//
//   WhatsApp  → conversa privada, 1:1, com histórico e janela de 24h.
//   Comentário→ evento público, one-shot, sem histórico, visível pra todos.
//
// Por isso este service NÃO reusa o fluxo do meta.service: não há thread, não
// há lead, e o que se escreve fica exposto. O que ele reusa é a validação de
// signature (mesmo HMAC do app da Meta) — essa parte é idêntica.
//
// AS DUAS ESCRITAS
// ----------------
//   POST /{ig-comment-id}/replies    → responde PUBLICAMENTE, no comentário.
//   POST /{ig-user-id}/messages      → RESPOSTA PRIVADA, com
//        { recipient: { comment_id } }  abre um DM com quem comentou.
//
// A resposta privada é a peça que faz o canal valer a pena: a Meta permite
// UMA mensagem em resposta a um comentário, dentro de 7 dias, SEM depender da
// janela de 24h de messaging. É o único jeito de puxar pro privado alguém que
// nunca te mandou mensagem.
//
// PERMISSÕES (App Review) — sem elas as duas chamadas retornam 200 com erro
// no corpo ou 403: gerenciar comentários (ler + responder) e gerenciar
// mensagens (resposta privada), na conta IG Profissional ligada à Página.
// ============================================================================

import axios from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';

const IG_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

export type SocialPlatform = 'instagram' | 'facebook';

/**
 * As duas redes têm os MESMOS conceitos com nomes de coluna diferentes.
 * Resolver isso num lugar só evita `platform === 'facebook' ? unit.fbX :
 * unit.igX` espalhado por controller, service e agente — que é exatamente o
 * padrão que fez a transcrição de áudio morrer em silêncio: cada call site
 * lendo a credencial do seu jeito, um deles errado.
 */
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

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface IgInboundComment {
  commentId: string;
  mediaId: string | null;
  /** Preenchido quando o comentário é resposta a outro comentário. */
  parentId: string | null;
  authorId: string | null;
  authorUsername: string | null;
  text: string;
  /** IG Business Account que recebeu (entry.id do webhook). */
  recipientId: string | null;
  timestamp: number;
}

export interface IgSendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Credenciais efetivas
// ---------------------------------------------------------------------------
// O app secret pode ser o mesmo do WhatsApp (app único na Meta) ou próprio.
// Resolver aqui evita que cada chamador reimplemente o fallback — e evita a
// classe de bug que já nos custou a transcrição de áudio morta em silêncio,
// onde cada call site lia a credencial do seu jeito.

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

// ---------------------------------------------------------------------------
// Handshake do webhook (GET).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parse do payload de comentários.
// ---------------------------------------------------------------------------
// Formato (object: "instagram", field: "comments"):
// {
//   "object": "instagram",
//   "entry": [{
//     "id": "<IG_USER_ID>", "time": 1700000000,
//     "changes": [{
//       "field": "comments",
//       "value": {
//         "id": "<COMMENT_ID>",
//         "text": "quanto custa?",
//         "from": { "id": "...", "username": "fulana" },
//         "media": { "id": "<MEDIA_ID>", "media_product_type": "FEED" },
//         "parent_id": "<COMMENT_ID>"     // só quando é resposta
//       }
//     }]
//   }]
// }
//
// Ignoramos changes de outros fields (mentions, live_comments, story_insights):
// cada um tem semântica própria e responder a todos com a mesma régua seria
// errado.

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

// ---------------------------------------------------------------------------
// Parse do payload de comentários do FACEBOOK.
// ---------------------------------------------------------------------------
// Formato (object: "page", field: "feed"):
// {
//   "object": "page",
//   "entry": [{ "id": "<PAGE_ID>", "time": 170..., "changes": [{
//     "field": "feed",
//     "value": {
//       "item": "comment", "verb": "add",
//       "comment_id": "...", "post_id": "...", "parent_id": "...",
//       "from": { "id": "...", "name": "Fulana" }, "message": "quanto custa?"
//     }}]}]
// }
//
// O `feed` da Página carrega MUITA coisa além de comentário — curtida, reação,
// post novo, edição, remoção. Filtrar por item=comment E verb=add é o que
// impede o agente de "responder" a uma curtida ou a um comentário apagado.

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
        // No Facebook o parent_id do comentário raiz é o próprio post — só é
        // resposta a outro comentário quando difere do post_id.
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

// ---------------------------------------------------------------------------
// Escrita 1 — resposta PÚBLICA no comentário.
// ---------------------------------------------------------------------------

export async function replyToComment(
  cfg: Pick<PlatformConfig, 'accessToken'>,
  commentId: string,
  message: string,
  platform: SocialPlatform = 'instagram',
): Promise<IgSendResult> {
  if (!cfg.accessToken) return { ok: false, error: 'sem access token' };
  // Instagram responde em /replies; a Página do Facebook, em /comments.
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
    logger.warn({ err, commentId }, 'instagram: resposta pública falhou');
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Escrita 2 — resposta PRIVADA (abre o DM).
// ---------------------------------------------------------------------------
// `recipient: { comment_id }` é o que permite mandar DM pra quem nunca falou
// com a gente. UMA por comentário — a segunda tentativa a Meta rejeita. Por
// isso quem chama precisa ter certeza antes: não há retry sem custo aqui.

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
  // Os dois caminhos são DIFERENTES, não é detalhe cosmético:
  //   Instagram → POST /{ig-user-id}/messages  com recipient.comment_id
  //   Facebook  → POST /{comment-id}/private_replies  com message
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
    logger.warn({ err, commentId }, 'instagram: resposta privada falhou');
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Link do WhatsApp.
// ---------------------------------------------------------------------------
// Vai SÓ no DM, nunca no comentário público: link externo em comentário
// derruba alcance e entrega o número pra quem estiver garimpando concorrente.

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
