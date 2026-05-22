// ============================================================================
// dedup-cache.ts — cache em memória pra deduplicar webhooks reenviados.
//
// LÓGICA DE ENGENHARIA
// --------------------
// A Meta WhatsApp reenvia o POST se houver flap de rede mesmo após receber
// 200. O Kommo às vezes faz o mesmo. Sem dedup, o agente roda 2x e o lead
// recebe a mesma resposta duplicada.
//
// IMPLEMENTAÇÃO: Map<string, expiresAt>. TTL default 10min — janela típica
// de retry. Cleanup oportunista (a cada `mark`, descartamos entradas
// expiradas — sem timer de fundo).
//
// LIMITAÇÕES
// - Single-process. Se o backend escala horizontalmente, mover pra Redis.
// - Se o processo reinicia, esquece tudo. Aceitável: o pior caso é uma
//   resposta repetida, não corrompe dado.
// ============================================================================

interface Entry {
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutos
const MAX_SIZE = 10_000;       // hard cap pra não vazar memória

const store = new Map<string, Entry>();

/** Limpeza oportunista de entradas expiradas. */
function purgeExpired(now: number): void {
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

/**
 * Tenta reservar o messageId. Retorna `true` se é a 1ª vez (siga em frente),
 * `false` se já vimos esse id nos últimos 10min (descartar — é retry).
 *
 * O `scope` separa namespaces (ex: 'meta', 'kommo') pra não colidir entre
 * canais com ids do mesmo formato.
 */
export function claimMessageId(scope: string, messageId: string): boolean {
  if (!messageId) return true; // sem id, não dá pra deduplicar
  const key = `${scope}:${messageId}`;
  const now = Date.now();

  const existing = store.get(key);
  if (existing && existing.expiresAt > now) {
    return false; // duplicado
  }

  // Purga ocasional pra evitar vazamento — só quando o cache cresceu.
  if (store.size >= MAX_SIZE) purgeExpired(now);

  store.set(key, { expiresAt: now + TTL_MS });
  return true;
}

/** Apenas pra testes/diagnóstico. */
export function _dedupStats(): { size: number } {
  return { size: store.size };
}

/** Limpa o dedup cache inteiro — usado pelo endpoint admin "Limpar cache". */
export function clearDedupCache(): number {
  const n = store.size;
  store.clear();
  return n;
}
