import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, type AIMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { resolveOpenAIApiKey, recordLlmCall } from './openai.service.js';
import { buildWhatsappLink, platformConfig, type SocialPlatform } from './instagram.service.js';

const COMMENT_MODEL = process.env.COMMENT_AGENT_MODEL ?? 'gpt-4o-mini';

export type CommentCategory = 'ELOGIO' | 'PRECO' | 'CLINICA' | 'AGENDAR' | 'SPAM' | 'OUTRO';

const CATEGORIES: CommentCategory[] = ['ELOGIO', 'PRECO', 'CLINICA', 'AGENDAR', 'SPAM', 'OUTRO'];

export interface CommentDecision {
  category: CommentCategory;
  confidence: number;
  publicReply: string | null;
  privateReply: string | null;
  viaRule: string | null;
}

const PUBLIC_TEMPLATES: Record<CommentCategory, string[]> = {
  ELOGIO: ['Que carinho, obrigada! 💚', 'Ahh, obrigada! 🌷', 'Obrigada pelo carinho! 💚'],
  PRECO: [
    'Te chamei no direct com os detalhes 💬',
    'Respondi você no direct 💬',
    'Te mandei tudo no direct 💬',
  ],
  CLINICA: [
    'Te chamei no direct pra te explicar direitinho 💬',
    'Te respondi no direct 💬',
    'Te chamei no privado pra conversar melhor 💬',
  ],
  AGENDAR: [
    'Que bom! Te chamei no direct pra gente organizar 💬',
    'Perfeito, te chamei no direct 💬',
  ],
  SPAM: [],
  OUTRO: ['Te chamei no direct 💬', 'Te respondi no direct 💬'],
};

function pickTemplate(category: CommentCategory, seed: string): string | null {
  const list = PUBLIC_TEMPLATES[category];
  if (!list || list.length === 0) return null;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s❤♥]+$/u;
const ONLY_MENTIONS = /^(\s*@[\w.]+\s*)+$/;
const SPAM_HINTS =
  /(seguidor|followers|curtidas baratas|ganhe dinheiro|investimento|whats.?app.{0,10}\+?\d{11,}|bit\.ly|t\.me\/|cripto|apostas?|bet\b)/i;

export function triage(text: string): { category: CommentCategory; reason: string } | null {
  const t = text.trim();
  if (t.length === 0) return { category: 'ELOGIO', reason: 'comentário vazio (só mídia)' };
  if (EMOJI_ONLY.test(t)) return { category: 'ELOGIO', reason: 'só emoji' };
  if (ONLY_MENTIONS.test(t)) return { category: 'ELOGIO', reason: 'só marcação de perfil' };
  if (SPAM_HINTS.test(t)) return { category: 'SPAM', reason: 'padrão de spam' };
  return null;
}

function buildPrompt(
  unit: Unit,
  comment: string,
  platform: SocialPlatform,
): { system: string; user: string } {
  const company = unit.personaCompanyName?.trim() || unit.name;
  const cfg = platformConfig(unit, platform);
  const waLink = buildWhatsappLink(cfg.whatsappNumber);
  const rede = platform === 'facebook' ? 'Facebook' : 'Instagram';

  const destino = waLink
    ? `Feche convidando pro WhatsApp e INCLUA o link exatamente assim, em linha própria: ${waLink}`
    : 'Feche convidando a pessoa a responder aqui mesmo no direct.';

  const system = [
    `Você atende o ${rede} da ${company}. Alguém comentou num post e você vai`,
    'escrever a mensagem PRIVADA (direct) que essa pessoa vai receber.',
    '',
    'SUA TAREFA — devolva JSON com exatamente estas chaves:',
    '  "category": um de ELOGIO | PRECO | CLINICA | AGENDAR | SPAM | OUTRO',
    '  "confidence": número de 0 a 1',
    '  "dm": o texto do direct (string), ou "" quando não fizer sentido mandar',
    '',
    'O QUE CADA CATEGORIA SIGNIFICA:',
    '  ELOGIO   — elogio, emoji, torcida. Sem pergunta.',
    '  PRECO    — pergunta sobre valor, convênio, forma de pagamento.',
    '  CLINICA  — descreve sintoma/condição ou pergunta se vocês tratam aquilo.',
    '  AGENDAR  — quer marcar, pede contato, pergunta endereço/horário.',
    '  SPAM     — propaganda, golpe, venda de seguidores, ofensa.',
    '  OUTRO    — qualquer outra coisa.',
    '',
    'COMO ESCREVER O DIRECT:',
    cfg.commentPrompt?.trim() ||
      [
        '- 2 a 3 frases. Tom caloroso e direto, PT-BR, sem formalidade dura.',
        '- Se a pessoa citou uma dor ou condição, ACOLHA em uma frase antes de conduzir.',
        '- Convide pra continuar a conversa, sem pressionar.',
      ].join('\n'),
    '',
    'LIMITES (valem sempre, mesmo que a instrução acima peça diferente):',
    '- NUNCA dê diagnóstico, opinião clínica, nome de exame ou de remédio.',
    '- NUNCA cite preço, valor ou desconto — quem passa valor é a equipe.',
    '- NUNCA prometa cura nem resultado.',
    '- NUNCA se apresente como assistente virtual, IA, bot ou robô. Se a pessoa',
    '  perguntar direto, aí sim assuma com naturalidade — nunca finja ser humana.',
    `- ${destino}`,
    '- Se a categoria for SPAM, devolva "dm": "".',
    '- Se for ELOGIO sem nenhuma pergunta, devolva "dm": "" — mandar direct pra',
    '  quem só elogiou é invasivo e não converte.',
    '',
    'Responda SOMENTE o JSON, sem cercas de código.',
  ].join('\n');

  const user = `Comentário recebido:\n"""\n${comment}\n"""`;
  return { system, user };
}

