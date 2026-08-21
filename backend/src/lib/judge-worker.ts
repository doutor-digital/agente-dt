// ============================================================================
// judge-worker.ts — faz o LLM-as-judge REALMENTE rodar.
//
// O juiz (conversation-judge.service) e o painel de performance por versão de
// prompt (prompts.controller + PromptsPanel) já existiam, mas a tabela estava
// VAZIA: o único gatilho automático era "conversão detectada" no webhook do
// Kommo — e o webhook do agente só assina `add_message`, nunca recebe mudança
// de etapa. Resultado: 0 avaliações em 1.798 conversas, painel em branco.
//
// Este worker tira o juiz da dependência do webhook: varre conversas que já
// ESFRIARAM (sem mensagem nova há N horas = turno encerrado), com material
// suficiente, e avalia as que ainda não têm avaliação.
//
// Com dados, a média por promptHash fica estatisticamente útil: nota individual
// do juiz oscila ±10-20%, mas a média sobre dezenas de conversas estabiliza —
// é isso que permite comparar duas versões de prompt com segurança.
//
// Guardas (o juiz custa dinheiro, mesmo barato):
//   - só conversas com >= MIN_MENSAGENS (conversa de 1 turno não diz nada)
//   - só as que esfriaram há >= IDLE_HORAS (evita avaliar conversa em curso)
//   - só as dos últimos JANELA_DIAS (não re-processa arqueologia)
//   - teto por varredura (o backlog drena aos poucos, sem pico de custo)
//   - idempotente: judgeConversation já pula quem tem avaliação
// ============================================================================

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { judgeConversation } from '../services/conversation-judge.service.js';

const SWEEP_MS = Number(process.env.JUDGE_SWEEP_MS) || 10 * 60_000; // 10 min
const MIN_MENSAGENS = Number(process.env.JUDGE_MIN_MSGS) || 4;
const IDLE_HORAS = Number(process.env.JUDGE_IDLE_HOURS) || 6;
const JANELA_DIAS = Number(process.env.JUDGE_WINDOW_DAYS) || 30;
const TETO_POR_VARREDURA = Number(process.env.JUDGE_BATCH) || 15;
/** `0` desliga o worker sem precisar de deploy. */
const HABILITADO = (process.env.JUDGE_WORKER_ENABLED ?? '1') !== '0';

let timer: ReturnType<typeof setInterval> | null = null;
let rodando = false;

/**
 * Conversas prontas pra avaliar: esfriaram, têm material e ainda não foram
 * julgadas. Ordena das mais recentes pras mais antigas — o dono se importa
 * mais com o retrato de agora do que com o histórico.
 */
async function candidatas(limite: number) {
  const agora = Date.now();
  const idleAntes = new Date(agora - IDLE_HORAS * 3_600_000);
  const desde = new Date(agora - JANELA_DIAS * 86_400_000);

  return prisma.conversation.findMany({
    where: {
      lastMessageAt: { lt: idleAntes, gte: desde },
      evaluations: { none: {} },
      messages: { some: {} },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: limite * 3, // folga: parte cai no filtro de tamanho abaixo
    select: {
      id: true,
      unitId: true,
      _count: { select: { messages: true } },
    },
  });
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const pool = await candidatas(TETO_POR_VARREDURA);
    const elegiveis = pool.filter((c) => c._count.messages >= MIN_MENSAGENS).slice(0, TETO_POR_VARREDURA);
    if (elegiveis.length === 0) return;

    // Cache de unit por id — várias conversas da mesma unidade por varredura.
    const unidades = new Map<string, Awaited<ReturnType<typeof prisma.unit.findUnique>>>();
    let avaliadas = 0;

    for (const conv of elegiveis) {
      try {
        if (!unidades.has(conv.unitId)) {
          unidades.set(conv.unitId, await prisma.unit.findUnique({ where: { id: conv.unitId } }));
        }
        const unit = unidades.get(conv.unitId);
        // Sem chave de OpenAI o juiz não roda — pula sem ruído.
        if (!unit || !unit.openaiApiKey) continue;

        const r = await judgeConversation({ conversationId: conv.id, unit });
        if (r) avaliadas++;
      } catch (err) {
        // Uma conversa problemática não pode parar a varredura.
        logger.warn({ err, conversationId: conv.id }, 'judge-worker: falhou nesta conversa');
      }
    }

    if (avaliadas > 0) {
      logger.info({ avaliadas, candidatas: elegiveis.length }, 'judge-worker: conversas avaliadas');
    }
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
  logger.info(
    { sweepMs: SWEEP_MS, minMensagens: MIN_MENSAGENS, idleHoras: IDLE_HORAS, teto: TETO_POR_VARREDURA },
    'judge-worker: iniciado (avalia conversas encerradas pra alimentar a média por versão de prompt)',
  );
}

export function stopJudgeWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposto pra disparo manual (endpoint/patch) sem esperar o intervalo. */
export const _varrerAgora = varrer;
