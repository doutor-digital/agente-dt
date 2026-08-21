import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { judgeConversation } from '../services/conversation-judge.service.js';

const SWEEP_MS = Number(process.env.JUDGE_SWEEP_MS) || 10 * 60_000;
const MIN_MENSAGENS = Number(process.env.JUDGE_MIN_MSGS) || 4;
const IDLE_HORAS = Number(process.env.JUDGE_IDLE_HOURS) || 6;
const JANELA_DIAS = Number(process.env.JUDGE_WINDOW_DAYS) || 30;
const TETO_POR_VARREDURA = Number(process.env.JUDGE_BATCH) || 15;
const HABILITADO = (process.env.JUDGE_WORKER_ENABLED ?? '1') !== '0';

let timer: ReturnType<typeof setInterval> | null = null;
let rodando = false;

async function candidatas(limite: number): Promise<Array<{ id: string; unitId: string }>> {
  const idleAntes = new Date(Date.now() - IDLE_HORAS * 3_600_000);
  const desde = new Date(Date.now() - JANELA_DIAS * 86_400_000);

  return prisma.$queryRaw<Array<{ id: string; unitId: string }>>`
    SELECT c.id, c.unit_id AS "unitId"
    FROM conversations c
    WHERE c.last_message_at < ${idleAntes}
      AND c.last_message_at >= ${desde}
      AND NOT EXISTS (
        SELECT 1 FROM conversation_evaluations e WHERE e.conversation_id = c.id
      )
      AND (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) >= ${MIN_MENSAGENS}
    ORDER BY c.last_message_at DESC
    LIMIT ${limite}
  `;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const elegiveis = await candidatas(TETO_POR_VARREDURA);
    if (elegiveis.length === 0) return;

    const unidades = new Map<string, Awaited<ReturnType<typeof prisma.unit.findUnique>>>();
    let avaliadas = 0;

    for (const conv of elegiveis) {
      try {
        if (!unidades.has(conv.unitId)) {
          unidades.set(conv.unitId, await prisma.unit.findUnique({ where: { id: conv.unitId } }));
        }
        const unit = unidades.get(conv.unitId);
        if (!unit) continue;

        const r = await judgeConversation({ conversationId: conv.id, unit });
        if (r) avaliadas++;
      } catch (err) {
        logger.warn({ err, conversationId: conv.id }, 'judge-worker: falhou nesta conversa');
      }
    }

    logger.info({ avaliadas, candidatas: elegiveis.length }, 'judge-worker: varredura concluída');
  } catch (err) {
    logger.error({ err }, 'judge-worker: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startJudgeWorker(): void {
  if (timer) return;
  if (!HABILITADO) {
    logger.info('judge-worker: desligado por env (JUDGE_WORKER_ENABLED=0)');
    return;
  }
  timer = setInterval(() => void varrer(), SWEEP_MS);
  setTimeout(() => void varrer(), 45_000).unref?.();
  logger.info(
    { sweepMs: SWEEP_MS, minMensagens: MIN_MENSAGENS, idleHoras: IDLE_HORAS, teto: TETO_POR_VARREDURA },
    'judge-worker: iniciado (avalia conversas encerradas pra alimentar a média por versão de prompt)',
  );
}

export function stopJudgeWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export const _varrerAgora = varrer;
