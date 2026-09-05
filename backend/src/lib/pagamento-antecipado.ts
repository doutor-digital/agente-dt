import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { pagouOAntecipado } from './follow-up-worker.js';
import type { KommoClient } from '../services/kommo.service.js';

/**
 * Prova de que o paciente pagou a taxa antecipada — para unidades em que a vaga
 * só pode ser reservada depois do pagamento (`spineBookingRequiresPayment`).
 *
 * Boa Vista, 05/09/2026: o manual da unidade dizia, em negrito, "a vaga só é
 * reservada DEPOIS do pagamento confirmado" e "NÃO agende ainda". A Sofia leu,
 * concordou e marcou o Lindomar para 09/09 às 09:00 sem os R$ 100. Prompt não
 * segura o modelo nesse ponto; ferramenta recusando segura.
 *
 * Duas fontes valem como prova, nesta ordem:
 *  1. O cartão do Kommo diz que pagou — "✓ Consulta pg antecipado" marcado ou
 *     valor lançado (mesma regra que o follow-up usa para não cobrar quem pagou).
 *  2. Um comprovante foi LIDO nesta conversa: a leitura de imagem começa a
 *     transcrição com "COMPROVANTE:" quando reconhece um recibo, e o webhook
 *     guarda isso na mensagem do paciente como "[imagem do cliente]: COMPROVANTE: …".
 *
 * O paciente dizer "já paguei" NÃO é prova — é exatamente o caso que a regra
 * existe para barrar.
 */

/** "[imagem do cliente]: COMPROVANTE: R$ 100,00 …" — transcrição de recibo pela visão. */
export function ehTranscricaoDeComprovante(texto: string): boolean {
  return /\[imagem do cliente\]:\s*["'“]?\s*COMPROVANTE\b/i.test(texto);
}

export type ProvaDePagamento =
  | { ok: true; fonte: 'cartao' | 'comprovante' }
  | { ok: false; motivo: string };

export async function provaDePagamentoAntecipado(args: {
  unitId: string;
  leadId?: number | null;
  /** Sem cliente do Kommo (playground), só o comprovante na conversa vale. */
  kommo?: KommoClient | null;
  /** Comprovante mais velho que isso não conta (padrão 30 dias). */
  janelaDias?: number;
}): Promise<ProvaDePagamento> {
  const { unitId, leadId, kommo } = args;
  if (!leadId) return { ok: false, motivo: 'sem leadId — não dá para conferir o pagamento' };

  if (kommo) {
    try {
      const lead = await kommo.getLead(leadId);
      if (pagouOAntecipado(lead.custom_fields_values)) return { ok: true, fonte: 'cartao' };
    } catch (err) {
      logger.warn({ err: String(err), unitId, leadId }, 'prova de pagamento: não consegui ler o cartão no Kommo');
    }
  }

  const desde = new Date(Date.now() - (args.janelaDias ?? 30) * 86_400_000);
  const msgs = await prisma.message.findMany({
    where: {
      conversation: { unitId, leadId: String(leadId) },
      role: 'user',
      createdAt: { gte: desde },
      content: { contains: 'COMPROVANTE', mode: 'insensitive' },
    },
    select: { content: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  if (msgs.some((m) => ehTranscricaoDeComprovante(m.content))) return { ok: true, fonte: 'comprovante' };

  return {
    ok: false,
    motivo: 'nem comprovante lido nesta conversa nem campo de pagamento marcado no cartão',
  };
}
