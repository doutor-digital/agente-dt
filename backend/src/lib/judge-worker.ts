import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { julgarConversa } from '../services/conversation-judge.service.js';
import { Descartes, DESCARTE_ERRO_MS, DESCARTE_NAO_AVALIAVEL_MS } from './juiz-da-ia.js';

const SWEEP_MS = Number(process.env.JUDGE_SWEEP_MS) || 10 * 60_000;
const MIN_MENSAGENS = Number(process.env.JUDGE_MIN_MSGS) || 4;
const IDLE_HORAS = Number(process.env.JUDGE_IDLE_HOURS) || 6;
const JANELA_DIAS = Number(process.env.JUDGE_WINDOW_DAYS) || 30;
const TETO_POR_VARREDURA = Number(process.env.JUDGE_BATCH) || 15;
const HABILITADO = (process.env.JUDGE_WORKER_ENABLED ?? '1') !== '0';

let timer: ReturnType<typeof setInterval> | null = null;
let rodando = false;

/**
 * Conversas recusadas pelo pré-filtro e conversas em que o juiz novo falhou. Nada disso vira linha no banco
 * (qualquer linha entra na média do painel, do relatório de sábado e do resumo diário), então a lembrança é do
 * processo — ver `Descartes`. Com as chaves do juiz novo DESLIGADAS (padrão) nada é lembrado: a varredura é a de
 * antes, que tenta de novo a cada rodada.
 */
const descartes = new Descartes();
const juizNovoLigado = (): boolean => process.env.JUDGE_SO_AVALIAVEIS === '1' || process.env.JUDGE_PROVIDER?.trim().toLowerCase() === 'anthropic';

async function candidatas(limite: number): Promise<Array<{ id: string; unitId: string }>> {
  const idleAntes = new Date(Date.now() - IDLE_HORAS * 3_600_000);
  const desde = new Date(Date.now() - JANELA_DIAS * 86_400_000);
  // O sentinela '' (nunca é id: são cuid) evita depender de como o driver tipa um array vazio.
  const vigentes = descartes.vigentes(Date.now());
  const fora = vigentes.length ? vigentes : [''];

  return prisma.$queryRaw<Array<{ id: string; unitId: string }>>`
    SELECT c.id, c.unit_id AS "unitId"
    FROM conversations c
    WHERE c.last_message_at < ${idleAntes}
      AND c.last_message_at >= ${desde}
      AND NOT EXISTS (
        SELECT 1 FROM conversation_evaluations e WHERE e.conversation_id = c.id
      )
      AND (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) >= ${MIN_MENSAGENS}
      AND c.id <> ALL(${fora}::text[])
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
    let naoAvaliaveis = 0;
    let erros = 0;

    for (const conv of elegiveis) {
      try {
        if (!unidades.has(conv.unitId)) {
          unidades.set(conv.unitId, await prisma.unit.findUnique({ where: { id: conv.unitId } }));
        }
        const unit = unidades.get(conv.unitId);
        if (!unit) continue;

        const r = await julgarConversa({ conversationId: conv.id, unit });
        if (r.status === 'avaliada') avaliadas++;
        else if (r.status === 'nao_avaliavel') {
          naoAvaliaveis++;
          descartes.lembrar(conv.id, Date.now() + DESCARTE_NAO_AVALIAVEL_MS);
        } else if (r.status === 'erro') {
          erros++;
          // 1 h de espera em vez de 10 min, senão 15 conversas que sempre falham ocupam toda varredura.
          // Queda do provedor (5xx, 429, sem saldo, chave) é de todas as conversas ao mesmo tempo: espera 1 h mas NÃO
          // gasta tentativa — senão 3 h de Anthropic fora do ar mandariam tudo para a desistência de 7 dias.
          if (juizNovoLigado() && r.motivo === 'falha_na_chamada') {
            descartes.lembrar(conv.id, Date.now() + DESCARTE_ERRO_MS);
          } else if (juizNovoLigado() && r.motivo === 'resposta_invalida') {
            const f = descartes.falhou(conv.id);
            if (f.esgotada) {
              logger.warn(
                { conversationId: conv.id, tentativas: f.tentativas },
                'judge-worker: o juiz falhou de novo nesta conversa — desistindo dela por 7 dias (ou até o próximo deploy)',
              );
            }
          }
        }
      } catch (err) {
        logger.warn({ err, conversationId: conv.id }, 'judge-worker: falhou nesta conversa');
      }
    }

    logger.info({ avaliadas, naoAvaliaveis, erros, candidatas: elegiveis.length }, 'judge-worker: varredura concluída');
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
