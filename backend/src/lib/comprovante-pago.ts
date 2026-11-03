/**
 * Só a pergunta da régua de cobrança: este cartão pagou a taxa por comprovante? Arquivo à parte para o `follow-up-worker` não puxar o módulo de
 * leitura de anexos (visão, conversa oficial).
 */
import { prisma } from './prisma.js';

/**
 * Este cartão tem consulta marcada pela Sofia com um comprovante de Pix aceito, de hoje em diante (fuso da unidade)? A régua de cobrança de Pix
 * a usa para não cobrar quem acabou de pagar, antes de a equipe conferir o extrato e marcar «✓ Consulta pg antecipado». Basta a data da consulta
 * (`consulta_em`): o id da consulta na franquia (`id_schedule`) pode faltar se a franquia não o devolveu ou o vínculo falhou, e quem pagou não
 * pode voltar a ser cobrado por isso. Erro de banco = não (na dúvida cobra, que é o comportamento de antes).
 */
export async function temConsultaPagaPorComprovante(
  db: Pick<typeof prisma, 'comprovantePixUsado'>,
  unitId: string,
  leadId: number,
  fuso: string,
  agora: Date = new Date(),
): Promise<boolean> {
  try {
    const hoje = agora.toLocaleDateString('sv-SE', { timeZone: fuso });
    const r = await db.comprovantePixUsado.findFirst({ where: { unitId, kommoLeadId: leadId, consultaEm: { gte: hoje } }, select: { id: true } });
    return r !== null;
  } catch {
    return false;
  }
}