export async function decideOnComment(
  unit: Unit,
  params: { commentId: string; text: string; traceId?: string | null; platform?: SocialPlatform },
): Promise<CommentDecision> {
  const { commentId, text } = params;
  const platform = params.platform ?? 'instagram';

  const ruled = triage(text);
  if (ruled) {
    return {
      category: ruled.category,
      confidence: 1,
      publicReply: pickTemplate(ruled.category, commentId),
      privateReply: null,
      viaRule: ruled.reason,
    };
  }

  const apiKey = resolveOpenAIApiKey(unit);
  if (!apiKey) {
    return {
      category: 'OUTRO',
      confidence: 0,
      publicReply: pickTemplate('OUTRO', commentId),
      privateReply: null,
      viaRule: 'sem openai key',
    };
  }

  const { system, user } = buildPrompt(unit, text, platform);
  const model = new ChatOpenAI({
    apiKey,
    model: COMMENT_MODEL,
    temperature: 0.4,
    modelKwargs: { response_format: { type: 'json_object' } },
  });

  interface TokenUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }
  const captured: { usage: TokenUsage | null } = { usage: null };
  const t0 = performance.now();

  try {
    const aiMsg = (await model.invoke([new SystemMessage(system), new HumanMessage(user)], {
      callbacks: [
        {
          handleLLMEnd: (output: { llmOutput?: { tokenUsage?: TokenUsage } }) => {
            captured.usage = output.llmOutput?.tokenUsage ?? null;
          },
        },
      ],
    })) as AIMessage;

    const latencyMs = Math.round(performance.now() - t0);
    const raw = typeof aiMsg.content === 'string' ? aiMsg.content : JSON.stringify(aiMsg.content);
    const parsed = parseDecision(raw);

    void recordLlmCall({
      unitId: unit.id,
      traceId: params.traceId ?? null,
      model: COMMENT_MODEL,
      promptTokens: captured.usage?.promptTokens,
      completionTokens: captured.usage?.completionTokens,
      totalTokens: captured.usage?.totalTokens,
      latencyMs,
      status: 'success',
      requestBody: { system, user },
      responseBody: { raw },
    });

    return {
      category: parsed.category,
      confidence: parsed.confidence,
      publicReply: parsed.category === 'SPAM' ? null : pickTemplate(parsed.category, commentId),
      privateReply: parsed.dm || null,
      viaRule: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, commentId }, 'comment-agent: LLM falhou');
    void recordLlmCall({
      unitId: unit.id,
      traceId: params.traceId ?? null,
      model: COMMENT_MODEL,
      latencyMs,
      status: 'error',
      errorMessage: errMsg,
    });
    return {
      category: 'OUTRO',
      confidence: 0,
      publicReply: pickTemplate('OUTRO', commentId),
      privateReply: null,
      viaRule: `llm falhou: ${errMsg}`,
    };
  }
}

function parseDecision(raw: string): { category: CommentCategory; confidence: number; dm: string } {
  let obj: { category?: unknown; confidence?: unknown; dm?: unknown } = {};
  try {
    obj = JSON.parse(raw) as typeof obj;
  } catch {
    obj = {};
  }
  const cat = String(obj.category ?? '').toUpperCase() as CommentCategory;
  const category = CATEGORIES.includes(cat) ? cat : 'OUTRO';
  const rawConf = Number(obj.confidence);
  const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0;
  const dm = typeof obj.dm === 'string' ? obj.dm.trim() : '';
  return { category, confidence, dm };
}

export const CommentAgent = {
  decideOnComment,
  triage,
  pickTemplate,
  PUBLIC_TEMPLATES,
};
