// ============================================================================
// reflection.service.ts — o ciclo de reflexão ("dreaming").
//
// Relê as conversas recentes da unidade (dando peso às mensagens que o dono
// marcou como RUINS) e pede pra um modelo barato achar PADRÕES/ERROS que se
// repetem. Cada padrão vira uma SUGESTÃO de aprendizado (UnitLesson com
// source=reflexao, enabled=FALSE) — não muda nada sozinho: o dono aprova no
// painel ligando a regra. É o que faz a IA melhorar com a própria experiência.
// ============================================================================

import { ChatOpenAI } from '@langchain/openai';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resolveOpenAIApiKey } from './openai.service.js';
import { listLessons } from './lessons.service.js';

const REFLECT_MODEL = 'gpt-4o-mini'; // barato — é análise de padrões, não atendimento
const MAX_CONVERSATIONS = 12;
const MIN_CONVERSATIONS = 3;

export interface ReflectionResult {
  proposed: number;
  analisadas: number;
}

function vertical(unit: Unit): string {
  const c = unit.category?.trim();
  if (c === 'saude') return 'clínica de saúde';
  if (c === 'energia_solar') return 'empresa de energia solar';
  if (c === 'advocacia') return 'escritório de advocacia';
  return 'empresa';
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parser puro e defensivo do JSON do modelo. Testável isolado. */
export function parseSuggestions(raw: string): Array<{ rule: string; why?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const obj = parsed as { suggestions?: unknown };
  const arr = Array.isArray(obj?.suggestions)
    ? obj.suggestions
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];
  return arr
    .map((s) => s as { rule?: unknown; why?: unknown })
    .filter((s) => typeof s.rule === 'string' && s.rule.trim().length > 0)
    .slice(0, 5)
    .map((s) => ({
      rule: String(s.rule).trim(),
      why: typeof s.why === 'string' ? s.why : undefined,
    }));
}

/**
 * Roda a reflexão pra uma unidade. Retorna quantas sugestões novas criou.
 * Idempotente na prática: dedup contra as regras já existentes (normalizado).
 */
export async function runReflectionForUnit(unit: Unit): Promise<ReflectionResult> {
  const convs = await prisma.conversation.findMany({
    where: { unitId: unit.id },
    orderBy: { lastMessageAt: 'desc' },
    take: MAX_CONVERSATIONS,
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true, flagged: true },
      },
    },
  });

  const comMensagens = convs.filter((c) => c.messages.length >= 2);
  if (comMensagens.length < MIN_CONVERSATIONS) {
    logger.info({ unitId: unit.id, n: comMensagens.length }, 'reflexão: material insuficiente');
    return { proposed: 0, analisadas: comMensagens.length };
  }

  const transcripts = comMensagens
    .map((c, i) => {
      const linhas = c.messages
        .slice(-12)
        .map((m) => {
          const quem = m.role === 'assistant' ? 'IA' : 'Paciente';
          const flag = m.flagged ? ' [MARCADA RUIM]' : '';
          return `${quem}${flag}: ${m.content.slice(0, 300)}`;
        })
        .join('\n');
      return `### Conversa ${i + 1}\n${linhas}`;
    })
    .join('\n\n');

  const existentes = (await listLessons(unit.id)).map((l) => l.content);

  const system =
    `Você é um analista de qualidade de atendimento de uma ${vertical(unit)}. ` +
    `Releia as conversas reais abaixo e ache PADRÕES e ERROS que se REPETEM — momentos em que a IA ` +
    `perdeu o paciente, respondeu mal, ou poderia ter conduzido melhor pro agendamento. Dê peso extra ` +
    `às mensagens marcadas [MARCADA RUIM]. A partir dos padrões, proponha REGRAS curtas, no imperativo, ` +
    `ESPECÍFICAS desta clínica, que evitariam esses erros no futuro.\n` +
    `Regras que JÁ existem (NÃO repita nem parafraseie): ` +
    `${existentes.length ? existentes.map((r) => `"${r}"`).join('; ') : '(nenhuma)'}\n` +
    `Responda SÓ JSON: {"suggestions":[{"rule":"<regra curta no imperativo>","why":"<1 frase do padrão>"}]}. ` +
    `No máximo 5. Se não houver padrão claro, retorne {"suggestions":[]}.`;

  let raw = '';
  try {
    const model = new ChatOpenAI({
      apiKey: resolveOpenAIApiKey(unit),
      model: REFLECT_MODEL,
      temperature: 0.2,
      modelKwargs: { response_format: { type: 'json_object' } },
    });
    const res = await model.invoke([
      { role: 'system', content: system },
      { role: 'user', content: transcripts },
    ]);
    raw = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
  } catch (err) {
    logger.error({ err, unitId: unit.id }, 'reflexão: chamada ao modelo falhou');
    return { proposed: 0, analisadas: comMensagens.length };
  }

  const suggestions = parseSuggestions(raw);
  const jaTem = new Set(existentes.map(norm));
  let proposed = 0;
  for (const s of suggestions) {
    const key = norm(s.rule);
    if (!key || jaTem.has(key)) continue;
    await prisma.unitLesson.create({
      data: { unitId: unit.id, content: s.rule, source: 'reflexao', enabled: false },
    });
    jaTem.add(key);
    proposed++;
  }

  logger.info({ unitId: unit.id, proposed, analisadas: comMensagens.length }, 'reflexão concluída');
  return { proposed, analisadas: comMensagens.length };
}
