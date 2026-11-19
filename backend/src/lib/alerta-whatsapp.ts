import axios from 'axios';
import { logger } from './logger.js';

/**
 * Aviso direto no WhatsApp do João pela Evolution (a mesma instância dos alertas
 * da VPS, `alertas2`). Pedido dele em 05/09/2026: "toda vez que falhar o áudio,
 * mandar o alerta pra mim".
 *
 * Só o número dele (protocolo: nada vai para grupo por aqui). Com trava por chave
 * para não virar metralhadora quando a causa é uma só (sessão do Kommo caiu →
 * toda resposta em áudio falha até alguém logar de novo).
 *
 * Env (no .env do stack): EVOLUTION_ALERT_URL (…/message/sendText/<instância>),
 * EVOLUTION_ALERT_HEADER, EVOLUTION_ALERT_VALUE, ALERTA_WHATSAPP_NUMERO.
 * Sem env configurado, vira só log — nunca derruba o fluxo de quem chamou.
 */

const INTERVALO_PADRAO_MS = Number(process.env.ALERTA_WHATSAPP_INTERVALO_MS) || 30 * 60_000;
const ultimo = new Map<string, number>();

export function configurado(): boolean {
  return Boolean(process.env.EVOLUTION_ALERT_URL && process.env.EVOLUTION_ALERT_HEADER && process.env.EVOLUTION_ALERT_VALUE && process.env.ALERTA_WHATSAPP_NUMERO);
}

/** true = mandou; false = sem config, em janela de silêncio, ou falhou (já logado). */
export async function avisarJoao(texto: string, chave: string, intervaloMs: number = INTERVALO_PADRAO_MS): Promise<boolean> {
  const agora = Date.now();
  const anterior = ultimo.get(chave);
  if (anterior !== undefined && agora - anterior < intervaloMs) return false;
  ultimo.set(chave, agora);

  if (!configurado()) {
    logger.warn({ chave, texto: texto.slice(0, 200) }, 'alerta-whatsapp: sem configuração da Evolution — só log');
    return false;
  }
  const ok = await enviarPelaEvolution({
    url: process.env.EVOLUTION_ALERT_URL as string,
    header: process.env.EVOLUTION_ALERT_HEADER as string,
    valor: process.env.EVOLUTION_ALERT_VALUE as string,
    numero: process.env.ALERTA_WHATSAPP_NUMERO as string,
    texto,
  });
  if (ok) logger.info({ chave }, 'alerta-whatsapp: aviso enviado ao João');
  else logger.warn({ chave }, 'alerta-whatsapp: falha ao enviar (segue sem aviso)');
  return ok;
}

export type ResultadoDoEnvio = 'ok' | 'recusado' | 'incerto';

/**
 * O POST de texto na Evolution (…/message/sendText/<instância>), para número ou grupo (`…@g.us`). Texto cortado em 1500, 15 s de prazo. Nunca lança.
 *  - `ok`: enviou;
 *  - `recusado`: a Evolution RESPONDEU com erro (HTTP 4xx/5xx) — não saiu, dá para tentar de novo;
 *  - `incerto`: sem resposta (estouro dos 15 s, rede) — a mensagem PODE ter saído; quem repetir pode mandar em dobro.
 */
export async function enviarPelaEvolutionComResultado(
  a: { url: string; header: string; valor: string; numero: string; texto: string },
  deps: { post?: typeof axios.post } = {},
): Promise<ResultadoDoEnvio> {
  try {
    await (deps.post ?? axios.post)(
      a.url,
      { number: a.numero, text: a.texto.slice(0, 1500) },
      { headers: { 'Content-Type': 'application/json', [a.header]: a.valor }, timeout: 15_000 },
    );
    return 'ok';
  } catch (err) {
    const status = Number((err as { response?: { status?: unknown } } | null)?.response?.status);
    logger.warn({ err: String(err), status: Number.isFinite(status) ? status : undefined }, 'evolution: falha ao enviar texto');
    return Number.isInteger(status) && status >= 400 && status < 600 ? 'recusado' : 'incerto';
  }
}

/** Como `enviarPelaEvolutionComResultado`, só que true = enviou; false = falhou (recusa ou sem resposta). Também usado pelo aviso do exame de imagem. */
export async function enviarPelaEvolution(a: Parameters<typeof enviarPelaEvolutionComResultado>[0], deps: { post?: typeof axios.post } = {}): Promise<boolean> {
  return (await enviarPelaEvolutionComResultado(a, deps)) === 'ok';
}

/** Só para teste. */
export function esquecerAvisos(): void {
  ultimo.clear();
}
