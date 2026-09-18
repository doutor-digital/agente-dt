import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  KOMMO_SUBDOMAIN: z.string().min(1),
  KOMMO_ACCESS_TOKEN: z.string().min(10),

  KOMMO_SALESBOT_ID: z.coerce.number().int().positive().optional(),
  KOMMO_REPLY_FIELD_ID: z.coerce.number().int().positive().optional(),

  STALE_REPLY_ALERT_MINUTES: z.coerce.number().int().positive().default(3),

  OPENAI_API_KEY: z.string().min(10),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  OPENAI_TRANSCRIPTION_API_KEY: z.string().min(10).optional(),

  FRONTEND_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),

  SESSION_JWT_SECRET: z.string().min(32, 'SESSION_JWT_SECRET precisa ter >=32 chars'),

  AUTH_COOKIE_NAME: z.string().default('dt_session'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  INTERNAL_API_KEY: z.string().min(16).optional(),

  DASHBOARD_WEBHOOK_BASE_URL: z
    .string()
    .url()
    .default('https://doutor-digital-dash-production.up.railway.app/webhooks/agent'),

  // Ponte do widget "Números da unidade" (Kommo) com o dashboard (.NET, api-vps): a rota
  // `internal/audit/kpis` devolve número + conferência + lista nominal por card. Sem estes
  // três, a rota do widget responde `dashboard:false` e o widget mostra só as pendências do Kommo.
  DASHBOARD_API_URL: z.string().url().optional(),
  DASHBOARD_ADMIN_KEY: z.string().min(8).optional(),
  // JSON { "<subdomínio Kommo>": <unitId no dashboard> } — as duas bases não compartilham id nem slug (Porto: -porto × -porto-nacional)
  DASHBOARD_UNIT_IDS: z.string().optional(),
  /** Unidades onde a mudança de etapa carimba Início/Fim do tratamento e encerra a conversa (csv; `*` = todas). */
  CARIMBO_ETAPA_SLUGS: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Configuração inválida:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
