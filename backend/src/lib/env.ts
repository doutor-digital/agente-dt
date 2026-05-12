// ============================================================================
// env.ts — Validação de variáveis de ambiente no boot.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Falhar cedo é melhor do que falhar tarde. Se o KOMMO_ACCESS_TOKEN não
// existir, queremos saber no startup — não no momento em que o primeiro
// webhook chegar e tentar autenticar. O Zod nos dá esse "fail-fast" com
// uma mensagem clara.
//
// Centralizamos o `env` para que nenhum outro módulo precise tocar em
// `process.env` diretamente. Isso evita typos ("ANTROPIC_API_KEY" vs
// "ANTHROPIC_API_KEY") e dá autocompletar tipado.
// ============================================================================

import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  KOMMO_SUBDOMAIN: z.string().min(1),
  KOMMO_ACCESS_TOKEN: z.string().min(10),

  // Opcionais — quando ambos setados, sendChatReply usa o Salesbot pra
  // entregar a resposta da IA ao paciente via WhatsApp (caminho que
  // contorna a limitação da API v4 com canais WABA nativos).
  //
  // KOMMO_SALESBOT_ID: ID numérico do Salesbot minimalista (1 bloco "Enviar
  // mensagem" com conteúdo {{lead.cf.<id>}}).
  //
  // KOMMO_REPLY_FIELD_ID: ID numérico do custom field "Resposta IA" no lead.
  // O backend escreve a resposta da IA nesse campo antes de disparar o bot.
  KOMMO_SALESBOT_ID: z.coerce.number().int().positive().optional(),
  KOMMO_REPLY_FIELD_ID: z.coerce.number().int().positive().optional(),

  OPENAI_API_KEY: z.string().min(10),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  // Aceita lista separada por vírgula pra suportar múltiplas origens
  // (ex: domínio do Vercel + domínio customizado). Strip trailing slash
  // de cada uma — CORS exige match byte-a-byte e o navegador nunca manda
  // a barra final no header Origin.
  FRONTEND_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Em produção isso aqui derruba o container — exatamente o que queremos
  // se uma var crítica está faltando. Melhor crashloop do que rodar quebrado.
  console.error('[env] Configuração inválida:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
