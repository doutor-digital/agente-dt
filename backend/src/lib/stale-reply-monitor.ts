import { env } from './env.js';
import { logger } from './logger.js';

interface PendingReply {
  unitId: string;
  unitSlug: string;
  unitName: string;
  leadId: string;
  text: string;
  patchedAt: number;
  alerted: boolean;
}

const STALE_MS = env.STALE_REPLY_ALERT_MINUTES * 60_000;
const SWEEP_MS = 30_000;
const MAX_AGE_MS = 2 * 60 * 60_000;
const MIN_SAMPLES_BEFORE_BLAMING_WEBHOOK = 3;

interface DeliverySample {
  unitSlug: string;
  leadId: string;
  latencyMs: number;
  slow: boolean;
  at: number;
}
const RECENT_MAX = 30;
const recent: DeliverySample[] = [];

const pendings = new Map<string, PendingReply>();
let everConfirmed = false;
let pendingsSeen = 0;
let warnedNoConfirmations = false;
let timer: NodeJS.Timeout | null = null;

function key(unitId: string, leadId: string): string {
  return `${unitId}:${leadId}`;
}

function normalize(s: string): string {
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}←-⇿⌀-⏿]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function trackPendingReply(args: {
  unitId: string;
  unitSlug: string;
  unitName: string;
  leadId: string;
  text: string;
}): void {
  pendings.set(key(args.unitId, args.leadId), {
    ...args,
    patchedAt: Date.now(),
    alerted: false,
  });
  pendingsSeen++;
}

export function confirmDelivery(args: {
  unitId: string;
  leadId: string | number;
  text?: string | null;
}): boolean {
  const k = key(args.unitId, String(args.leadId));
  const p = pendings.get(k);
  if (!p) return false;

  const out = args.text ? normalize(args.text) : '';
  const exp = normalize(p.text);
  const matches = out === '' || exp.includes(out) || out.includes(exp);
  if (!matches) return false;

  const latencyMs = Date.now() - p.patchedAt;
  pendings.delete(k);
  everConfirmed = true;
  recent.push({
    unitSlug: p.unitSlug,
    leadId: String(p.leadId),
    latencyMs,
    slow: latencyMs > STALE_MS,
    at: Date.now(),
  });
  if (recent.length > RECENT_MAX) recent.shift();
  logger.info(
    {
      unit: p.unitSlug,
      leadId: p.leadId,
      latencyMs,
      slow: latencyMs > STALE_MS,
    },
    `entrega confirmada — Salesbot do Kommo levou ${(latencyMs / 1000).toFixed(1)}s`,
  );
  return true;
}

function sweep(): void {
  const now = Date.now();
  let staleCount = 0;

  for (const [k, p] of pendings) {
    const age = now - p.patchedAt;
    if (age > MAX_AGE_MS) {
      pendings.delete(k);
      continue;
    }
    if (age <= STALE_MS) continue;
    staleCount++;
    if (p.alerted) continue;

    if (everConfirmed) {
      p.alerted = true;
      logger.error(
        { unit: p.unitSlug, unitId: p.unitId, leadId: p.leadId, ageSec: Math.round(age / 1000) },
        `🐢 Resposta da IA parada há ${Math.round(age / 60000)}min sem ser entregue (lead ${p.leadId}) — Salesbot do Kommo provavelmente engasgado. Empurre com /Agente DT na conversa.`,
      );
    }
  }

  if (
    !everConfirmed &&
    staleCount > 0 &&
    pendingsSeen >= MIN_SAMPLES_BEFORE_BLAMING_WEBHOOK &&
    !warnedNoConfirmations
  ) {
    warnedNoConfirmations = true;
    logger.warn(
      { pendingsSeen, staleCount },
      'monitor de entrega: respostas ficando paradas e NENHUMA confirmação recebida — verifique se o webhook do Kommo está enviando mensagens OUTGOING ao backend (sem isso o monitor não consegue medir a entrega).',
    );
  }
}

export function getStaleReplies(): Array<{
  unitId: string;
  unitSlug: string;
  unitName: string;
  leadId: string;
  ageMin: number;
}> {
  if (!everConfirmed) return [];
  const now = Date.now();
  const out: ReturnType<typeof getStaleReplies> = [];
  for (const p of pendings.values()) {
    const age = now - p.patchedAt;
    if (age > STALE_MS && age <= MAX_AGE_MS) {
      out.push({
        unitId: p.unitId,
        unitSlug: p.unitSlug,
        unitName: p.unitName,
        leadId: p.leadId,
        ageMin: Math.round(age / 60000),
      });
    }
  }
  return out;
}

export function getDeliveryStatus(): {
  everConfirmed: boolean;
  thresholdMin: number;
  pendingCount: number;
  avgLatencyMs: number | null;
  slowCount: number;
  stale: ReturnType<typeof getStaleReplies>;
  recent: Array<{
    unitSlug: string;
    leadId: string;
    latencyMs: number;
    slow: boolean;
    ageSec: number;
  }>;
} {
  const now = Date.now();
  const avgLatencyMs = recent.length
    ? Math.round(recent.reduce((sum, r) => sum + r.latencyMs, 0) / recent.length)
    : null;
  return {
    everConfirmed,
    thresholdMin: env.STALE_REPLY_ALERT_MINUTES,
    pendingCount: pendings.size,
    avgLatencyMs,
    slowCount: recent.filter((r) => r.slow).length,
    stale: getStaleReplies(),
    recent: recent
      .slice()
      .reverse()
      .map((r) => ({
        unitSlug: r.unitSlug,
        leadId: r.leadId,
        latencyMs: r.latencyMs,
        slow: r.slow,
        ageSec: Math.round((now - r.at) / 1000),
      })),
  };
}

export function startStaleReplyMonitor(): void {
  if (timer) return;
  timer = setInterval(sweep, SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(
    { thresholdMin: env.STALE_REPLY_ALERT_MINUTES },
    'monitor de resposta parada iniciado',
  );
}
