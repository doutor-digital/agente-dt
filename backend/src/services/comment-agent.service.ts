// ============================================================================
// comment-agent.service.ts — O agente que lê um comentário e decide o que fazer.
//
// LÓGICA DE ENGENHARIA
// --------------------
// DIVISÃO DELIBERADA DE RESPONSABILIDADE:
//
//   Resposta PÚBLICA  → template fixo por categoria. SEM LLM.
//   Resposta PRIVADA  → escrita pela LLM.
//
// Não é economia de token, é gestão de risco. O comentário fica visível pra
// sempre, pra todo mundo, e uma clínica não pode confirmar em público que
// alguém tem hérnia — isso é dado de saúde, e o comentarista não consentiu com
// nada. Texto gerado é ótimo até o dia em que não é; em público, o dia ruim
// custa caro. No DM o mesmo texto é privado, consentido e conversível.
//
// Por isso a LLM aqui NUNCA escreve o que vai pro feed. Ela faz duas coisas:
// classifica o comentário e redige o DM.
//
// TRIAGEM ANTES DA LLM
// --------------------
// Comentário de Instagram é volume alto e valor unitário baixo: "❤️", "😍",
// marcar uma amiga. Rodar LLM nisso é queimar dinheiro pra chegar num template
// que a gente já sabia. `triage()` resolve esses casos por regra e só o que
// sobra vira chamada paga.
// ============================================================================

import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, type AIMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { resolveOpenAIApiKey, recordLlmCall } from './openai.service.js';
import { buildWhatsappLink } from './instagram.service.js';

const COMMENT_MODEL = process.env.COMMENT_AGENT_MODEL ?? 'gpt-4o-mini';

export type CommentCategory = 'ELOGIO' | 'PRECO' | 'CLINICA' | 'AGENDAR' | 'SPAM' | 'OUTRO';

const CATEGORIES: CommentCategory[] = ['ELOGIO', 'PRECO', 'CLINICA', 'AGENDAR', 'SPAM', 'OUTRO'];

export interface CommentDecision {
  category: CommentCategory;
  confidence: number;
  /** Texto pro comentário público. `null` = não responder em público. */
  publicReply: string | null;
  /** Texto do DM. `null` = não mandar DM (spam, elogio puro). */
  privateReply: string | null;
  /** Preenchido quando a decisão saiu de regra, sem LLM. */
  viaRule: string | null;
}

// ---------------------------------------------------------------------------
// Respostas públicas — templates.
// ---------------------------------------------------------------------------
// Várias por categoria porque o perfil inteiro fica visível numa tela só: dez
// comentários respondidos com a MESMA frase denunciam automação mais rápido
// que qualquer outra coisa. A escolha é determinística pelo id do comentário
// (não aleatória) pra que reprocessar o mesmo comentário dê o mesmo texto.
//
// Nenhum template menciona sintoma, condição, tratamento ou preço. Essa
// restrição é o motivo de eles existirem.

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

// ---------------------------------------------------------------------------
// Triagem por regra — antes de gastar LLM.
// ---------------------------------------------------------------------------

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s❤♥]+$/u;
const ONLY_MENTIONS = /^(\s*@[\w.]+\s*)+$/;
const SPAM_HINTS =
  /(seguidor|followers|curtidas baratas|ganhe dinheiro|investimento|whats.?app.{0,10}\+?\d{11,}|bit\.ly|t\.me\/|cripto|apostas?|bet\b)/i;

/**
 * Decide sem LLM quando dá. `null` = precisa da LLM.
 */
export function triage(text: string): { category: CommentCategory; reason: string } | null {
  const t = text.trim();
  if (t.length === 0) return { category: 'ELOGIO', reason: 'comentário vazio (só mídia)' };
  if (EMOJI_ONLY.test(t)) return { category: 'ELOGIO', reason: 'só emoji' };
  // Marcar amiga é engajamento, mas não é pergunta: DM aqui é invasivo — a
  // pessoa marcada não interagiu com a gente, quem interagiu foi outra.
  if (ONLY_MENTIONS.test(t)) return { category: 'ELOGIO', reason: 'só marcação de perfil' };
  if (SPAM_HINTS.test(t)) return { category: 'SPAM', reason: 'padrão de spam' };
  return null;
}

// ---------------------------------------------------------------------------
// O prompt do agente.
// ---------------------------------------------------------------------------

function buildPrompt(unit: Unit, comment: string): { system: string; user: string } {
  const company = unit.personaCompanyName?.trim() || unit.name;
  const waLink = buildWhatsappLink(unit.igWhatsappNumber);

  const destino = waLink
    ? `Feche convidando pro WhatsApp e INCLUA o link exatamente assim, em linha própria: ${waLink}`
    : 'Feche convidando a pessoa a responder aqui mesmo no direct.';

  const system = [
    `Você atende o Instagram da ${company}. Alguém comentou num post e você vai`,
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
    'REGRAS DO DIRECT (todas obrigatórias):',
    '- 2 a 3 frases. Tom caloroso e direto, PT-BR, sem formalidade dura.',
    '- NUNCA dê diagnóstico, opinião clínica, nome de exame ou de remédio.',
    '- NUNCA cite preço, valor ou desconto — quem passa valor é a equipe.',
    '- NUNCA prometa cura nem resultado.',
    '- NUNCA se apresente como assistente virtual, IA, bot ou robô. Se a pessoa',
    '  perguntar direto, aí sim assuma com naturalidade — nunca finja ser humana.',
    '- Se a pessoa citou uma dor ou condição, ACOLHA em uma frase antes de conduzir.',
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

// ---------------------------------------------------------------------------
// Entrada principal.
// ---------------------------------------------------------------------------

export async function decideOnComment(
  unit: Unit,
  params: { commentId: string; text: string; traceId?: string | null },
): Promise<CommentDecision> {
  const { commentId, text } = params;

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
    // Sem chave, ainda dá pra responder em público com o template neutro —
    // melhor do que silêncio, e não arrisca nada.
    return {
      category: 'OUTRO',
      confidence: 0,
      publicReply: pickTemplate('OUTRO', commentId),
      privateReply: null,
      viaRule: 'sem openai key',
    };
  }

  const { system, user } = buildPrompt(unit, text);
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
    // Degrada pro template neutro: a pessoa recebe uma resposta pública que
    // não erra, e ninguém fica sem retorno porque a LLM caiu.
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
