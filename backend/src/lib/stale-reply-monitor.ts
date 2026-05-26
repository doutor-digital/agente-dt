// ============================================================================
// stale-reply-monitor.ts — Monitor de "resposta parada".
//
// PROBLEMA
// --------
// O backend gera a resposta da IA e a GRAVA no campo "Resposta IA" do lead
// (PATCH). Quem ENTREGA a mensagem ao WhatsApp é o Salesbot do Kommo, disparado
// pelo gatilho "campo mudou" do Digital Pipeline. Esse disparo roda numa fila
// nos servidores do Kommo e, quando a fila engasga, a entrega atrasa minutos
// (já vimos 36 min). O trabalho do nosso backend termina no PATCH, então sem um
// monitor a gente só descobre que travou quando o lead reclama.
//
// COMO DETECTAMOS A ENTREGA
// -------------------------
// O Kommo manda um webhook de mensagem `outgoing` quando o Salesbot ENTREGA a
// resposta. O webhook.controller chama confirmDelivery() pra cada outgoing e a
// gente fecha o ciclo: PATCH (track) → outgoing (confirm) → mede a demora.
//
// PRÉ-REQUISITO / SALVAGUARDA
// ---------------------------
// Isso depende do Kommo enviar webhooks de mensagem OUTGOING ao backend. Se a
// assinatura de webhook NÃO incluir outgoing, nenhuma confirmação chega e TODA
// resposta pareceria "parada" — o que floodaria alerta falso. Por isso só
// emitimos alerta de "parada" DEPOIS de ter visto ao menos UMA confirmação
// (everConfirmed). Enquanto nunca confirmamos, em vez de spammar, avisamos UMA
// vez que o webhook de outgoing parece não estar chegando.
//
// ESTADO EM MEMÓRIA
// -----------------
// Single-process (igual dedup-cache e os schedulers). Reiniciar esquece os
// pendentes — aceitável: o pior caso é um alerta a menos numa janela de boot,
// não dado corrompido. Se um dia escalar horizontal, migrar pra Redis/tabela.
// ============================================================================

import { env } from './env.js';
import { logger } from './logger.js';

interface PendingReply {
  unitId: string;
  unitSlug: string;
  unitName: string;
  leadId: string;
  text: string; // resposta original (pré-downgrade de emoji)
  patchedAt: number; // Date.now() de quando terminamos de gravar no Kommo
  alerted: boolean; // já logamos o alerta de "parada" pra este pendente?
}

const STALE_MS = env.STALE_REPLY_ALERT_MINUTES * 60_000;
const SWEEP_MS = 30_000; // varredura a cada 30s
const MAX_AGE_MS = 2 * 60 * 60_000; // desiste após 2h (evita vazar memória)
const MIN_SAMPLES_BEFORE_BLAMING_WEBHOOK = 3;

// Histórico curto das últimas entregas confirmadas — alimenta o painel de
// "Saúde da Entrega" no front (latências PATCH → entrega). Ring buffer em
// memória: só as N mais recentes, igual ao resto do estado deste monitor.
interface DeliverySample {
  unitSlug: string;
  leadId: string;
  latencyMs: number;
  slow: boolean; // passou do limiar de "parada"?
  at: number; // Date.now() da confirmação
}
const RECENT_MAX = 30;
const recent: DeliverySample[] = [];

const pendings = new Map<string, PendingReply>();
let everConfirmed = false; // já vimos ALGUMA confirmação de entrega?
let pendingsSeen = 0; // total de respostas rastreadas desde o boot
let warnedNoConfirmations = false; // já avisamos que confirmação não chega?
let timer: NodeJS.Timeout | null = null;

function key(unitId: string, leadId: string): string {
  return `${unitId}:${leadId}`;
}

// Normaliza pra comparar a resposta que gravamos contra o texto da mensagem
// outgoing: tira emojis (o que sai já passou por downgrade BMP), colapsa espaço
// e baixa caixa. Assim "Oi! 🌙 Como vai?" e "oi como vai" batem.
function normalize(s: string): string {
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}←-⇿⌀-⏿]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Registra que acabamos de gravar uma resposta no campo "Resposta IA" e estamos
 * esperando o Salesbot do Kommo entregá-la. Chamado APÓS o envio bem-sucedido
 * pela rota 'salesbot'. Uma resposta nova pro mesmo lead sobrescreve a anterior
 * (só monitoramos a última).
 */
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

/**
 * Fecha o ciclo: chamado quando chega um webhook de mensagem OUTGOING (o
 * Salesbot entregou). Confere por correspondência de texto pra não confundir
 * com uma mensagem que o operador mandou na mão.
 */
export function confirmDelivery(args: {
  unitId: string;
  leadId: string | number;
  text?: string | null;
}): void {
  const k = key(args.unitId, String(args.leadId));
  const p = pendings.get(k);
  if (!p) return;

  // Correspondência: o Salesbot manda o valor do campo (a resposta, possivelmente
  // quebrada em chunks → substring). Se a outgoing não trouxer texto, confirmamos
  // pelo tempo (qualquer outgoing pro lead depois do PATCH).
  const out = args.text ? normalize(args.text) : '';
  const exp = normalize(p.text);
  const matches = out === '' || exp.includes(out) || out.includes(exp);
  if (!matches) return; // outgoing não corresponde — provável msg manual do operador

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
}

// Varredura periódica: alerta pendentes que passaram do limite.
function sweep(): void {
  const now = Date.now();
  let staleCount = 0;

  for (const [k, p] of pendings) {
    const age = now - p.patchedAt;
    if (age > MAX_AGE_MS) {
      pendings.delete(k); // desiste — provavelmente entregue e perdemos o webhook
      continue;
    }
    if (age <= STALE_MS) continue;
    staleCount++;
    if (p.alerted) continue;

    // Só alertamos quando o sinal de confirmação é confiável (já vimos pelo
    // menos uma entrega chegar). logger.error grava em system_logs e aparece
    // no painel de logs.
    if (everConfirmed) {
      p.alerted = true;
      logger.error(
        { unit: p.unitSlug, unitId: p.unitId, leadId: p.leadId, ageSec: Math.round(age / 1000) },
        `🐢 Resposta da IA parada há ${Math.round(age / 60000)}min sem ser entregue (lead ${p.leadId}) — Salesbot do Kommo provavelmente engasgado. Empurre com /Agente DT na conversa.`,
      );
    }
  }

  // Salvaguarda: pendentes acumulando e NENHUMA confirmação jamais vista →
  // provável que o webhook de OUTGOING não esteja chegando. Avisa UMA vez.
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

/**
 * Pendentes atualmente acima do limite, pro endpoint /api/alerts (badge).
 * Retorna [] enquanto não tivermos um sinal de confirmação confiável, pra não
 * poluir o badge com falso-positivos.
 */
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

/**
 * Snapshot completo do monitor pro painel "Saúde da Entrega" no front:
 * pendentes, parados agora e o histórico recente de latências confirmadas.
 */
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
    // Mais recente primeiro.
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
  if (typeof timer.unref === 'function') timer.unref(); // não segura o processo no shutdown
  logger.info(
    { thresholdMin: env.STALE_REPLY_ALERT_MINUTES },
    'monitor de resposta parada iniciado',
  );
}
