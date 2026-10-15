/**
 * Placar das campanhas de disparo, todo dia às 17h (de segunda a sábado).
 *
 * As 17h dão tempo de a recepção responder quem respondeu o envio das 9h, e o placar chega antes do fim
 * do expediente. A campanha continua sendo medida 10 dias depois do fim da oferta: avaliação marcada no
 * dia 31 acontece em novembro, e o "compareceu" só aparece depois.
 */
import { logger } from './logger.js';
import { CAMPANHAS } from './campanha/campanhas.js';
import { coletarEGravar, diaLocal } from './campanha/coleta.js';

const PASSO_MS = 10 * 60_000;
const HORA_PADRAO = 17;
const DIAS_DEPOIS_DO_FIM = 10;

let timer: NodeJS.Timeout | null = null;
let rodando = false;
/** Dia em que a coleta das 17h já rodou. Em memória: um deploy às 17h pode repetir, e a gravação sobrescreve. */
let ultimoDia: string | null = null;

function horaDoPlacar(): number {
  const n = Number(process.env.CAMPANHA_PLACAR_HORA);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : HORA_PADRAO;
}

function agoraEmSaoPaulo(): { hora: number; domingo: boolean } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date());
  return { hora: Number(p.find((x) => x.type === 'hour')?.value), domingo: p.find((x) => x.type === 'weekday')?.value === 'Sun' };
}

export function campanhasAtivas(hoje: string): typeof CAMPANHAS {
  return CAMPANHAS.filter((c) => {
    const fim = new Date(new Date(`${c.fim}T12:00:00Z`).getTime() + DIAS_DEPOIS_DO_FIM * 86_400_000).toISOString().slice(0, 10);
    return hoje >= c.inicio && hoje <= fim;
  });
}

async function talvezColetar(): Promise<void> {
  if (rodando) return;
  const { hora, domingo } = agoraEmSaoPaulo();
  const hoje = diaLocal(new Date());
  if (domingo || hora !== horaDoPlacar() || ultimoDia === hoje) return;
  rodando = true;
  ultimoDia = hoje;
  try {
    for (const c of campanhasAtivas(hoje)) await coletarEGravar(c);
  } catch (err) {
    logger.error({ err }, 'placar de campanha: coleta das 17h falhou');
  } finally {
    rodando = false;
  }
}

export function startCampanhaWorker(): void {
  if (timer) return;
  timer = setInterval(() => void talvezColetar(), PASSO_MS);
  logger.info({ hora: horaDoPlacar() }, 'placar de campanha: worker ligado');
}

export function stopCampanhaWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
