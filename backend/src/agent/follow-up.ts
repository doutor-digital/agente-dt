// ============================================================================
// follow-up.ts — Escreve a mensagem de reengajamento.
//
// POR QUE NÃO É TEXTO FIXO
// ------------------------
// Cinco mensagens prontas, disparadas em sequência, são reconhecíveis como
// robô na segunda. Pior: elas ignoram o que já foi conversado — mandar "quer
// agendar?" para quem já disse que o problema é o preço não reengaja ninguém.
//
// Então o modelo recebe a conversa real e uma INTENÇÃO ("toque leve, retome
// onde parou"), e escreve a partir do que aquele paciente disse. É o mesmo
// agente da conversa, com a mesma persona — não uma segunda voz.
//
// POR QUE UMA CHAMADA CURTA, E NÃO O AGENTE INTEIRO
// -------------------------------------------------
// Reengajar não precisa de ferramenta: não consulta agenda, não grava campo,
// não agenda nada. Rodar o grafo completo aqui gastaria passos e latência para
// produzir uma frase — e abriria a porta para a IA marcar consulta sozinha
// enquanto o paciente está calado, que é exatamente o que não pode acontecer.
// ============================================================================

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createChatModel, invokeChatModel } from '../services/openai.service.js';
import { composeSystemPromptForUnit } from './prompt-composer.js';

export interface FollowUpArgs {
  unitId: string;
  leadId: number;
  conversationId: string;
  /** O que este degrau da escada quer provocar. */
  intencao: string;
  /** No último, a mensagem se despede — não pede resposta. */
  ultimoDegrau: boolean;
}

/** Últimas trocas, na ordem em que aconteceram. */
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

  // A persona vem do mesmo composer da conversa: a voz precisa ser a mesma, ou
  // o paciente percebe que "outra pessoa" assumiu.
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
      // Mesmo cast que lead-memory.service usa: os tipos do LangChain divergem
      // entre ChatOpenAI e ChatAnthropic, e o helper aceita os dois em runtime.
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
    // Vazio ou absurdamente longo: melhor não mandar nada do que mandar lixo
    // para quem já está em silêncio.
    if (!limpo || limpo.length > 600) return null;
    return limpo;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: args.leadId }, 'follow-up: modelo falhou');
    return null;
  }
}
