
// ============================================================================
// google-calendar.service.ts — OAuth 2.0 + criação de eventos.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Implementa OAuth 2.0 do Google sem usar a googleapis SDK (que é gigante).
// Usamos axios direto com os endpoints oficiais:
//   - GET  https://accounts.google.com/o/oauth2/v2/auth   (consent screen)
//   - POST https://oauth2.googleapis.com/token            (exchange + refresh)
//   - POST https://www.googleapis.com/calendar/v3/calendars/{id}/events
//
// Token refresh é lazy: antes de cada createEvent, checa expiresAt e
// se faltar < 60s renova com refreshToken.
// ============================================================================

import axios from 'axios';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'openid', 'email'];

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startIso: string;            // ISO 8601 com timezone offset
  durationMinutes: number;
  attendeeEmails?: string[];
  timeZone?: string;           // ex: "America/Sao_Paulo"
}

export interface CalendarEventResult {
  eventId: string;
  htmlLink: string;
  meetLink?: string | null;
}

// ---------------------------------------------------------------------------
// 1. URL de consentimento
// ---------------------------------------------------------------------------

export function isGoogleConfigured(): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI);
}

export function buildAuthUrl(unitId: string): string {
  if (!isGoogleConfigured()) {
    throw new Error('GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI não configurados no env');
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',     // garante refresh_token
    prompt: 'consent',          // força tela de permissão (e novo refresh_token)
    state: unitId,              // unitId no state pra saber quem está conectando
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// 2. Exchange do code pelo refresh_token + access_token + salva na Unit
// ---------------------------------------------------------------------------

export async function exchangeCodeForTokens(code: string, unitId: string): Promise<void> {
  if (!isGoogleConfigured()) throw new Error('Google OAuth não configurado');

  const { data } = await axios.post<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  }>(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  // Decodifica email do id_token (JWT) — só pra mostrar no painel.
  let email: string | null = null;
  if (data.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64').toString());
      email = payload.email ?? null;
    } catch {
      /* ignore */
    }
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await prisma.unit.update({
    where: { id: unitId },
    data: {
      googleAccessToken: data.access_token,
      googleRefreshToken: data.refresh_token ?? undefined, // só vem na primeira vez
      googleTokenExpiresAt: expiresAt,
      googleAuthorizedEmail: email,
      googleAuthorizedAt: new Date(),
      googleCalendarId: 'primary',
    },
  });
}

// ---------------------------------------------------------------------------
// 3. Refresh do access_token se expirou
// ---------------------------------------------------------------------------

async function getValidAccessToken(unit: Unit): Promise<string> {
  if (!unit.googleAccessToken) throw new Error('Unit não conectada ao Google Calendar');

  // Buffer de 60s: renova um pouco antes de expirar pra evitar 401.
  const aboutToExpire =
    !unit.googleTokenExpiresAt || unit.googleTokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!aboutToExpire) return unit.googleAccessToken;

  if (!unit.googleRefreshToken) {
    throw new Error('Sem refresh_token — reconecte a Unit ao Google Calendar');
  }
  if (!isGoogleConfigured()) throw new Error('Google OAuth não configurado');

  const { data } = await axios.post<{ access_token: string; expires_in: number }>(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: unit.googleRefreshToken,
      grant_type: 'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await prisma.unit.update({
    where: { id: unit.id },
    data: {
      googleAccessToken: data.access_token,
      googleTokenExpiresAt: expiresAt,
    },
  });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// 4. Criar evento no Calendar da Unit
// ---------------------------------------------------------------------------

export async function createCalendarEvent(
  unit: Unit,
  input: CalendarEventInput,
): Promise<CalendarEventResult> {
  const accessToken = await getValidAccessToken(unit);
  const calendarId = unit.googleCalendarId ?? 'primary';

  const start = new Date(input.startIso);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  const timeZone = input.timeZone ?? 'America/Sao_Paulo';

  const body = {
    summary: input.summary,
    description: input.description ?? '',
    start: { dateTime: start.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
    ...(input.attendeeEmails && input.attendeeEmails.length > 0
      ? { attendees: input.attendeeEmails.map((email) => ({ email })) }
      : {}),
    conferenceData: {
      createRequest: {
        requestId: `agente-dt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };

  try {
    const { data } = await axios.post<{
      id: string;
      htmlLink: string;
      hangoutLink?: string;
    }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      body,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { conferenceDataVersion: 1, sendUpdates: 'all' },
        timeout: 15_000,
      },
    );
    return {
      eventId: data.id,
      htmlLink: data.htmlLink,
      meetLink: data.hangoutLink ?? null,
    };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const detail = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : (err as Error).message;
    logger.warn({ status, detail, unitId: unit.id }, 'createCalendarEvent failed');
    throw new Error(`Google Calendar API ${status ?? '?'}: ${detail}`);
  }
}
