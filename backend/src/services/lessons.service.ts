import { prisma } from '../lib/prisma.js';

export interface LessonInput {
  content: string;
  source?: string;
  enabled?: boolean;
}

/** Quantas regras ligadas entram no prompt. */
export const MAX_LICOES_NO_PROMPT = 40;
/** Origem das regras escritas pela própria clínica (página /aprendizados e tela Agente do Chatwoot). Igual a `SOURCE_DA_UNIDADE`. */
const DA_UNIDADE = 'unidade';

const normalizada = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Quais regras ligadas entram no prompt (13/11/2026). As ESCRITAS PELA CLÍNICA entram sempre (a página limita a 25): antes, com as
 * regras automáticas da reflexão semanal passando de 40 (Parauapebas: 50), a regra que a equipe acabava de ensinar ficava fora do
 * prompt e a página recusava salvar. As demais completam as vagas, as mais antigas primeiro, como era. Texto repetido ocupa uma
 * vaga só — e, entre repetidas, fica a da clínica (senão a cópia automática, fora do teto, levava a da clínica junto). No prompt
 * ficam em ordem de criação.
 */
export function escolherLicoesDoPrompt<T extends { content: string; source: string; createdAt: Date }>(ligadas: readonly T[], max = MAX_LICOES_NO_PROMPT): T[] {
  const porData = [...ligadas].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  const vistos = new Set<string>();
  const unica = (l: T) => {
    const k = normalizada(l.content);
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  };
  // a da clínica primeiro na deduplicação: entre textos iguais, ela é a que fica
  const daUnidade = porData.filter((l) => l.source === DA_UNIDADE).filter(unica).slice(-max);
  const resto = porData.filter((l) => l.source !== DA_UNIDADE).filter(unica).slice(0, Math.max(0, max - daUnidade.length));
  const escolhidas = new Set<T>([...daUnidade, ...resto]);
  return porData.filter((l) => escolhidas.has(l));
}

export async function listEnabledLessons(unitId: string) {
  // duas leituras: as da clínica todas (são poucas) e as demais até um teto folgado — muitas automáticas não empurram as da clínica
  const [daUnidade, outras] = await Promise.all([
    prisma.unitLesson.findMany({ where: { unitId, enabled: true, source: DA_UNIDADE }, orderBy: { createdAt: 'asc' }, take: 200 }),
    prisma.unitLesson.findMany({ where: { unitId, enabled: true, NOT: { source: DA_UNIDADE } }, orderBy: { createdAt: 'asc' }, take: 300 }),
  ]);
  return escolherLicoesDoPrompt([...daUnidade, ...outras]);
}

export function listLessons(unitId: string) {
  return prisma.unitLesson.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export function createLesson(unitId: string, input: LessonInput) {
  return prisma.unitLesson.create({
    data: {
      unitId,
      content: input.content.trim(),
      source: input.source ?? 'manual',
      enabled: input.enabled ?? true,
    },
  });
}

export async function updateLesson(
  unitId: string,
  id: string,
  patch: Partial<LessonInput>,
): Promise<number> {
  const { count } = await prisma.unitLesson.updateMany({
    where: { id, unitId },
    data: {
      ...(patch.content !== undefined ? { content: patch.content.trim() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    },
  });
  return count;
}

export async function deleteLesson(unitId: string, id: string): Promise<number> {
  const { count } = await prisma.unitLesson.deleteMany({ where: { id, unitId } });
  return count;
}
