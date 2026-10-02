/**
 * Tira as pausas de lead que venceram (widget "Pausar a Sofia", 02/10/2026).
 *
 * A Sofia não depende deste worker para voltar: `leadPausadoPorJanela` já compara `ate` com a hora
 * na hora de responder. O worker existe por causa da caixinha "Pausar IA" do cartão, que os Salesbots
 * e a régua leem — ela só é desmarcada aqui, e só se foi o widget que a marcou.
 */
import { logger } from './logger.js';
import { liberarPausasVencidas } from './pausa-lead.js';

const SWEEP_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const n = await liberarPausasVencidas();
    if (n > 0) logger.info({ liberadas: n }, 'pausa de lead: vencidas liberadas');
  } catch (err) {
    logger.warn({ err: String(err) }, 'pausa de lead: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startLeadPausaWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  void varrer();
  logger.info('pausa de lead: worker iniciado');
}

export function stopLeadPausaWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
