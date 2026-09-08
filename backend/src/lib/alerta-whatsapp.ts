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
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    headers[process.env.EVOLUTION_ALERT_HEADER as string] = process.env.EVOLUTION_ALERT_VALUE as string;
    await axios.post(
      process.env.EVOLUTION_ALERT_URL as string,
      { number: process.env.ALERTA_WHATSAPP_NUMERO, text: texto.slice(0, 1500) },
      { headers, timeout: 15_000 },
    );
    logger.info({ chave }, 'alerta-whatsapp: aviso enviado ao João');
    return true;
  } catch (err) {
    logger.warn({ err: String(err), chave }, 'alerta-whatsapp: falha ao enviar (segue sem aviso)');
    return false;
  }
}

/** Só para teste. */
export function esquecerAvisos(): void {
  ultimo.clear();
}
