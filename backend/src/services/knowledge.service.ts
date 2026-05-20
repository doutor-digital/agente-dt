// ============================================================================
// knowledge.service.ts — CRUD + busca semântica da base de conhecimento.
//
// LÓGICA DE ENGENHARIA
// --------------------
// - Cada entry tem pergunta + resposta. Embeddamos o TEXTO COMBINADO
//   "pergunta. resposta" pra capturar contexto melhor na busca.
// - Busca semântica é in-memory: carrega TODOS os entries da Unit,
//   calcula cosine similarity contra o query embedding, retorna top-K.
//   Escala bem até ~10K entries; acima disso, migrar pra pgvector.
// ============================================================================

import type { KnowledgeBaseEntry, Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { cosineSim, embedTexts } from './embeddings.service.js';

export interface KnowledgeInput {
  question: string;
  answer: string;
}

function embedText(input: KnowledgeInput): string {
  return `${input.question.trim()}\n${input.answer.trim()}`;
}

export async function listKnowledge(unitId: string): Promise<KnowledgeBaseEntry[]> {
  return prisma.knowledgeBaseEntry.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createKnowledge(
  unit: Pick<Unit, 'id' | 'openaiApiKey'>,
  input: KnowledgeInput,
): Promise<KnowledgeBaseEntry> {
  const text = embedText(input);
  const { vectors } = await embedTexts({ unit, texts: [text] });
  return prisma.knowledgeBaseEntry.create({
    data: {
      unitId: unit.id,
      question: input.question,
      answer: input.answer,
      embedding: vectors[0] ?? [],
    },
  });
}

export async function updateKnowledge(
  unit: Pick<Unit, 'id' | 'openaiApiKey'>,
  id: string,
  input: Partial<KnowledgeInput>,
): Promise<KnowledgeBaseEntry> {
  const existing = await prisma.knowledgeBaseEntry.findFirst({
    where: { id, unitId: unit.id },
  });
  if (!existing) throw new Error('entry_not_found');

  const merged: KnowledgeInput = {
    question: input.question ?? existing.question,
    answer: input.answer ?? existing.answer,
  };
  // Reembedar só se pergunta ou resposta mudou (pra economizar API call).
  let embedding = existing.embedding;
  if (input.question !== undefined || input.answer !== undefined) {
    const { vectors } = await embedTexts({ unit, texts: [embedText(merged)] });
    embedding = vectors[0] ?? [];
  }
  return prisma.knowledgeBaseEntry.update({
    where: { id },
    data: { question: merged.question, answer: merged.answer, embedding },
  });
}

export async function deleteKnowledge(unitId: string, id: string): Promise<void> {
  await prisma.knowledgeBaseEntry.delete({ where: { id, unitId } });
}

/**
 * Busca semântica: dado um texto de query (mensagem do cliente), retorna
 * as `topK` entradas mais similares. Filtra entradas com sim abaixo de
 * `minScore` (default 0.2) pra evitar matches irrelevantes.
 */
export async function searchKnowledge(
  unit: Pick<Unit, 'id' | 'openaiApiKey'>,
  query: string,
  opts: { topK?: number; minScore?: number } = {},
): Promise<Array<KnowledgeBaseEntry & { score: number }>> {
  const topK = opts.topK ?? 3;
  const minScore = opts.minScore ?? 0.2;

  const all = await prisma.knowledgeBaseEntry.findMany({ where: { unitId: unit.id } });
  if (all.length === 0) return [];

  const { vectors } = await embedTexts({ unit, texts: [query] });
  const queryVec = vectors[0];
  if (!queryVec) return [];

  const scored = all
    .map((e) => ({ ...e, score: cosineSim(queryVec, e.embedding) }))
    .filter((e) => e.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}
