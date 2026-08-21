const nextAllowedAt = new Map<string, number>();

const PRUNE_THRESHOLD = 5_000;
const PRUNE_OLDER_THAN_MS = 60 * 60 * 1000;

function prune(now: number): void {
  if (nextAllowedAt.size <= PRUNE_THRESHOLD) return;
  const cutoff = now - PRUNE_OLDER_THAN_MS;
  for (const [key, ts] of nextAllowedAt) {
    if (ts < cutoff) nextAllowedAt.delete(key);
  }
}

export async function enforceReplyGap(
  unitId: string,
  leadId: number | string,
  gapSec: number,
): Promise<void> {
  if (!gapSec || gapSec <= 0) return;
  const key = `${unitId}:${leadId}`;
  const gapMs = gapSec * 1000;
  const now = Date.now();
  const earliest = Math.max(now, nextAllowedAt.get(key) ?? 0);
  nextAllowedAt.set(key, earliest + gapMs);
  prune(now);
  const waitMs = earliest - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
