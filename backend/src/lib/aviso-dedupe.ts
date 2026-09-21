/**
 * Dedupe PERSISTENTE de avisos por lead (decisão do João, 21/09/2026: uma tarefa por tipo por lead).
 *
 * O dedupe em memória (`devoAvisar`, 10 min) zera a cada deploy e não separa dias: em Araguaína um
 * lead acumulou 18 tarefas iguais em 3 semanas. Aqui a marca vive na tabela `card_alert`
 * (unit_id, lead_id, rule_key), que já existe e tem chave única — sem migration.
 *
 * Uso: `if (await avisoRecente(...)) return;` ANTES de criar a tarefa e `await marcarAviso(...)` SÓ
 * depois que a Kommo confirmou a criação — assim uma falha de rede não cala o aviso por 24 h
 * (apontado pelo review do Codex em 21/09). Falha de banco nunca bloqueia o aviso.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export const JANELA_24H_MS = 24 * 60 * 60 * 1000;

/** Já houve aviso desse tipo pra esse lead dentro da janela? (só leitura) */
export async function avisoRecente(
  unitId: string,
  leadId: number | string,
  ruleKey: string,
  janelaMs: number = JANELA_24H_MS,
  agora: Date = new Date(),
): Promise<boolean> {
  try {
    const atual = await prisma.cardAlert.findUnique({
      where: { unitId_leadId_ruleKey: { unitId, leadId: String(leadId), ruleKey } },
      select: { createdAt: true },
    });
    return !!atual && agora.getTime() - atual.createdAt.getTime() < janelaMs;
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId: String(leadId), ruleKey }, 'aviso-dedupe: falha ao ler — aviso segue');
    return false;
  }
}

/** Registra que o aviso foi criado agora (chamar só depois do sucesso na Kommo). */
export async function marcarAviso(
  unitId: string,
  leadId: number | string,
  ruleKey: string,
  agora: Date = new Date(),
): Promise<void> {
  try {
    await prisma.cardAlert.upsert({
      where: { unitId_leadId_ruleKey: { unitId, leadId: String(leadId), ruleKey } },
      create: { unitId, leadId: String(leadId), ruleKey, createdAt: agora },
      update: { createdAt: agora },
    });
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId: String(leadId), ruleKey }, 'aviso-dedupe: falha ao marcar');
  }
}
