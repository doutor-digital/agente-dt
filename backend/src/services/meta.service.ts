import axios from 'axios';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';

const META_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

export interface MetaInboundMessage {
  messageId: string;
  from: string;
  contactName: string | null;
  text: string | null;
  type: string;
  timestamp: number;
  toPhoneNumberId: string;
}

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

export function validateSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string | null,
): boolean {
  if (!appSecret) {
    return true;
  }
  if (!signatureHeader) return false;
  const [scheme, hex] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !hex) return false;

  const computed = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  if (computed.length !== hex.length) return false;
  return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hex, 'hex'));
}

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
    logger.warn({ erro: msg, to, phoneNumberId: unit.metaPhoneNumberId }, 'meta sendText falhou');
    return { ok: false, error: msg };
  }
}

export const MetaService = {
  verifyWebhook,
  validateSignature,
  parseInbound,
  sendText,
};
