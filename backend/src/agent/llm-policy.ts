// ============================================================================
// llm-policy.ts — política de resiliência do nó da IA (timeout + fallback).
//
// O cliente do modelo (openai.service) já tem timeout por chamada + maxRetries
// no nível HTTP. O que faltava era o COMPORTAMENTO quando isso tudo esgota: hoje
// o erro sobe e o paciente fica no vácuo (conversa travada). Aqui centralizamos:
//
//   - `withTimeout` — backstop pra travamento infinito (o invoke que nunca volta).
//   - `FALLBACK_INDISPONIVEL` — a frase educada que vai no lugar do silêncio.
//
// O nó do grafo (graph.ts) envolve a chamada do modelo com isto e, na falha,
// entrega o fallback em vez de deixar o turno morrer. Complementa a RetryPolicy
// nativa do LangGraph (retry do nó) — que não sabe entregar uma mensagem de
// fallback, só relança.
// ============================================================================

// Backstop pro caso do invoke NUNCA voltar. Fica ACIMA do pior caso do cliente
// (timeout 15s × (1+maxRetries)) de propósito: não é pra cortar resposta lenta
// porém válida — é rede de segurança. Ajustável por env.
export const AGENT_NODE_TIMEOUT_MS = Number(process.env.AGENT_NODE_TIMEOUT_MS) || 35000;

// Mensagem quando a IA fica indisponível. Curta, humana, sem "erro de sistema".
export const FALLBACK_INDISPONIVEL =
  'Opa, tive uma instabilidade rapidinha aqui do meu lado 🙈 Pode mandar de novo? Já te respondo.';

// ---------------------------------------------------------------------------
// PLANO B (downgrade de provedor).
//
// Quando o modelo principal falha, mandar "tive uma instabilidade" é melhor que
// silêncio — mas pior que responder. As unidades quase sempre têm credencial de
// MAIS DE UM provedor, então antes de desistir vale tentar o outro.
//
// O caso real que motivou isto: a conta da OpenAI zerou e as unidades que
// atendiam por OpenAI ficaram mudas, mesmo tendo chave da Anthropic cadastrada.
// Falha de provedor é quase sempre RÁPIDA (429/401 voltam na hora), então o
// plano B custa pouco tempo justamente quando mais importa.
// ---------------------------------------------------------------------------

export interface PlanoB {
  provider: 'anthropic' | 'openai' | 'google';
  modelName: string;
}

interface UnitCreds {
  llmProvider: string | null;
  anthropicApiKey: string | null;
  anthropicModel: string | null;
  openaiApiKey: string | null;
  openaiModel: string | null;
  googleApiKey: string | null;
  googleModel: string | null;
}

/**
 * Escolhe o provedor alternativo com credencial disponível. `null` quando não
 * há alternativa — aí o fallback de texto segue sendo a resposta certa.
 *
 * `temChaveOpenAiNoAmbiente` entra separado porque a maioria das unidades não
 * tem chave própria de OpenAI e usa a do ambiente.
 */
export function escolherPlanoB(unit: UnitCreds, temChaveOpenAiNoAmbiente: boolean): PlanoB | null {
  const principal = unit.llmProvider ?? 'openai';

  const anthropicDisponivel = !!unit.anthropicApiKey;
  const openaiDisponivel = !!unit.openaiApiKey || temChaveOpenAiNoAmbiente;
  const googleDisponivel = !!unit.googleApiKey;

  // Ordem de preferência por provedor principal. Claude primeiro quando dá:
  // é o que atende a maioria das unidades hoje, então o tom sai parecido.
  if (principal === 'anthropic') {
    if (openaiDisponivel) return { provider: 'openai', modelName: unit.openaiModel || 'gpt-4o-mini' };
    if (googleDisponivel) return { provider: 'google', modelName: unit.googleModel || 'gemini-2.5-flash' };
    return null;
  }
  if (principal === 'google') {
    if (anthropicDisponivel) return { provider: 'anthropic', modelName: unit.anthropicModel || 'claude-opus-4-8' };
    if (openaiDisponivel) return { provider: 'openai', modelName: unit.openaiModel || 'gpt-4o-mini' };
    return null;
  }
  // principal = openai
  if (anthropicDisponivel) return { provider: 'anthropic', modelName: unit.anthropicModel || 'claude-opus-4-8' };
  if (googleDisponivel) return { provider: 'google', modelName: unit.googleModel || 'gemini-2.5-flash' };
  return null;
}

/**
 * Teto do plano B. Menor que o principal de propósito: o paciente já esperou o
 * primeiro falhar, e o objetivo é responder — não esgotar a paciência dele.
 */
export const PLANO_B_TIMEOUT_MS = Number(process.env.AGENT_FALLBACK_TIMEOUT_MS) || 20000;

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`IA não respondeu em ${ms}ms`);
    this.name = 'LlmTimeoutError';
  }
}

/** Corre a promessa contra um timeout. Rejeita com LlmTimeoutError se estourar. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmTimeoutError(ms)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}
