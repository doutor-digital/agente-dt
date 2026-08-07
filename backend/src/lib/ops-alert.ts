// ============================================================================
// ops-alert.ts — alerta operacional por e-mail, via o relay que já existe.
//
// POR QUE EXISTE
// --------------
// Numa madrugada o saldo da Anthropic zerou e 10 conversas falharam sem
// resposta nenhuma — e ninguém soube até de manhã, porque o único "alerta"
// era um erro no painel que precisa de alguém olhando. Um saldo zerado mata
// TODA conversa até alguém recarregar; merece um e-mail, não uma linha de log.
//
// CANAL
// -----
// Reaproveita o `dd-alert-relay` (serviço já no ar, alias `relay:8080` na
// overlay): POST /notify {title, message, ok} → e-mail formatado pra
// doutordigitalconsultoria@gmail.com. Sem nova infra, sem nova credencial.
//
// THROTTLE
// --------
// A falha de saldo vem em rajada — cada lead que chega tenta a LLM e falha.
// Sem trava, seriam dezenas de e-mails idênticos em minutos. `ultimoEnvio` por
// chave garante NO MÁXIMO um e-mail por tipo a cada `JANELA_MS`.
// ============================================================================

import { logger } from './logger.js';

const RELAY_URL = process.env.ALERT_RELAY_URL || 'http://relay:8080';
const JANELA_MS = 30 * 60_000; // no máx. 1 e-mail por chave a cada 30 min
const ultimoEnvio = new Map<string, number>();

/**
 * Manda um alerta por e-mail, no máximo 1 por `chave` a cada 30 min.
 * Fire-and-forget: nunca lança — alertar não pode derrubar o fluxo que alertou.
 */
export function opsAlert(args: {
  /** Agrupa o throttle. Mesma chave = mesmo alarme, não reenvia na janela. */
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
      // Relay fora não pode virar erro do chamador. Log e segue.
      logger.warn({ err: String(err), chave: args.chave }, 'ops-alert: falha ao enviar');
    }
  })();
}

/**
 * Reconhece a falha de "sem saldo / cota" das APIs de LLM. Assinaturas medidas
 * em produção (Anthropic: "credit balance is too low") mais as equivalentes da
 * OpenAI. Genérico o bastante pra pegar variações sem virar falso-positivo com
 * erro comum de rede.
 */
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
