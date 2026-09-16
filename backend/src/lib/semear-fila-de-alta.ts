/**
 * Enche a fila da página `/alta/:slug` a partir do cruzamento com a franquia.
 *
 * Fica separado de quem calcula porque a origem vai mudar: hoje os candidatos
 * saem da varredura que roda sob demanda; na fase 2 eles virão do sincronizador
 * que roda de 15 em 15 minutos. O contrato aqui é o mesmo nos dois casos.
 *
 * Regra que evita a lista virar ruído: quem a recepção já decidiu NÃO volta,
 * a menos que o quadro clínico tenha mudado de verdade (nova sessão feita, ou
 * outra data de última sessão) — ver `assinaturaDoQuadro`.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import {
  assinaturaDoQuadro,
  devePendenciar,
  type CandidatoBruto,
  type EstadoDaFila,
} from './fila-de-alta.js';

export interface ResultadoSemeadura {
  novos: number;
  atualizados: number;
  reabertos: number;
  intocados: number;
}

export async function semearFilaDeAlta(
  unitId: string,
  candidatos: CandidatoBruto[],
): Promise<ResultadoSemeadura> {
  const out: ResultadoSemeadura = { novos: 0, atualizados: 0, reabertos: 0, intocados: 0 };

  for (const c of candidatos) {
    const atual = await prisma.altaCandidato.findUnique({
      where: { unitId_leadId_classe: { unitId, leadId: c.leadId, classe: c.classe } },
      select: { id: true, estado: true, assinatura: true },
    });

    const assinatura = assinaturaDoQuadro(c);
    const dados = {
      nome: c.nome,
      realizadas: c.realizadas,
      previstas: c.previstas,
      ultimaSessao: c.ultimaSessao ? new Date(c.ultimaSessao) : null,
      assinatura,
    };

    if (!atual) {
      await prisma.altaCandidato.create({
        data: { unitId, leadId: c.leadId, classe: c.classe, ...dados },
      });
      out.novos += 1;
      continue;
    }

    // `estado` vem do banco como texto solto; aqui ele volta ao tipo fechado
    const jaNaFila = { estado: atual.estado as EstadoDaFila, assinatura: atual.assinatura };
    if (!devePendenciar(c, jaNaFila)) {
      out.intocados += 1;
      continue;
    }

    const reabrindo = atual.estado !== 'pendente';
    await prisma.altaCandidato.update({
      where: { id: atual.id },
      data: {
        ...dados,
        estado: 'pendente',
        // a decisão anterior deixa de valer: o quadro mudou
        ...(reabrindo ? { decididoPor: null, decididoEm: null } : {}),
      },
    });
    if (reabrindo) out.reabertos += 1;
    else out.atualizados += 1;
  }

  logger.info({ unitId, ...out, total: candidatos.length }, 'fila de alta semeada');
  return out;
}
