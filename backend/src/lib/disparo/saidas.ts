/**
 * Quem respondeu SAIR depois de receber o disparo. Alimenta duas coisas: o freio (quantos) e a tela em que o João
 * decide se libera a onda de novo (quem, e o que escreveu). Só leitura.
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../prisma.js';
import { pedidosDeSaida } from './publico.js';
import { respostaParaTela } from './retomada.js';

/** Quantas pessoas da campanha, nesta unidade, RECEBERAM e responderam SAIR. Quem pediu antes de receber foi barrado sem envio e não entra. */
export const contarSairam = (campanhaId: string, unitId: string): Promise<number> =>
  prisma.disparoDestinatario.count({ where: { campanhaId, unitId, estado: 'saiu', enviadoEm: { not: null } } });

export interface QuemSaiu {
  /** só o primeiro nome (o que já ia na saudação) */
  nome: string;
  /** o que a pessoa escreveu, curto e sem número que pareça telefone */
  resposta: string;
  quando: Date | null;
}

/**
 * As pessoas da campanha, nesta unidade, que receberam e pediram para sair, com o que escreveram DEPOIS do envio.
 * Sem a mensagem gravada (a Sofia pausada, por exemplo) vem só o nome e a resposta fica vazia: a tela diz isso.
 */
export async function quemPediuSair(unit: Unit, campanhaId: string): Promise<QuemSaiu[]> {
  const linhas = await prisma.disparoDestinatario.findMany({
    where: { campanhaId, unitId: unit.id, estado: 'saiu', enviadoEm: { not: null } },
    orderBy: { atualizadoEm: 'asc' },
    select: { nome: true, kommoLeadId: true, enviadoEm: true },
  });
  const leadIds = linhas.map((l) => l.kommoLeadId).filter((n): n is number => n !== null);
  const desde = linhas.length ? new Date(Math.min(...linhas.map((l) => l.enviadoEm!.getTime()))) : undefined;
  const pedidos = desde ? await pedidosDeSaida(unit, leadIds, desde) : [];
  return linhas.map((l) => {
    // O pedido mais recente DEPOIS do envio dessa pessoa (o mesmo critério do varredor).
    const dela = pedidos.filter((p) => p.leadId === l.kommoLeadId && p.quando.getTime() >= l.enviadoEm!.getTime()).sort((a, b) => b.quando.getTime() - a.quando.getTime())[0];
    return { nome: l.nome, resposta: dela ? respostaParaTela(dela.texto) : '', quando: dela?.quando ?? null };
  });
}
