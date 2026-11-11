/**
 * Pausa do menu de suporte — o armazém de verdade (Prisma). A regra mora em `suporte-pausa.ts`; aqui só há I/O.
 * Uma linha só (`id = 'menu'`); sem linha = não pausado.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { SEM_PAUSA, type ArmazemPausa, type EstadoPausa } from './suporte-pausa.js';

const ID = 'menu';

type Linha = { pausado: boolean; pausadoEm: Date | null; pausadoPor: string | null; ignoradasNaPausa: number } | null;

function paraEstado(l: Linha): EstadoPausa {
  if (!l || !l.pausado) return SEM_PAUSA;
  return { pausado: true, desde: l.pausadoEm, por: l.pausadoPor, ignoradas: l.ignoradasNaPausa };
}

export const armazemPausaPrisma: ArmazemPausa = {
  async ler() {
    return paraEstado(await prisma.suporteControle.findUnique({ where: { id: ID } }));
  },

  async gravar({ pausado, por, quando }) {
    return prisma.$transaction(async (tx) => {
      const antes = paraEstado(await tx.suporteControle.findUnique({ where: { id: ID } }));
      // já estava assim: não mexe (pausar duas vezes não reinicia a hora nem zera a contagem; retomar sem pausa não cria linha)
      if (antes.pausado === pausado) return antes;
      await tx.suporteControle.upsert({
        where: { id: ID },
        create: { id: ID, pausado, pausadoEm: pausado ? quando : null, pausadoPor: pausado ? por : null, ignoradasNaPausa: 0 },
        update: { pausado, pausadoEm: pausado ? quando : null, pausadoPor: pausado ? por : null, ignoradasNaPausa: 0 },
      });
      return antes;
    });
  },
};

/**
 * O webhook do menu pergunta antes de cada mensagem. Se não conseguir ler (banco fora), responde "pausado": a chave existe
 * justamente para o João poder calar o bot, e na dúvida é melhor não responder do que responder contra a ordem dele
 * (sem banco o menu também não consegue gravar nada, então o custo é nenhum).
 */
export async function menuPausado(armazem: ArmazemPausa = armazemPausaPrisma): Promise<boolean> {
  try {
    return (await armazem.ler()).pausado;
  } catch (err) {
    logger.error({ err: String(err) }, 'suporte-pausa: não consegui ler a chave de pausa — tratando como pausado');
    return true;
  }
}

/** Conta uma mensagem que chegou durante a pausa e ficou sem resposta. Nunca lança. */
export async function contarIgnoradaNaPausa(): Promise<void> {
  try {
    await prisma.suporteControle.updateMany({ where: { id: ID, pausado: true }, data: { ignoradasNaPausa: { increment: 1 } } });
  } catch (err) {
    logger.warn({ err: String(err) }, 'suporte-pausa: não consegui contar a mensagem ignorada');
  }
}
