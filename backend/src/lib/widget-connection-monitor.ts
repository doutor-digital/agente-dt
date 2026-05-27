// ============================================================================
// widget-connection-monitor.ts — "Status da conexão" do modo widget.
//
// POR QUE existe
// --------------
// A client secret do modo widget NÃO é validável contra o Kommo (não há
// endpoint pra "testar o secret"). Ela só prova seu valor quando chega um
// `widget_request` e a assinatura do JWT bate. Então o único teste real de
// conexão é PASSIVO: registrar o ÚLTIMO widget_request recebido por unidade —
// se o JWT validou e se o continue (return_url) deu certo — e mostrar isso no
// painel. O usuário dispara o bot uma vez e vê o status verde/vermelho.
//
// Estado em memória, single-process (igual dedup-cache / stale-reply-monitor).
// Reiniciar esquece — aceitável: é só diagnóstico, não dado de negócio.
// ============================================================================

export type WidgetJwtStatus = 'valid' | 'invalid' | 'no_token' | 'no_secret';

interface WidgetConnection {
  lastAt: number; // Date.now() do último widget_request recebido
  jwt: WidgetJwtStatus; // resultado da verificação do JWT
  leadId: number | null;
  delivered: boolean | null; // continue (POST no return_url) deu certo? null = ainda não concluiu
  error: string | null; // erro do continue, se houve
}

const byUnit = new Map<string, WidgetConnection>();

/** Registra a CHEGADA de um widget_request (chamado no handler, antes do async). */
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

/** Atualiza o resultado da ENTREGA (continue via return_url) do último request. */
export function recordWidgetDelivery(
  unitId: string,
  args: { ok: boolean; error?: string | null },
): void {
  const cur = byUnit.get(unitId);
  if (!cur) return;
  cur.delivered = args.ok;
  cur.error = args.error ?? null;
}

/** Snapshot pro painel. `null` se nunca recebemos um widget_request nesta unidade. */
export function getWidgetConnection(unitId: string): WidgetConnection | null {
  return byUnit.get(unitId) ?? null;
}
