export type WidgetJwtStatus = 'valid' | 'invalid' | 'no_token' | 'no_secret';

interface WidgetConnection {
  lastAt: number;
  jwt: WidgetJwtStatus;
  leadId: number | null;
  delivered: boolean | null;
  error: string | null;
}

const byUnit = new Map<string, WidgetConnection>();

export function recordWidgetRequest(
  unitId: string,
  args: { jwt: WidgetJwtStatus; leadId: number | null },
): void {
  byUnit.set(unitId, {
    lastAt: Date.now(),
    jwt: args.jwt,
    leadId: args.leadId,
    delivered: null,
    error: null,
  });
}

export function recordWidgetDelivery(
  unitId: string,
  args: { ok: boolean; error?: string | null },
): void {
  const cur = byUnit.get(unitId);
  if (!cur) return;
  cur.delivered = args.ok;
  cur.error = args.error ?? null;
}

export function getWidgetConnection(unitId: string): WidgetConnection | null {
  return byUnit.get(unitId) ?? null;
}
