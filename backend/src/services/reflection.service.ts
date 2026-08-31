import { ChatOpenAI } from '@langchain/openai';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resolveOpenAIApiKey } from './openai.service.js';
import { listLessons } from './lessons.service.js';

const REFLECT_MODEL = 'gpt-4o-mini';
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

export interface Sugestao {
  rule: string;
  why?: string;
  frase?: string;
  errado?: string;
  certo?: string;
}

/**
 * Junta a regra com a evidência num texto só — que é o que vai pro prompt.
 *
 * A regra sozinha ("Confirme o agendamento de forma clara") vira lembrete que o
 * modelo lê e não obedece. Com a frase real do paciente ao lado, ele reconhece
 * a situação quando ela reaparece. Foi a diferença entre as lições genéricas
 * que a reflexão vinha propondo e as que funcionaram nos testes.
 */
export function formatarLicao(s: Sugestao): string {
  let t = s.rule.trim();
  if (s.frase?.trim()) t += ` Paciente disse: "${s.frase.trim()}".`;
  if (s.errado?.trim()) t += ` ERRADO: ${s.errado.trim()}.`;
  if (s.certo?.trim()) t += ` CERTO: ${s.certo.trim()}.`;
  return t.replace(/\.\.+/g, '.').replace(/\s+/g, ' ').trim();
}

export function parseSuggestions(raw: string): Sugestao[] {
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
  const texto = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return arr
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.rule === 'string' && s.rule.trim().length > 0)
    .slice(0, 5)
    .map((s) => ({
      rule: String(s.rule).trim(),
      why: texto(s.why),
      frase: texto(s.frase),
      errado: texto(s.errado),
      certo: texto(s.certo),
    }));
}

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
    `às mensagens marcadas [MARCADA RUIM]. A partir dos padrões, proponha regras no imperativo, ` +
    `ESPECÍFICAS desta clínica, que evitariam esses erros no futuro.\n` +
    `CADA regra precisa vir com a EVIDÊNCIA da conversa, porque regra sem exemplo vira lembrete ` +
    `vago que a IA lê e não obedece:\n` +
    `- "frase": a frase do PACIENTE, copiada literalmente da conversa, no momento em que a IA ` +
    `errou. Copie palavra por palavra; não resuma nem corrija a escrita dele.\n` +
    `- "errado": o que a IA fez ali, em poucas palavras.\n` +
    `- "certo": o que ela deveria ter feito, concreto o bastante pra ser imitado.\n` +
    `Se você não achar a frase literal do paciente para uma regra, NÃO invente: deixe "frase" vazia.\n` +
    `Regras que JÁ existem (NÃO repita nem parafraseie): ` +
    `${existentes.length ? existentes.map((r) => `"${r}"`).join('; ') : '(nenhuma)'}\n` +
    `Se NÃO houver erro gritante, ainda assim proponha de 1 a 3 MELHORIAS de condução ` +
    `que aumentariam a chance de agendamento nesta clínica. Só retorne vazio se as ` +
    `conversas forem pouquíssimas ou sem conteúdo útil.\n` +
    `Responda SÓ JSON: {"suggestions":[{"rule":"<regra no imperativo>","why":"<1 frase do padrão>",` +
    `"frase":"<fala literal do paciente>","errado":"<o que a IA fez>","certo":"<o que fazer>"}]}. ` +
    `No máximo 5.`;

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
      data: { unitId: unit.id, content: formatarLicao(s), source: 'reflexao', enabled: false },
    });
    jaTem.add(key);
    proposed++;
  }

  logger.info({ unitId: unit.id, proposed, analisadas: comMensagens.length }, 'reflexão concluída');
  return { proposed, analisadas: comMensagens.length };
}
