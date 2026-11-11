/**
 * Pausa do menu de suporte — o armazém de verdade (Prisma). A regra mora em `suporte-pausa.ts`; aqui só há I/O.
 * Uma linha só (`id = 'menu'`); sem linha = não pausado.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { enviarTelegramChamados } from './telegram.js';
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
    // a linha única nasce aqui (ON CONFLICT DO NOTHING: comando e botão ao mesmo tempo não brigam pelo INSERT)...
    await prisma.suporteControle.createMany({ data: [{ id: ID }], skipDuplicates: true });
    return prisma.$transaction(async (tx) => {
      // ...e quem chega depois espera aqui (FOR UPDATE), então "ler o anterior e trocar" é atômico
      const [linha] = await tx.$queryRaw<
        Array<{ pausado: boolean; pausado_em: Date | null; pausado_por: string | null; ignoradas_na_pausa: number }>
      >`SELECT pausado, pausado_em, pausado_por, ignoradas_na_pausa FROM suporte_controle WHERE id = ${ID} FOR UPDATE`;
      const antes = paraEstado(
        linha ? { pausado: linha.pausado, pausadoEm: linha.pausado_em, pausadoPor: linha.pausado_por, ignoradasNaPausa: linha.ignoradas_na_pausa } : null,
      );
      // já estava assim: não mexe (pausar duas vezes não reinicia a hora nem zera a contagem)
      if (antes.pausado === pausado) return antes;
      await tx.suporteControle.update({
        where: { id: ID },
        data: { pausado, pausadoEm: pausado ? quando : null, pausadoPor: pausado ? por : null, ignoradasNaPausa: 0 },
      });
      return antes;
    });
  },
};

/**
 * O webhook do menu pergunta antes de cada mensagem. Se não conseguir ler (banco fora), responde "pausado": a chave existe
 * justamente para o João poder calar o bot, e na dúvida é melhor não responder do que responder contra a ordem dele
 * (sem banco o menu também não consegue gravar nada). Como calar em silêncio é o pior caso, a falha vai para o log (erro) E para o
 * Telegram do João, no máximo uma vez por hora. A tabela é criada pela migration, que roda no start do contêiner antes do node.
 */
export async function menuPausado(armazem: ArmazemPausa = armazemPausaPrisma, avisar: (texto: string) => Promise<boolean> = enviarTelegramChamados): Promise<boolean> {
  try {
    return (await armazem.ler()).pausado;
  } catch (err) {
    logger.error({ err: String(err) }, 'suporte-pausa: não consegui ler a chave de pausa — tratando como pausado');
    // não pode calar o menu em silêncio: avisa o João, no máximo uma vez por hora
    const agora = Date.now();
    if (agora - ultimoAvisoDeFalha > 60 * 60_000) {
      ultimoAvisoDeFalha = agora;
      void avisar('⚠️ Menu de suporte: não consegui ler a chave de pausa no banco. Na dúvida o menu NÃO está respondendo. Veja o log do servidor.');
    }
    return true;
  }
}

let ultimoAvisoDeFalha = 0;
export function _zerarAvisoDeFalhaParaTeste(): void {
  ultimoAvisoDeFalha = 0;
}

/** Conta uma mensagem que chegou durante a pausa e ficou sem resposta. Nunca lança. */
export async function contarIgnoradaNaPausa(): Promise<void> {
  try {
    await prisma.suporteControle.updateMany({ where: { id: ID, pausado: true }, data: { ignoradasNaPausa: { increment: 1 } } });
  } catch (err) {
    logger.warn({ err: String(err) }, 'suporte-pausa: não consegui contar a mensagem ignorada');
  }
}
