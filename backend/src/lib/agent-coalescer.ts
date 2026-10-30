import { mascararPii } from './pii.js';
import { logger } from './logger.js';

// Janela de espera por mais mensagens do mesmo paciente antes de responder.
// Ajustável por ambiente (AGENT_COALESCE_MS) para testar sem redeploy.
const COALESCE_WINDOW_MS = Number(process.env.AGENT_COALESCE_MS) || 8_000;
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

/**
 * Serviço recebeu SIGTERM: ninguém espera a janela de 8 s, porque o que ficar na memória morre com o processo.
 * Caso real (Timbó, lead 5142896, 30/10/2026): a foto da paciente ficou na fila, o deploy veio, e ela nunca foi respondida.
 */
let desligando = false;

function janelaAtual(): number {
  return desligando ? 0 : COALESCE_WINDOW_MS;
}

/** Traces que este processo tem na fila ou rodando (burst do coalescer ou turno avulso). */
const emVoo = new Set<string>();

export function idsEmVoo(): string[] {
  return [...emVoo];
}

/** Turnos avulsos (fora do coalescer) em curso: o desligamento espera por eles junto com a fila. */
let avulsos = 0;

/**
 * Roda um turno que não passa pelo burst (hoje: burst cheio, `scheduleAgentRun` devolveu 'rejected') contando-o como
 * "em voo". Sem isto o SIGTERM não o via e o deploy o cortava; e quem olha `idsEmVoo` o tomaria por perdido.
 */
export async function comTurnoAvulso<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
  avulsos++;
  emVoo.add(traceId);
  try {
    return await fn();
  } finally {
    emVoo.delete(traceId);
    avulsos--;
  }
}

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
    emVoo.add(args.traceId);
    if (existing.running) {
      logger.debug(
        { key, count: existing.pending.length },
        'coalescer: msg anexada durante flush em curso (sem novo timer)',
      );
      return 'joined';
    }
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => fire(key), janelaAtual());
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
    timer: setTimeout(() => fire(key), janelaAtual()),
    maxTimer: setTimeout(() => fire(key), MAX_BURST_DURATION_MS),
    running: false,
  };
  buffers.set(key, entry);
  emVoo.add(args.traceId);
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
  // áudio e imagem chegam com texto vazio: sem o filtro, uma rajada só de áudios virava espaço em branco
  const combined = messages.map((m) => m.text).filter((t) => t && t.trim()).join('\n\n');
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
      for (const id of traceIds) emVoo.delete(id);
      const cur = buffers.get(key);
      if (!cur) return;
      cur.running = false;
      if (cur.pending.length > 0) {
        logger.info(
          { key, count: cur.pending.length },
          'coalescer: msgs chegaram durante flush — encadeando próximo turno',
        );
        cur.timer = setTimeout(() => fire(key), janelaAtual());
        cur.maxTimer = setTimeout(() => fire(key), MAX_BURST_DURATION_MS);
        cur.openedAt = Date.now();
      } else {
        buffers.delete(key);
      }
    });
}

/**
 * Chegou mensagem nova deste paciente ENQUANTO o turno atual ainda roda?
 *
 * Medido em 24/09/2026: 14% das chamadas à IA nasciam assim, e 1.824 respostas
 * por semana saíam pro paciente depois de ele já ter mandado outra mensagem —
 * ele lia a resposta da pergunta velha embaixo da nova. Quem pergunta isto é o
 * envio: se há pendente, a resposta atual é segurada e o próximo turno (já na
 * fila) responde as duas de uma vez.
 */
export function temPendentes(unitSlug: string, leadId: number | string): boolean {
  const entry = buffers.get(bufferKey(unitSlug, leadId));
  return !!entry && entry.running && entry.pending.length > 0;
}

export function _coalescerStats(): { activeBursts: number } {
  return { activeBursts: buffers.size };
}

export function flushAll(): void {
  for (const key of Array.from(buffers.keys())) fire(key);
}

/**
 * Desligamento (SIGTERM): dispara AGORA tudo o que está esperando a janela, deixa o turno em curso acabar e
 * encadeia os seguintes sem janela. Espera a fila (e os turnos avulsos) esvaziar, no máximo `maxMs`; o que sobrar
 * morre com o processo.
 */
export async function drenarCoalescer(maxMs: number, passoMs = 25): Promise<{ restantes: number; esperouMs: number }> {
  desligando = true;
  const inicio = Date.now();
  flushAll();
  while ((buffers.size > 0 || avulsos > 0) && Date.now() - inicio < maxMs) {
    await new Promise((r) => setTimeout(r, passoMs));
  }
  return { restantes: buffers.size + avulsos, esperouMs: Date.now() - inicio };
}

/** Só para teste. */
export function _sairDoDesligamento(): void {
  desligando = false;
}
