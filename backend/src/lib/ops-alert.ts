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

/**
 * O provedor recusou porque a CONTA está sem crédito (e não por limite de uso por minuto nem por erro nosso).
 *
 * As duas frases reais de 26/11/2026, que deixaram a Sofia 15 h fora sem ninguém saber:
 *  - Anthropic: `400 … "Your credit balance is too low to access the Anthropic API…"`
 *  - OpenAI:    `429 You have no credits remaining. Add credits to continue using the API at …`
 * O 429 da OpenAI por saldo vem com o MESMO código do 429 de rate limit, então o que decide é o texto.
 */
export function ehErroDeSaldo(msg: string): boolean {
  const m = String(msg ?? '').toLowerCase();
  return (
    m.includes('credit balance is too low') ||
    m.includes('no credits remaining') ||
    m.includes('insufficient_quota') ||
    m.includes('insufficient quota') ||
    m.includes('insufficient credits') ||
    m.includes('out of credits') ||
    (m.includes('billing') && m.includes('quota')) ||
    (m.includes('exceeded') && m.includes('quota')) ||
    m.includes('payment required')
  );
}
