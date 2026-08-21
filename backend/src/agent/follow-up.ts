import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createChatModel, invokeChatModel } from '../services/openai.service.js';
import { composeSystemPromptForUnit } from './prompt-composer.js';

export interface FollowUpArgs {
  unitId: string;
  leadId: number;
  conversationId: string;
  intencao: string;
  ultimoDegrau: boolean;
}

async function historico(conversationId: string, limite = 12): Promise<string> {
  const msgs = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limite,
    select: { role: true, content: true },
  });
  return msgs
    .reverse()
    .map((m) => `${m.role === 'user' ? 'PACIENTE' : 'VOCÊ'}: ${m.content}`)
    .join('\n');
}

export async function runAgentFollowUp(args: FollowUpArgs): Promise<string | null> {
  const unit = await prisma.unit.findUnique({ where: { id: args.unitId } });
  if (!unit) return null;

  const conversa = await historico(args.conversationId);
  if (!conversa.trim()) return null;

  const persona = await composeSystemPromptForUnit({ unit, isFirstTurn: false }).catch(() => null);
  const base = typeof persona === 'string' ? persona : '';

  const instrucao = `
VOCÊ ESTÁ RETOMANDO UMA CONVERSA QUE PAROU. O paciente não respondeu sua última
mensagem. Escreva UMA mensagem curta de reengajamento.

O QUE ESTA MENSAGEM PRECISA FAZER:
${args.intencao}

REGRAS:
- UMA mensagem só, curta. Duas ou três linhas no máximo.
- NÃO se reapresente e NÃO recomece a conversa. Ele já sabe quem você é.
- NÃO repita literalmente o que você já disse — ele leu e não respondeu.
- NÃO cobre resposta ("você sumiu", "ainda está aí?"). Cobrança afasta.
- NÃO invente horário, preço, endereço nem disponibilidade. Se precisar falar de
  horário, fale no geral e ofereça verificar.
- Retome pelo que ELE contou: a queixa, a preferência, o que ficou pendente.
${args.ultimoDegrau ? '- ESTA É A ÚLTIMA. Despeça-se com a porta aberta e NÃO faça pergunta.' : ''}

Responda APENAS com o texto da mensagem, sem aspas e sem explicação.

CONVERSA ATÉ AGORA:
${conversa}`.trim();

  try {
    const model = createChatModel(unit, { maxTokens: 300 });
    const saida = await invokeChatModel({
      model: model as unknown as Parameters<typeof invokeChatModel>[0]['model'],
      messages: [new SystemMessage(base || 'Você é uma atendente de clínica.'), new HumanMessage(instrucao)],
      unitId: unit.id,
      traceId: null,
      modelName: unit.openaiModel ?? 'gpt-4o-mini',
      provider: unit.llmProvider ?? 'openai',
    });

    const bruto = (saida as { content?: unknown })?.content;
    const texto = typeof bruto === 'string' ? bruto : Array.isArray(bruto)
      ? bruto.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('')
      : '';

    const limpo = texto.trim().replace(/^["']|["']$/g, '');
    if (!limpo || limpo.length > 600) return null;
    return limpo;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: args.leadId }, 'follow-up: modelo falhou');
    return null;
  }
}
