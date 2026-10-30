/**
 * O registro de "esta pausa foi da automação `pausa-equipe`" — a única forma de a Sofia saber, uma hora
 * depois, que pode devolver o cartão sem pisar numa pausa que é de gente.
 *
 * Por que uma tabela: a caixinha "Pausar IA" é a mesma para a SDR, para o widget (pausa com data), para o
 * `pausar_ia` da própria Sofia e para esta automação; nada no cartão diz quem marcou. A marca em memória de
 * pausa-propria.ts vive só um turno. Então a automação anota aqui, no instante em que ela mesma grava o
 * campo ("marcou"), e só linhas abertas desta tabela são candidatas a voltar sozinhas (pausa-equipe-volta.ts).
 *
 * Nunca lança: perder o registro só custa a volta automática daquele cartão (fica pausado até alguém
 * desmarcar, o comportamento de antes) — nunca derruba a pausa em si.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export type DesfechoDaPausa = 'voltou' | 'devolvida_por_gente' | 'mexida_por_gente' | 'vencida';

/** Grava (ou reabre) a pausa que a Sofia acabou de marcar porque a equipe falou. Chamar DEPOIS do Kommo confirmar. */
export async function registrarPausaDaEquipe(
  unit: { id: string; slug: string },
  leadId: number,
  fala: { em: Date; autorNome: string },
  pausadoEm: Date = new Date(),
): Promise<void> {
  try {
    const dados = { pausadoEm, falaEm: fala.em, falaAutor: fala.autorNome.trim() || null, encerradaEm: null, desfecho: null };
    await prisma.pausaDaEquipe.upsert({
      where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: leadId } },
      create: { unitId: unit.id, kommoLeadId: leadId, ...dados },
      update: dados,
    });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe: não registrei a pausa (este cartão não volta sozinho)');
  }
}

/** As pausas abertas, com a unidade (para o estado da chave e o token do Kommo), das mais velhas para as novas. */
export async function pausasAbertas(limite = 2000) {
  return prisma.pausaDaEquipe.findMany({
    where: { encerradaEm: null, unit: { isActive: true } },
    include: { unit: true },
    orderBy: { pausadoEm: 'asc' },
    take: limite,
  });
}

export type PausaAberta = Awaited<ReturnType<typeof pausasAbertas>>[number];

export async function encerrarPausaDaEquipe(id: string, desfecho: DesfechoDaPausa): Promise<void> {
  await prisma.pausaDaEquipe.update({ where: { id }, data: { encerradaEm: new Date(), desfecho } });
}
