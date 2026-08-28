import type { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { mascararPii } from '../lib/pii.js';

/**
 * Histórico dos fatos do paciente: um evento por mudança, nunca sobrescrito.
 *
 * `LeadMemory.facts` continua sendo a foto do agora — é o que a IA lê na
 * conversa, e não muda. O que faltava era o filme: quando cada fato foi
 * aprendido, de que frase saiu, e o que ele substituiu.
 *
 * Isso não é registro por registro. Sem ele, três perguntas não têm resposta:
 *
 *   "Por que este lead está Desqualificado?" — hoje ninguém sabe. Um erro de
 *   extração vira decisão comercial permanente, em silêncio, e o paciente é
 *   tratado como perdido para sempre.
 *
 *   "Este dado é de quando?" — memória de três meses atrás e de ontem hoje
 *   pesam igual na conversa.
 *
 *   "O que mudou?" — o paciente que era Frio e virou Quente é a informação mais
 *   valiosa do dia, e é justamente a que se apagava.
 *
 * SÓ GRAVA MUDANÇA. Rodar de novo com os mesmos fatos não escreve nada — o
 * updater roda a cada poucos turnos e a maior parte deles não muda nada.
 */

/** Evidência mais longa que isto vira ruído; o que importa é a frase, não a conversa. */
const EVIDENCIA_MAX = 400;

/**
 * Fatos que a IA reescreve sozinha a cada ciclo e que não representam mudança
 * de entendimento sobre o paciente. Guardar histórico deles encheria a tabela
 * de linhas sem informação.
 */
const RUIDO = new Set(['ultimo_contato']);

export interface MudancaDeFato {
  chave: string;
  valor: string;
  valorAnterior: string | null;
}

/** Normaliza para comparar: o LLM alterna aspas, espaço e caixa sem querer dizer nada. */
function comparavel(v: unknown): string {
  return String(v ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * O que mudou entre a memória antiga e a nova.
 *
 * Chave que sumiu NÃO vira evento: o prompt manda a IA "remover chaves
 * obsoletas", então sumiço é quase sempre faxina dela, não o paciente
 * desdizendo. Tratar como mudança encheria o histórico de ruído.
 */
export function diferenca(
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
): MudancaDeFato[] {
  const saida: MudancaDeFato[] = [];
  for (const [chave, bruto] of Object.entries(depois ?? {})) {
    if (RUIDO.has(chave)) continue;
    const valor = comparavel(bruto);
    if (!valor) continue;
    const anterior = comparavel((antes ?? {})[chave]);
    if (anterior === valor) continue;
    saida.push({ chave, valor, valorAnterior: anterior || null });
  }
  return saida;
}

/** Recorta a evidência e tira dado pessoal — o histórico é auditoria, não cadastro. */
export function prepararEvidencia(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const limpo = mascararPii(texto).replace(/\s+/g, ' ').trim();
  return limpo ? limpo.slice(0, EVIDENCIA_MAX) : null;
}

/**
 * Grava as mudanças, cada uma apontando para o evento que substitui.
 *
 * Roda solto e engole o próprio erro: histórico é para investigar depois, e
 * nunca vale derrubar a atualização da memória — muito menos a conversa.
 */
export async function registrarMudancas(args: {
  unitId: string;
  leadId: string;
  antes: Record<string, unknown>;
  depois: Record<string, unknown>;
  evidencia?: string | null;
}): Promise<number> {
  const mudancas = diferenca(args.antes, args.depois);
  if (mudancas.length === 0) return 0;

  const evidencia = prepararEvidencia(args.evidencia);

  try {
    // Busca o último evento de cada chave para encadear o SUPERSEDES. Uma
    // consulta só: fazer uma por chave seria N idas ao banco por ciclo.
    const anteriores = await prisma.leadFactEvent.findMany({
      where: {
        unitId: args.unitId,
        leadId: args.leadId,
        chave: { in: mudancas.map((m) => m.chave) },
      },
      orderBy: { observadoEm: 'desc' },
      select: { id: true, chave: true },
    });
    const ultimoDaChave = new Map<string, string>();
    for (const a of anteriores) {
      if (!ultimoDaChave.has(a.chave)) ultimoDaChave.set(a.chave, a.id);
    }

    await prisma.leadFactEvent.createMany({
      data: mudancas.map((m) => ({
        unitId: args.unitId,
        leadId: args.leadId,
        chave: m.chave,
        valor: m.valor,
        valorAnterior: m.valorAnterior,
        evidencia,
        supersedesId: ultimoDaChave.get(m.chave) ?? null,
      })) as Prisma.LeadFactEventCreateManyInput[],
    });
    return mudancas.length;
  } catch (err) {
    logger.warn(
      { err: String(err), leadId: args.leadId, mudancas: mudancas.length },
      'histórico de fatos: falhou ao gravar (a memória do lead segue normal)',
    );
    return 0;
  }
}

/** A linha do tempo de um fato, do mais novo para o mais antigo. */
export async function historicoDoFato(
  unitId: string,
  leadId: string,
  chave: string,
): Promise<Array<{ valor: string; valorAnterior: string | null; observadoEm: Date; evidencia: string | null }>> {
  return prisma.leadFactEvent.findMany({
    where: { unitId, leadId, chave },
    orderBy: { observadoEm: 'desc' },
    select: { valor: true, valorAnterior: true, observadoEm: true, evidencia: true },
    take: 20,
  });
}
