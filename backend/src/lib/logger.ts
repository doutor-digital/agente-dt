import pino from 'pino';
import type { LogLevel } from '@prisma/client';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { limparParaLog, mascararTexto } from './log-sem-segredo.js';

const MSG_MAX = 2_000;
const CONTEXT_MAX_BYTES = 64_000;

const PERSIST_THRESHOLD = 40;

const LEVEL_MAP: Record<number, LogLevel> = {
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function safeStringify(value: unknown): string | null {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (_k, v) => {
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack };
      }
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    });
    if (!json) return null;
    return json.length > CONTEXT_MAX_BYTES
      ? JSON.stringify({ _truncated: true, preview: json.slice(0, 1_000) })
      : json;
  } catch {
    return null;
  }
}

interface ExtractedLog {
  msg: string;
  module: string | null;
  unitId: string | null;
  traceId: string | null;
  context: unknown;
}

export function extractLog(args: unknown[]): ExtractedLog {
  let context: Record<string, unknown> = {};
  let msgParts: unknown[] = [];

  if (typeof args[0] === 'object' && args[0] !== null) {
    // o mesmo filtro da saída do serviço: `system_logs` também não guarda credencial
    const limpo = limparParaLog(args[0] instanceof Error ? { err: args[0] } : args[0]);
    context = typeof limpo === 'object' && limpo !== null ? { ...(limpo as Record<string, unknown>) } : { valor: limpo };
    msgParts = args.slice(1);
  } else {
    msgParts = args;
  }

  const msgRaw = msgParts
    .map((p) => (typeof p === 'string' ? mascararTexto(p) : safeStringify(limparParaLog(p)) ?? String(p)))
    .join(' ');

  const module =
    typeof context.module === 'string' ? context.module : null;
  const unitId =
    typeof context.unitId === 'string' ? context.unitId : null;
  const traceId =
    typeof context.traceId === 'string' ? context.traceId : null;

  return {
    msg: truncate(msgRaw || '(no message)', MSG_MAX),
    module,
    unitId,
    traceId,
    context,
  };
}

function persistLog(numericLevel: number, args: unknown[]): void {
  const level = LEVEL_MAP[numericLevel];
  if (!level) return;
  const { msg, module, unitId, traceId, context } = extractLog(args);
  const contextJson = safeStringify(context);

  void prisma.systemLog
    .create({
      data: {
        level,
        module,
        msg,
        context: contextJson ? JSON.parse(contextJson) : undefined,
        unitId,
        traceId,
      },
    })
    .catch(() => {
    });
}

/** Exportadas para o teste usar EXATAMENTE a configuração do logger de produção (log-sem-segredo.test.ts). */
export const redacao = {
  paths: [
    'err.config.headers.Authorization',
    'err.config.headers.authorization',
    'err.response.config.headers.Authorization',
    'err.response.config.headers.authorization',
    'err.request._header',
    'err.config.data',
    '*.config.headers.Authorization',
    '*.config.headers.authorization',
    'headers.Authorization',
    'headers.authorization',
    'token',
    'accessToken',
    'spineToken',
  ],
  censor: '[redigido]',
};

// Os caminhos acima não bastam para erro do axios: o cabeçalho se repete em `err.response.request._header`,
// `err.request.res.req._header` e no invólucro de redirecionamento (token de Olímpia no log, 14/10/2026).
// Aqui o erro HTTP vira um resumo sem config/request/response ANTES de ser serializado — ver log-sem-segredo.ts.
export const formatadores = {
  log(obj: Record<string, unknown>): Record<string, unknown> {
    const limpo = limparParaLog(obj);
    return typeof limpo === 'object' && limpo !== null ? (limpo as Record<string, unknown>) : { valor: limpo };
  },
};

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'agente-dt-backend' },
  redact: redacao,
  formatters: formatadores,
  hooks: {
    logMethod(args, method, level) {
      method.apply(this, args as Parameters<typeof method>);
      if (level >= PERSIST_THRESHOLD) {
        try {
          persistLog(level, args as unknown[]);
        } catch {
        }
      }
    },
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});
