import { mascararPii } from './pii.js';
import { logger } from './logger.js';

const COALESCE_WINDOW_MS = 8_000;
const MAX_BURST_DURATION_MS = 30_000;
const MAX_MESSAGES_PER_BURST = 20;

interface PendingMessage {
  text: string;
  audioUrl: string | null;
  imageUrl: string | null;
  arrivedAt: number;
  traceId: string;
}

interface BufferEntry {
  openedAt: number;
  timer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
  pending: PendingMessage[];
  flush: (combined: string, audioUrls: string[], imageUrls: string[], traceIds: string[]) => Promise<void>;
  running: boolean;
}

const buffers = new Map<string, BufferEntry>();

function bufferKey(unitSlug: string, leadId: number | string): string {
  return `${unitSlug}::${leadId}`;
}

export function scheduleAgentRun(args: {
  unitSlug: string;
  leadId: number;
  traceId: string;
  humanMessage: string;
  audioUrl: string | null;
  imageUrl: string | null;
  run: (combined: string, audioUrls: string[], imageUrls: string[], traceIds: string[]) => Promise<void>;
}): 'started' | 'joined' | 'rejected' {
  const key = bufferKey(args.unitSlug, args.leadId);
  const existing = buffers.get(key);
  const now = Date.now();

  const newMsg: PendingMessage = {
    text: args.humanMessage,
    audioUrl: args.audioUrl,
    imageUrl: args.imageUrl,
    arrivedAt: now,
    traceId: args.traceId,
  };

  if (existing) {
    if (existing.pending.length >= MAX_MESSAGES_PER_BURST) {
      logger.warn(
        { key, count: existing.pending.length },
        'coalescer: burst cheio, mensagem nova será processada em novo run',
      );
      return 'rejected';
    }
    existing.flush = args.run;
    existing.pending.push(newMsg);
    if (existing.running) {
      logger.debug(
        { key, count: existing.pending.length },
        'coalescer: msg anexada durante flush em curso (sem novo timer)',
      );
      return 'joined';
    }
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => fire(key), COALESCE_WINDOW_MS);
    logger.debug(
      { key, count: existing.pending.length, sinceOpen: now - existing.openedAt },
      'coalescer: mensagem anexada ao burst',
    );
    return 'joined';
  }

  const entry: BufferEntry = {
    openedAt: now,
    pending: [newMsg],
    flush: args.run,
    timer: setTimeout(() => fire(key), COALESCE_WINDOW_MS),
    maxTimer: setTimeout(() => fire(key), MAX_BURST_DURATION_MS),
    running: false,
  };
  buffers.set(key, entry);
  logger.debug({ key }, 'coalescer: burst iniciado');
  return 'started';
}

function fire(key: string): void {
  const entry = buffers.get(key);
  if (!entry) return;
  if (entry.running) {
    return;
  }
  if (entry.pending.length === 0) {
    buffers.delete(key);
    return;
  }

  if (entry.timer) clearTimeout(entry.timer);
  if (entry.maxTimer) clearTimeout(entry.maxTimer);
  entry.timer = null;
  entry.maxTimer = null;

  const messages = entry.pending.splice(0, entry.pending.length);
  const combined = messages.map((m) => m.text).join('\n\n');
  const audioUrls = messages.map((m) => m.audioUrl).filter((u): u is string => !!u);
  const imageUrls = messages.map((m) => m.imageUrl).filter((u): u is string => !!u);
  const traceIds = messages.map((m) => m.traceId);
  const flush = entry.flush;
  entry.running = true;

  logger.info(
    {
      key,
      count: messages.length,
      duration: Date.now() - entry.openedAt,
      preview: mascararPii(combined.slice(0, 80)),
    },
    messages.length > 1
      ? 'coalescer: flush — combinando burst em 1 turno'
      : 'coalescer: flush — mensagem única',
  );

  void flush(combined, audioUrls, imageUrls, traceIds)
    .catch((err) => {
      logger.error({ err, key }, 'coalescer: erro no flush');
    })
    .finally(() => {
      const cur = buffers.get(key);
      if (!cur) return;
      cur.running = false;
      if (cur.pending.length > 0) {
        logger.info(
          { key, count: cur.pending.length },
          'coalescer: msgs chegaram durante flush — encadeando próximo turno',
        );
        cur.timer = setTimeout(() => fire(key), COALESCE_WINDOW_MS);
        cur.maxTimer = setTimeout(() => fire(key), MAX_BURST_DURATION_MS);
        cur.openedAt = Date.now();
      } else {
        buffers.delete(key);
      }
    });
}

export function _coalescerStats(): { activeBursts: number } {
  return { activeBursts: buffers.size };
}

export function flushAll(): void {
  for (const key of Array.from(buffers.keys())) fire(key);
}
