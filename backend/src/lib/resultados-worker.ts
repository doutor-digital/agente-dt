/**
 * Vigia do livro de resultados: a cada 6 h recalcula, unidade a unidade, as
 * conversas dos últimos 90 dias que ainda não têm desfecho definitivo.
 *
 * Um desfecho muda com o tempo: "agendado_futuro" vira "compareceu" ou "faltou"
 * quando a franquia registra; "em_conversa" vira "nao_agendou" após 7 dias de
 * silêncio. Por isso a varredura é periódica e só para quando `final` = true.
 * O teto de 300 conversas por unidade por varredura protege o Kommo (≈7 req/s).
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { calcularResultados } from '../services/resultados.service.js';

const SWEEP_MS = Number(process.env.RESULTADOS_SWEEP_MS) || 6 * 60 * 60_000;
const ATRASO_INICIAL_MS = Number(process.env.RESULTADOS_DELAY_MS) || 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

export async function varrerResultados(): Promise<void> {
  if (rodando) return;
  rodando = true;
  const t0 = Date.now();
  try {
    const unidades = await prisma.unit.findMany({
      where: { isActive: true, kommoAccessToken: { not: null } },
      orderBy: { slug: 'asc' },
    });
    let total = 0;
    for (const unit of unidades) {
      const r = await calcularResultados(unit, { dias: 90, limite: 300 });
      total += r.calculadas;
      if (r.calculadas || r.erros) logger.info({ unit: unit.slug, ...r }, 'resultados: unidade varrida');
    }
    logger.info({ unidades: unidades.length, calculadas: total, ms: Date.now() - t0 }, 'resultados: varredura concluída');
  } catch (err) {
    logger.warn({ err: String(err) }, 'resultados: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startResultadosWorker(): void {
  if (timer) return;
  setTimeout(() => void varrerResultados(), ATRASO_INICIAL_MS);
  timer = setInterval(() => void varrerResultados(), SWEEP_MS);
  logger.info({ sweepMs: SWEEP_MS }, 'livro de resultados ligado');
}
