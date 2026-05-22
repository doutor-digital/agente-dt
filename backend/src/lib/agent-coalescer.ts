// ============================================================================
// agent-coalescer.ts — Junta mensagens em rajada numa única execução do agente.
//
// PROBLEMA QUE RESOLVE
// --------------------
// Paciente manda 3 mensagens em sequência ("oi", "tudo bem?", "quero marcar").
// Cada uma vira um webhook do Kommo, cada webhook dispara `processAgent` em
// paralelo. Resultado: 3 runs concorrentes da IA, 3 respostas duplicadas,
// possível corrupção do checkpoint do LangGraph (que é por thread_id).
//
// SOLUÇÃO
// -------
// Janela de debounce por lead. Quando chega uma mensagem:
//  - Se já tem buffer aberto pro lead: anexa a mensagem, REINICIA o timer.
//  - Se não tem: abre buffer + agenda timer.
// Quando o timer expira (3s de silêncio):
//  - Combina mensagens com "\n\n"
//  - Roda `processAgent` UMA vez
//  - O trace usado é o do PRIMEIRO webhook do burst; webhooks seguintes só
//    registram step "coalescida no trace X" no recorder próprio e somem.
//
// LIMITAÇÕES
// ----------
// - In-memory: se o processo reiniciar no meio de um burst, as mensagens
//   bufferizadas se perdem (mas o histórico de Message do banco preserva
//   tudo — o agente só vai ver "uma a uma" em vez de coalescido). Aceitável.
// - Single-process. Pra escalar horizontalmente, mover pra Redis pub/sub.
// ============================================================================

import { logger } from './logger.js';

const COALESCE_WINDOW_MS = 3_000;       // 3s de silêncio antes de rodar
const MAX_BURST_DURATION_MS = 30_000;   // hard cap: nunca segura mais de 30s
const MAX_MESSAGES_PER_BURST = 20;      // safety: evita memória crescente sem limite

interface PendingMessage {
  text: string;
  audioUrl: string | null;
  arrivedAt: number;
  /** traceId do webhook que trouxe ESTA mensagem em particular. */
  traceId: string;
}

interface BufferEntry {
  /** Quando o buffer abriu (1ª mensagem do burst). */
  openedAt: number;
  /** Timer atual de debounce. */
  timer: NodeJS.Timeout;
  /** Hard-cap timer — força flush mesmo se mensagens não param. */
  maxTimer: NodeJS.Timeout;
  /** Mensagens acumuladas, em ordem de chegada. */
  pending: PendingMessage[];
  /** Função que roda quando o timer expira (closure preservando args do 1º webhook). */
  flush: (combined: string, audioUrls: string[], traceIds: string[]) => Promise<void>;
}

const buffers = new Map<string, BufferEntry>();

/** Chave única por lead (Unit + leadId). Evita colisão entre tenants. */
function bufferKey(unitSlug: string, leadId: number | string): string {
  return `${unitSlug}::${leadId}`;
}

/**
 * Agenda (ou anexa a) um run do agente com debounce.
 *
 * @returns 'started'   — primeiro do burst, timer iniciado
 *          'joined'    — burst em curso, mensagem anexada
 *          'rejected'  — burst cheio, processou sozinho (raro)
 */
export function scheduleAgentRun(args: {
  unitSlug: string;
  leadId: number;
  traceId: string;
  humanMessage: string;
  audioUrl: string | null;
  /**
   * Função que de fato roda o agente. Recebe a mensagem combinada de todo o
   * burst + a lista de audioUrls + a lista de traceIds (pra que o caller
   * possa associar a execução a todos os webhooks que entraram).
   *
   * Só é chamada UMA vez, quando o debounce expirar.
   */
  run: (combined: string, audioUrls: string[], traceIds: string[]) => Promise<void>;
}): 'started' | 'joined' | 'rejected' {
  const key = bufferKey(args.unitSlug, args.leadId);
  const existing = buffers.get(key);
  const now = Date.now();

  const newMsg: PendingMessage = {
    text: args.humanMessage,
    audioUrl: args.audioUrl,
    arrivedAt: now,
    traceId: args.traceId,
  };

  if (existing) {
    // Hard cap de mensagens — se exceder, deixa a próxima criar seu próprio
    // burst em vez de inflar o atual indefinidamente.
    if (existing.pending.length >= MAX_MESSAGES_PER_BURST) {
      logger.warn(
        { key, count: existing.pending.length },
        'coalescer: burst cheio, mensagem nova será processada em novo run',
      );
      return 'rejected';
    }
    // Anexa + reinicia timer.
    clearTimeout(existing.timer);
    existing.pending.push(newMsg);
    existing.timer = setTimeout(() => fire(key), COALESCE_WINDOW_MS);
    logger.debug(
      { key, count: existing.pending.length, sinceOpen: now - existing.openedAt },
      'coalescer: mensagem anexada ao burst',
    );
    return 'joined';
  }

  // Primeira do burst — guarda flush (closure com `run` do caller).
  const entry: BufferEntry = {
    openedAt: now,
    pending: [newMsg],
    flush: args.run,
    timer: setTimeout(() => fire(key), COALESCE_WINDOW_MS),
    maxTimer: setTimeout(() => fire(key), MAX_BURST_DURATION_MS),
  };
  buffers.set(key, entry);
  logger.debug({ key }, 'coalescer: burst iniciado');
  return 'started';
}

/**
 * Dispara o flush do buffer. Idempotente — se chamado 2x (timer + maxTimer
 * concorrendo), o segundo encontra buffer vazio e sai.
 */
function fire(key: string): void {
  const entry = buffers.get(key);
  if (!entry) return;
  buffers.delete(key);
  clearTimeout(entry.timer);
  clearTimeout(entry.maxTimer);

  const messages = entry.pending;
  const combined = messages.map((m) => m.text).join('\n\n');
  const audioUrls = messages.map((m) => m.audioUrl).filter((u): u is string => !!u);
  const traceIds = messages.map((m) => m.traceId);

  logger.info(
    {
      key,
      count: messages.length,
      duration: Date.now() - entry.openedAt,
      preview: combined.slice(0, 80),
    },
    messages.length > 1
      ? 'coalescer: flush — combinando burst em 1 turno'
      : 'coalescer: flush — mensagem única',
  );

  // Fire-and-forget. Erros propagados pelo logger do próprio flush.
  void entry.flush(combined, audioUrls, traceIds).catch((err) => {
    logger.error({ err, key }, 'coalescer: erro no flush');
  });
}

/** Só pra observabilidade/testes. */
export function _coalescerStats(): { activeBursts: number } {
  return { activeBursts: buffers.size };
}

/** Força flush imediato de todos os buffers — usado em shutdown gracioso. */
export function flushAll(): void {
  for (const key of Array.from(buffers.keys())) fire(key);
}
