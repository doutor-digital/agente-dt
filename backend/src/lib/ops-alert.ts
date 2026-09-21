import { logger } from './logger.js';

const RELAY_URL = process.env.ALERT_RELAY_URL || 'http://relay:8080';
const JANELA_MS = 30 * 60_000;
const ultimoEnvio = new Map<string, number>();

/**
 * Devolve se o relay ACEITOU o aviso (false = repetido dentro da janela, relay recusou ou caiu).
 * Nunca lança: quem chama pode ignorar o retorno — quem precisa saber se entregou (ex.: o teto
 * mensal, que só marca "já avisei" depois da entrega) espera por ele.
 */
export async function opsAlert(args: {
  chave: string;
  title: string;
  message: string;
}): Promise<boolean> {
  const agora = Date.now();
  const anterior = ultimoEnvio.get(args.chave);
  if (anterior && agora - anterior < JANELA_MS) return false;
  ultimoEnvio.set(args.chave, agora);

  try {
    const resp = await fetch(`${RELAY_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: args.title, message: args.message, ok: false }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, chave: args.chave }, 'ops-alert: relay recusou');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err: String(err), chave: args.chave }, 'ops-alert: falha ao enviar');
    return false;
  }
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
