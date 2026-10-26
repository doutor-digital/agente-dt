/**
 * Quando uma montagem de onda é dada como morta. Pura (sem banco), para o teste ler a regra.
 *
 * Montar leva minutos e, numa unidade grande, passa de meia hora só por estar andando devagar (Kommo + franquia, pessoa
 * por pessoa). Cancelar aos 30 min de idade, como era, matava montagem VIVA. Agora quem está montando dá uma batida a cada
 * minuto (`atualizadoEm`); morta é a que parou de bater há 30 min (o processo caiu no deploy). Uma batida não prova que
 * está andando, então há também um teto de idade para a que ficou presa batendo para sempre.
 */
export const BATIDA_DA_MONTAGEM_MS = 60_000;
export const MONTAGEM_SEM_BATIDA_MS = 30 * 60_000;
export const MONTAGEM_TETO_MS = 6 * 3_600_000;

export function montagemMorta(o: { criadoEm: Date; atualizadoEm: Date }, agora: number): 'sem-batida' | 'passou-do-teto' | null {
  if (agora - o.criadoEm.getTime() > MONTAGEM_TETO_MS) return 'passou-do-teto';
  if (agora - o.atualizadoEm.getTime() > MONTAGEM_SEM_BATIDA_MS) return 'sem-batida';
  return null;
}

/** O mesmo critério como filtro do banco (`OR`). */
export function filtroDeMontagemMorta(agora: number) {
  return { estado: 'montando', OR: [{ atualizadoEm: { lt: new Date(agora - MONTAGEM_SEM_BATIDA_MS) } }, { criadoEm: { lt: new Date(agora - MONTAGEM_TETO_MS) } }] };
}
