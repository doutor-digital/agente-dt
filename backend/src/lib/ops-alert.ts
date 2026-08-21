import { logger } from './logger.js';

const RELAY_URL = process.env.ALERT_RELAY_URL || 'http://relay:8080';
const JANELA_MS = 30 * 60_000;
const ultimoEnvio = new Map<string, number>();

export function opsAlert(args: {
  chave: string;
  title: string;
  message: string;
}): void {
  const agora = Date.now();
  const anterior = ultimoEnvio.get(args.chave);
  if (anterior && agora - anterior < JANELA_MS) return;
  ultimoEnvio.set(args.chave, agora);

  void (async () => {
    try {
      const resp = await fetch(`${RELAY_URL}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: args.title, message: args.message, ok: false }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        logger.warn({ status: resp.status, chave: args.chave }, 'ops-alert: relay recusou');
      }
    } catch (err) {
      logger.warn({ err: String(err), chave: args.chave }, 'ops-alert: falha ao enviar');
    }
  })();
}

export function ehErroDeSaldo(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('credit balance is too low') ||
    m.includes('insufficient_quota') ||
    m.includes('insufficient quota') ||
    m.includes('billing') && m.includes('quota') ||
    (m.includes('exceeded') && m.includes('quota')) ||
    m.includes('payment required')
  );
}
