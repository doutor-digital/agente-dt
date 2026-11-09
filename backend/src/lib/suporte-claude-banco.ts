/** Agente de suporte — o que toca o banco fora das rotas: a entrada automática na fila depois da análise. */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { entraSozinha, lerModoClaude } from './suporte-claude.js';
import type { Verificacao } from './suporte-menu-maquina.js';

/** Depois da análise (ou sem ela): demanda de número verificado pelo grupo entra na fila do agente. Nunca lança. */
export async function enfileirarSeVerificada(protocolo: number): Promise<boolean> {
  try {
    const d = await prisma.suporteDemanda.findUnique({ where: { protocolo }, select: { verificacao: true, claudeStatus: true } });
    if (!d || !entraSozinha(lerModoClaude(), d.verificacao as Verificacao, d.claudeStatus)) return false;
    const r = await prisma.suporteDemanda.updateMany({ where: { protocolo, claudeStatus: null }, data: { claudeStatus: 'fila', claudeAutorizadoPor: 'grupo' } });
    return r.count === 1;
  } catch (err) {
    logger.warn({ protocolo, err: String(err) }, 'suporte-claude: não consegui pôr a demanda na fila');
    return false;
  }
}
