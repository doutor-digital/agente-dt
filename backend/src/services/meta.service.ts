// ============================================================================
// meta.service.ts — Cliente da Meta WhatsApp Cloud API.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Caminho ALTERNATIVO ao Kommo: a Meta expõe a Cloud API para enviar e
// receber mensagens WhatsApp diretamente, sem CRM intermediário. Útil para
// unidades que querem operar sem Kommo, ou para fallback quando o Kommo
// está fora.
//
// CADA UNIDADE TEM AS PRÓPRIAS CREDENCIAIS — toda função recebe a `unit`
// (ou as 4 credenciais soltas). Não usamos env globais aqui.
//
// Endpoints relevantes:
//   POST  /v22.0/{phone_number_id}/messages          — enviar mensagem
//   GET   /v22.0/{phone_number_id}                   — checar number
//   Webhooks (chega no nosso servidor):
//     GET  /webhooks/{slug}/meta?hub.mode=subscribe&...   — verify
//     POST /webhooks/{slug}/meta                          — eventos
//
// Validação de signature: a Meta assina o body do POST com HMAC-SHA256
// usando o APP_SECRET do app. Validamos o header `x-hub-signature-256`.
// ============================================================================

import axios from 'axios';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';

const META_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface MetaInboundMessage {
  /** ID único da mensagem dada pela Meta. */
  messageId: string;
  /** Phone number do remetente no formato E.164 sem '+'. */
  from: string;
  /** Nome de exibição (do profile do WhatsApp). */
  contactName: string | null;
  /** Texto recebido. Se a mensagem não for texto, fica null. */
  text: string | null;
  /** Tipo bruto: text, image, audio, video, document, etc. */
  type: string;
  /** Timestamp Unix da mensagem (segundos). */
  timestamp: number;
  /** Phone number id da unidade que recebeu (display id). */
  toPhoneNumberId: string;
}

// ---------------------------------------------------------------------------
// Verificação do webhook (handshake do Facebook).
// ---------------------------------------------------------------------------
// Quando você cadastra a URL do webhook na Meta, ela faz um GET com:
//   ?hub.mode=subscribe&hub.verify_token=XXX&hub.challenge=NNN
// Esperamos: respondemos com o challenge se o token bater.

export function verifyWebhook(
  unit: Pick<Unit, 'metaVerifyToken'>,
  query: { mode?: string; token?: string; challenge?: string },
): { ok: boolean; challenge?: string; reason?: string } {
  if (!unit.metaVerifyToken) {
    return { ok: false, reason: 'unit não tem meta_verify_token configurado' };
  }
  if (query.mode !== 'subscribe') {
    return { ok: false, reason: 'mode != subscribe' };
  }
  if (query.token !== unit.metaVerifyToken) {
    return { ok: false, reason: 'token inválido' };
  }
  return { ok: true, challenge: query.challenge ?? '' };
}

// ---------------------------------------------------------------------------
// Validação de signature do POST.
// ---------------------------------------------------------------------------
// A Meta envia `x-hub-signature-256: sha256=<hex>` calculado sobre o RAW
// body com HMAC-SHA256 usando o APP_SECRET. Sem o raw body byte-a-byte,
// não dá para validar — por isso o server precisa preservar o buffer.

export function validateSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string | null,
): boolean {
  if (!appSecret) {
    // Se a unidade não configurou app_secret, não tem como validar.
    // Em dev permitimos passar. Em prod, deveria reject — TODO.
    return true;
  }
  if (!signatureHeader) return false;
  const [scheme, hex] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !hex) return false;

  const computed = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  // timingSafeEqual exige buffers do mesmo tamanho.
  if (computed.length !== hex.length) return false;
  return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hex, 'hex'));
}

// ---------------------------------------------------------------------------
// Parse do payload de inbound da Meta.
// ---------------------------------------------------------------------------
// Estrutura esperada:
// {
//   "object": "whatsapp_business_account",
//   "entry": [{
//     "id": "WABA_ID",
//     "changes": [{
//       "value": {
//         "messaging_product": "whatsapp",
//         "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
//         "contacts": [{ "profile": { "name": "..." }, "wa_id": "..." }],
//         "messages": [{
//           "from": "...", "id": "wamid....", "timestamp": "...",
//           "type": "text",
//           "text": { "body": "..." }
//         }]
//       },
//       "field": "messages"
//     }]
//   }]
// }
//
// Extraímos a primeira mensagem encontrada — webhooks da Meta podem batchar,
// mas o uso típico é 1 evento por POST.

export function parseInbound(payload: unknown): MetaInboundMessage[] {
  const out: MetaInboundMessage[] = [];
  const root = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          metadata?: { phone_number_id?: string };
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
          messages?: Array<{
            id: string;
            from: string;
            timestamp: string;
            type: string;
            text?: { body?: string };
          }>;
        };
      }>;
    }>;
  };

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id ?? '';
      const contacts = value?.contacts ?? [];
      for (const m of value?.messages ?? []) {
        const contact = contacts.find((c) => c.wa_id === m.from);
        out.push({
          messageId: m.id,
          from: m.from,
          contactName: contact?.profile?.name ?? null,
          text: m.text?.body ?? null,
          type: m.type,
          timestamp: Number(m.timestamp) || 0,
          toPhoneNumberId: phoneNumberId,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// sendText — envia uma mensagem de texto via Cloud API.
// ---------------------------------------------------------------------------
// Endpoint: POST https://graph.facebook.com/v22.0/{phone_number_id}/messages
// Auth: Bearer access_token
// Limitação: fora da janela de 24h só é possível mandar templates aprovados.
// Aqui é envio de texto livre — só funciona dentro da janela.

export interface MetaSendResult {
  ok: boolean;
  messageId?: string;
  detail?: unknown;
  error?: string;
}

export async function sendText(
  unit: Pick<Unit, 'metaPhoneNumberId' | 'metaAccessToken'>,
  to: string,
  text: string,
): Promise<MetaSendResult> {
  if (!unit.metaPhoneNumberId || !unit.metaAccessToken) {
    return { ok: false, error: 'Unit sem credenciais Meta configuradas' };
  }

  const url = `${META_GRAPH_BASE}/${unit.metaPhoneNumberId}/messages`;
  try {
    const { data } = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${unit.metaAccessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );
    const messageId = (data as { messages?: Array<{ id?: string }> }).messages?.[0]?.id;
    return { ok: true, messageId, detail: data };
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status ?? '?'}: ${JSON.stringify(err.response?.data ?? err.message)}`
      : err instanceof Error ? err.message : String(err);
    logger.warn({ err, to, phoneNumberId: unit.metaPhoneNumberId }, 'meta sendText falhou');
    return { ok: false, error: msg };
  }
}

export const MetaService = {
  verifyWebhook,
  validateSignature,
  parseInbound,
  sendText,
};
