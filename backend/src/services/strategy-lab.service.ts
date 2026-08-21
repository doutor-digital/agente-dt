import type { Unit } from '@prisma/client';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createChatModel, invokeChatModel } from './openai.service.js';
import { aplicarGuardrail } from '../agent/guardrail.js';

export const ABORDAGENS = [
  {
    key: 'devolver_escolha',
    titulo: 'Devolver a escolha pra ele',
    brief:
      'Tire a pressão e devolva o controle: ofereça duas alternativas concretas e deixe ele escolher. ' +
      'Nada de "posso ajudar em algo?" — dê caminho, não pergunta aberta.',
  },
  {
    key: 'fechar_quando',
    titulo: 'Fechar o dia e a hora',
    brief:
      'Assuma que ele quer resolver e vá direto ao próximo passo concreto: proponha um dia/horário ' +
      'específico e peça só a confirmação. Curto e prático.',
  },
  {
    key: 'tirar_atrito',
    titulo: 'Tirar o que está travando',
    brief:
      'Vá no que provavelmente travou (valor, medo do procedimento, tempo, distância) e desarme com ' +
      'acolhimento e um fato concreto — sem empurrar o agendamento na mesma frase.',
  },
] as const;

export type AbordagemKey = (typeof ABORDAGENS)[number]['key'];

export interface Candidato {
  abordagem: AbordagemKey;
  titulo: string;
  texto: string;
  alertas: string[];
}

export function normalizaTexto(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function similaridade(a: string, b: string): number {
  const A = new Set(normalizaTexto(a).split(' ').filter(Boolean));
  const B = new Set(normalizaTexto(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function dedupCandidates(cands: Candidato[], limiar = 0.85): Candidato[] {
  const out: Candidato[] = [];
  for (const c of cands) {
    if (!c.texto.trim()) continue;
    if (out.some((j) => similaridade(j.texto, c.texto) >= limiar)) continue;
    out.push(c);
  }
  return out;
}

export function formatarHistorico(
  msgs: Array<{ role: string; content: string }>,
  max = 20,
): string {
  return msgs
    .slice(-max)
    .map((m) => `${m.role === 'assistant' ? 'Atendente' : 'Paciente'}: ${m.content.slice(0, 400)}`)
    .join('\n');
}

export interface StrategyLabResult {
  runId: string;
  candidatos: Candidato[];
  status: 'ok' | 'partial' | 'failed';
}

export async function runStrategyLab(args: {
  unit: Unit;
  conversationId: string;
  ownerNote?: string | null;
}): Promise<StrategyLabResult | null> {
  const { unit, conversationId, ownerNote } = args;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, unitId: unit.id },
    include: {
      messages: { orderBy: { createdAt: 'asc' }, take: 200, select: { role: true, content: true } },
    },
  });
  if (!conv) return null;

  const historico = formatarHistorico(conv.messages);
  const contexto = [
    `Nome do paciente: ${conv.contactName ?? 'não informado'}`,
    ownerNote?.trim() ? `Observação de quem pediu: ${ownerNote.trim()}` : '',
    '',
    'Conversa até aqui:',
    historico || '(sem histórico)',
  ]
    .filter(Boolean)
    .join('\n');

  const useAnthropic = unit.llmProvider === 'anthropic' && !!unit.anthropicApiKey;
  const useGoogle = unit.llmProvider === 'google' && !!unit.googleApiKey;
  const provider = useAnthropic ? 'anthropic' : useGoogle ? 'google' : 'openai';
  const modelName = useAnthropic
    ? unit.anthropicModel || 'claude-opus-4-8'
    : useGoogle
      ? unit.googleModel || 'gemini-2.5-flash'
      : unit.openaiModel || 'gpt-4o-mini';

  const model = createChatModel(unit, { model: modelName }) as unknown as Parameters<
    typeof invokeChatModel
  >[0]['model'];
  const resultados = await Promise.all(
    ABORDAGENS.map(async (ab): Promise<Candidato | null> => {
      const system =
        `Você escreve a PRÓXIMA mensagem de WhatsApp que a clínica vai mandar pra um paciente que ` +
        `travou na conversa. Escreva como a atendente humana escreveria: curta (no máximo 3 linhas), ` +
        `calorosa, sem jargão, sem emoji de rosto, sem repetir o que já foi dito.\n` +
        `ABORDAGEM DESTA VERSÃO — ${ab.titulo}: ${ab.brief}\n` +
        `Responda APENAS com o texto da mensagem, sem aspas e sem explicação.`;
      try {
        const res = (await invokeChatModel({
          model,
          messages: [new SystemMessage(system), new HumanMessage(contexto)],
          unitId: unit.id,
          traceId: null,
          modelName,
          provider,
        })) as { content?: unknown };
        const bruto = res?.content;
        const texto =
          typeof bruto === 'string'
            ? bruto.trim()
            : Array.isArray(bruto)
              ? bruto
                  .map((p) => (typeof p === 'object' && p && 'text' in p ? String(p.text) : ''))
                  .join('')
                  .trim()
              : '';
        if (!texto) return null;
        const g = aplicarGuardrail(texto, unit);
        return {
          abordagem: ab.key,
          titulo: ab.titulo,
          texto,
          alertas: g.triggered,
        } satisfies Candidato;
      } catch (err) {
        logger.warn({ err, abordagem: ab.key, conversationId }, 'strategy-lab: candidato falhou');
        return null;
      }
    }),
  );

  const candidatos = dedupCandidates(resultados.filter((c): c is Candidato => c !== null));
  const status: StrategyLabResult['status'] =
    candidatos.length === 0 ? 'failed' : candidatos.length < ABORDAGENS.length ? 'partial' : 'ok';

  const run = await prisma.leadStrategyRun.create({
    data: {
      unitId: unit.id,
      conversationId: conv.id,
      leadId: conv.leadId,
      ownerNote: ownerNote?.slice(0, 500) ?? null,
      candidates: candidatos as unknown as object,
      status,
    },
  });

  logger.info({ unitId: unit.id, conversationId, n: candidatos.length, status }, 'strategy-lab: rodada');
  return { runId: run.id, candidatos, status };
}

export async function marcarEscolha(unitId: string, runId: string, texto: string): Promise<boolean> {
  const { count } = await prisma.leadStrategyRun.updateMany({
    where: { id: runId, unitId },
    data: { chosenText: texto.slice(0, 4000), chosenAt: new Date() },
  });
  return count > 0;
}
