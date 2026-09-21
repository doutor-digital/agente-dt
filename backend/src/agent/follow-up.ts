import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createChatModel, invokeChatModel, resolveModelName } from '../services/openai.service.js';
import { composeFollowUpSystemPrompt } from './prompt-composer.js';
import { extrairBotoes } from '../lib/botoes.js';
import { aplicarGuardrail } from './guardrail.js';
import { cortarSeEstourou } from './teto-mensal.js';

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

  let base = '';
  try {
    base = composeFollowUpSystemPrompt(unit);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'follow-up: persona indisponível, usando genérica');
  }

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
- PROIBIDO deixar lacuna: nada de "[chave]", "R$ [valor]", "{endereço}", "XXX".
  Ou você escreve o dado exato que está nas Fontes Oficiais, ou não fala dele.
- Retome pelo que ELE contou: a queixa, a preferência, o que ficou pendente.
${args.ultimoDegrau ? '- ESTA É A ÚLTIMA. Despeça-se com a porta aberta e NÃO faça pergunta.' : ''}

Responda APENAS com o texto da mensagem, sem aspas e sem explicação.

CONVERSA ATÉ AGORA:
${conversa}`.trim();

  // Conta no teto do mês (TETO_MENSAL_ACAO=pausar) não gasta nem com a régua — e já entra em pausa
  // aqui, sem esperar uma mensagem chegar ao agente; na próxima varredura o worker pula a unidade.
  if (await cortarSeEstourou(unit)) {
    logger.warn({ unit: unit.slug, leadId: args.leadId }, 'follow-up: conta no teto do mês — degrau não gerado');
    return null;
  }

  try {
    const model = createChatModel(unit, { maxTokens: 300 });
    const saida = await invokeChatModel({
      model: model as unknown as Parameters<typeof invokeChatModel>[0]['model'],
      messages: [new SystemMessage(base || 'Você é uma atendente de clínica.'), new HumanMessage(instrucao)],
      unitId: unit.id,
      traceId: null,
      modelName: resolveModelName(unit),
      provider: unit.llmProvider ?? 'openai',
    });

    const bruto = (saida as { content?: unknown })?.content;
    const texto = typeof bruto === 'string' ? bruto : Array.isArray(bruto)
      ? bruto.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('')
      : '';

    // A régua sai pelo Salesbot, sem botões: a linha [[botoes: …]] da regra global
    // vazou como texto em Taubaté (12/09/2026). Aqui ela só é removida.
    const limpo = extrairBotoes(texto).texto.replace(/^["']|["']$/g, '');
    if (!limpo || limpo.length > 600) return null;

    // A régua não passava pelo guardrail: ia do modelo direto pro Kommo, sem
    // checagem de preço nem de lacuna. Aqui ela passa — e com uma diferença do
    // caminho da conversa: quando o guardrail precisa RECUSAR (preço fora do
    // catálogo, lacuna que não deu pra preencher, regra clínica), a régua
    // simplesmente não sai. Mensagem de reengajamento que diz "deixa eu
    // confirmar" não reengaja ninguém — é melhor o silêncio e o próximo degrau.
    const guard = aplicarGuardrail(limpo, unit);
    const recusou = guard.triggered.some((t) => /^(lacuna|preco|clinico):/.test(t));
    if (recusou) {
      logger.warn(
        { unit: unit.slug, leadId: args.leadId, motivos: guard.triggered, texto: limpo },
        'follow-up: guardrail barrou o degrau — nada enviado',
      );
      return null;
    }
    return guard.rewritten ? guard.text : limpo;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: args.leadId }, 'follow-up: modelo falhou');
    return null;
  }
}
