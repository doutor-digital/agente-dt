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
async function candidatas(limite: number): Promise<Array<{ id: string; unitId: string }>> {
  const idleAntes = new Date(Date.now() - IDLE_HORAS * 3_600_000);
  const desde = new Date(Date.now() - JANELA_DIAS * 86_400_000);

  // SQL cru de propósito: o filtro "tem pelo menos N mensagens" precisa acontecer
  // ANTES do LIMIT. Filtrando em JS depois de um `take`, a página inteira podia
  // cair no filtro e a varredura voltava vazia — que foi exatamente o que
  // aconteceu na primeira versão.
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

    // Cache de unit por id — várias conversas da mesma unidade por varredura.
    const unidades = new Map<string, Awaited<ReturnType<typeof prisma.unit.findUnique>>>();
    let avaliadas = 0;

    for (const conv of elegiveis) {
      try {
        if (!unidades.has(conv.unitId)) {
          unidades.set(conv.unitId, await prisma.unit.findUnique({ where: { id: conv.unitId } }));
        }
        const unit = unidades.get(conv.unitId);
        // NÃO exigir chave própria da unidade: a maioria roda Claude e o juiz
        // resolve a chave com fallback pra OPENAI_API_KEY do ambiente
        // (resolveOpenAIApiKey). Exigir aqui pulava 18 das 22 unidades.
        if (!unit) continue;

        const r = await judgeConversation({ conversationId: conv.id, unit });
        if (r) avaliadas++;
      } catch (err) {
        // Uma conversa problemática não pode parar a varredura.
        logger.warn({ err, conversationId: conv.id }, 'judge-worker: falhou nesta conversa');
      }
    }

    // Loga SEMPRE que houve candidata: silêncio total deixa impossível saber se
    // a varredura rodou e não achou nada, ou se nem rodou.
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
  // Uma varredura logo no boot (com folga pra o processo subir). Sem isto, um
  // dia de deploys mais frequentes que o intervalo faz o worker NUNCA varrer —
  // cada restart zera o setInterval. Foi exatamente o que aconteceu no piloto.
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

/** Exposto pra disparo manual (endpoint/patch) sem esperar o intervalo. */
export const _varrerAgora = varrer;
