import pino from 'pino';
import type { LogLevel } from '@prisma/client';
import { env } from './env.js';
import { prisma } from './prisma.js';

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

function extractLog(args: unknown[]): ExtractedLog {
  let context: Record<string, unknown> = {};
  let msgParts: unknown[] = [];

  if (typeof args[0] === 'object' && args[0] !== null) {
    context = { ...(args[0] as Record<string, unknown>) };
    msgParts = args.slice(1);
  } else {
    msgParts = args;
  }

  const msgRaw = msgParts
    .map((p) => (typeof p === 'string' ? p : safeStringify(p) ?? String(p)))
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

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'agente-dt-backend' },
  redact: {
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
  },
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
