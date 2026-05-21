// ============================================================================
// logger.ts — Logger estruturado (Pino) + persistência de warn+ em DB.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Logs estruturados (JSON) em produção e bonitos (pino-pretty) em dev.
// Cada log que escrevemos deve carregar contexto suficiente para correlação:
// `threadId`, `leadId`, `traceId`. Em produção isso permite buscar uma
// execução inteira no Datadog/Loki com um único filtro.
//
// PAINEL "ERROS" — persistência automática
// ----------------------------------------
// O hook `logMethod` do Pino intercepta TODA chamada (`logger.warn/error/fatal`),
// extrai msg + context, e dispara um INSERT em `system_logs` de forma
// fire-and-forget (sem await). Resultado: zero mudança nos callsites — todo
// `logger.warn(...)` que já existe no código passa a aparecer no painel.
//
// Convenções pra ficar lindo no painel:
//  - Sempre passe `module` no contexto: `logger.warn({ module: 'kommo.service', ... }, 'msg')`
//  - Se houver `traceId` ou `unitId` no contexto, eles viram FKs no banco
//    (permitindo drill-down do erro pro trace).
//
// Limites de proteção:
//  - msg truncado em 2KB
//  - context serializado limitado a 64KB (mensagens gigantes viram '[truncated]')
//  - Insert é fire-and-forget com .catch silencioso — logging NUNCA derruba request.
// ============================================================================

import pino from 'pino';
import type { LogLevel } from '@prisma/client';
import { env } from './env.js';
import { prisma } from './prisma.js';

const MSG_MAX = 2_000;
const CONTEXT_MAX_BYTES = 64_000;

// Pino numeric levels: trace=10, debug=20, info=30, warn=40, error=50, fatal=60.
// Persistimos só warn+ pra não explodir o banco com info de health-check etc.
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
  // Pino accepts: (msg), (obj, msg), (obj, fmt, ...args), (fmt, ...args)
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

  // Não duplica no context o que já virou coluna dedicada.
  // (Mantém pra não perder info se houver erros distintos com mesmo key.)

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

  // Fire-and-forget. Falha de DB nunca pode quebrar logging — o stdout
  // já recebeu a mensagem, então perda aqui é só ausência no painel.
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
      // Silencioso de propósito: se logarmos o erro de log, vira loop.
    });
}

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'agente-dt-backend' },
  hooks: {
    logMethod(args, method, level) {
      // Sempre chama o método original primeiro (stdout intacto, comportamento
      // existente preservado).
      method.apply(this, args as Parameters<typeof method>);
      if (level >= PERSIST_THRESHOLD) {
        try {
          persistLog(level, args as unknown[]);
        } catch {
          // Se a extração falhar, segue. Logging nunca derruba caller.
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
