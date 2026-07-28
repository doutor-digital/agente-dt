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
  unit: Pick<Unit, 'igVerifyToken' | 'metaVerifyToken'>,
  query: { mode?: string; token?: string; challenge?: string },
): { ok: boolean; challenge?: string; reason?: string } {
  const expected = resolveIgVerifyToken(unit);
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
// Escrita 1 — resposta PÚBLICA no comentário.
// ---------------------------------------------------------------------------

export async function replyToComment(
  unit: Pick<Unit, 'igAccessToken'>,
  commentId: string,
  message: string,
): Promise<IgSendResult> {
  if (!unit.igAccessToken) return { ok: false, error: 'unit sem ig_access_token' };
  try {
    const { data } = await axios.post(
      `${IG_GRAPH_BASE}/${commentId}/replies`,
      { message },
      {
        headers: { Authorization: `Bearer ${unit.igAccessToken}` },
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
  unit: Pick<Unit, 'igUserId' | 'igAccessToken'>,
  commentId: string,
  text: string,
): Promise<IgSendResult> {
  if (!unit.igUserId || !unit.igAccessToken) {
    return { ok: false, error: 'unit sem ig_user_id/ig_access_token' };
  }
  try {
    const { data } = await axios.post(
      `${IG_GRAPH_BASE}/${unit.igUserId}/messages`,
      {
        recipient: { comment_id: commentId },
        message: { text },
      },
      {
        headers: { Authorization: `Bearer ${unit.igAccessToken}` },
        timeout: 15_000,
      },
    );
    return { ok: true, id: (data as { message_id?: string }).message_id };
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
  replyToComment,
  sendPrivateReply,
  buildWhatsappLink,
  resolveIgAppSecret,
  resolveIgVerifyToken,
};
