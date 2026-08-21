interface Entry {
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_SIZE = 10_000;

const store = new Map<string, Entry>();

function purgeExpired(now: number): void {
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

export function claimMessageId(scope: string, messageId: string): boolean {
  if (!messageId) return true;
  const key = `${scope}:${messageId}`;
  const now = Date.now();

  const existing = store.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }

  if (store.size >= MAX_SIZE) purgeExpired(now);

  store.set(key, { expiresAt: now + TTL_MS });
  return true;
}

export function _dedupStats(): { size: number } {
  return { size: store.size };
}

export function clearDedupCache(): number {
  const n = store.size;
  store.clear();
  return n;
}
