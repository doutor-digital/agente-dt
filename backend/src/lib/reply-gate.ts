// ============================================================================
// reply-gate.ts — Trava anti-loop por lead.
//
// O algoritmo anti-loop do Kommo TRAVA o gatilho do Salesbot quando duas
// respostas saem muito próximas no MESMO lead (ativação duplicada do gatilho).
// Aqui garantimos um intervalo MÍNIMO entre dois envios pro mesmo lead: se uma
// 2ª resposta tentar sair antes do intervalo, ela espera o tempo restante.
//
// Estado em memória (Map por processo). Como o coalescer já serializa o agente
// por lead, reservar o "próximo horário permitido" de forma incremental é
// suficiente e ainda serializa chamadas concorrentes pro mesmo lead.
// ============================================================================

// key = `${unitId}:${leadId}` → timestamp (ms) em que o PRÓXIMO envio é
// permitido. Reservamos o slot ANTES de dormir pra serializar concorrência.
const nextAllowedAt = new Map<string, number>();

// Limpa entradas velhas pra não crescer infinito. Roda quando o Map passa do
// teto — barato e suficiente (não precisamos de timer dedicado).
const PRUNE_THRESHOLD = 5_000;
const PRUNE_OLDER_THAN_MS = 60 * 60 * 1000; // 1h

function prune(now: number): void {
  if (nextAllowedAt.size <= PRUNE_THRESHOLD) return;
  const cutoff = now - PRUNE_OLDER_THAN_MS;
  for (const [key, ts] of nextAllowedAt) {
    if (ts < cutoff) nextAllowedAt.delete(key);
  }
}

/**
 * Garante um intervalo mínimo de `gapSec` segundos entre dois envios pro mesmo
 * lead. Bloqueia (await) o tempo restante quando necessário. `gapSec <= 0`
 * desliga a trava (no-op).
 */
export async function enforceReplyGap(
  unitId: string,
  leadId: number | string,
  gapSec: number,
): Promise<void> {
  if (!gapSec || gapSec <= 0) return;
  const key = `${unitId}:${leadId}`;
  const gapMs = gapSec * 1000;
  const now = Date.now();
  // O slot mais cedo possível: agora, ou o horário reservado por um envio
  // anterior (o que for maior).
  const earliest = Math.max(now, nextAllowedAt.get(key) ?? 0);
  // Reserva o próximo slot ANTES de dormir → chamadas concorrentes pro mesmo
  // lead se enfileiram (cada uma empurra o horário do próximo).
  nextAllowedAt.set(key, earliest + gapMs);
  prune(now);
  const waitMs = earliest - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
